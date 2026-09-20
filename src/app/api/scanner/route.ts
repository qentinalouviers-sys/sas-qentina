import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { runInvoiceOcr, type OcrFile } from '@/lib/ai/invoice-ocr';
import { uploadInvoiceFile, findDuplicateInvoice } from '@/lib/invoices';
import { checkInvoice } from '@/lib/invoice-checks';

const rnd2 = (v: number) => Math.round(Number(v) * 100) / 100;

// L'OCR d'une facture de plusieurs pages dépasse largement le délai par défaut
// d'une fonction Vercel. L'appel Gemini n'est pas streamé : sans ce réglage,
// une grosse facture se solde par un 504 avant toute réponse.
export const maxDuration = 60;

/**
 * Scanner IA — étape 1 : OCR (double lecture) + détection de doublons +
 * candidats bancaires. N'enregistre RIEN : l'utilisateur relit, corrige, puis
 * confirme via /api/scanner/confirm.
 *
 * Un doublon probable n'est plus un cul-de-sac : il devient un point à
 * confirmer, avec la facture existante affichée. L'ancienne détection
 * (numéro seul, tous fournisseurs confondus) refusait de vraies factures.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { fileBase64, mimeType, filename, files } = await req.json();
    if ((!fileBase64 || !mimeType) && (!files || files.length === 0)) {
      return NextResponse.json({ error: 'Fichier requis (fileBase64 + mimeType ou files)' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // ── 1. OCR (une ou plusieurs pages), lecture principale + contrôle ─────
    const ocrFiles: OcrFile[] =
      files && Array.isArray(files) && files.length > 0
        ? files
        : [{ fileBase64, mimeType }];

    let outcome;
    try {
      outcome = await runInvoiceOcr(ocrFiles);
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur OCR' }, { status: 500 });
    }
    const extracted = outcome.extracted;

    // ── 2. Doublon probable → point à confirmer, pas un refus ──────────────
    extracted.doublon = await findDuplicateInvoice(supabase, extracted);

    // ── 3. Upload fichier(s) dans Supabase Storage ─────────────────────────
    // Toujours, doublon ou non : le fichier est la pièce justificative.
    let fileUrl: string | null = null;
    if (files && Array.isArray(files) && files.length > 0) {
      const urls = await Promise.all(
        files.map((f: OcrFile, idx: number) =>
          uploadInvoiceFile(supabase, f.fileBase64, f.mimeType, `${idx}_${filename || 'scan'}`)
        )
      );
      const validUrls = urls.filter(Boolean);
      if (validUrls.length > 0) fileUrl = JSON.stringify(validUrls);
    } else {
      fileUrl = await uploadInvoiceFile(supabase, fileBase64, mimeType, filename);
    }

    // ── 4. Candidats de rapprochement bancaire (scorés) ────────────────────
    const bankCandidates: Record<string, unknown>[] = [];
    if (extracted.total_ttc && extracted.date) {
      const targetAmt = -Math.abs(rnd2(Number(extracted.total_ttc)));
      const d = new Date(extracted.date);
      const dMin = new Date(d); dMin.setDate(d.getDate() - 10);
      const dMax = new Date(d); dMax.setDate(d.getDate() + 10);

      const { data: candidates } = await supabase
        .from('bank_transactions')
        .select('id, date, description, amount, status, category')
        .in('status', ['pending_invoice', 'facture_ok'])
        .gte('amount', targetAmt - 2.0)
        .lte('amount', targetAmt + 2.0)
        .gte('date', dMin.toISOString().split('T')[0])
        .lte('date', dMax.toISOString().split('T')[0])
        .order('date', { ascending: false })
        .limit(5);

      for (const c of candidates || []) {
        const amtDiff = Math.abs(Math.abs(Number(c.amount)) - Math.abs(targetAmt));
        const dDiff = Math.abs(new Date(c.date).getTime() - d.getTime()) / 86_400_000;
        // Score 0–100 : montant ×0.7 + date ×0.3
        const amtScore = Math.max(0, 100 - (amtDiff / Math.max(Math.abs(targetAmt), 1)) * 500);
        const dScore = Math.max(0, 100 - dDiff * 8);
        bankCandidates.push({
          ...c,
          score: Math.round(amtScore * 0.7 + dScore * 0.3),
          amount_diff: rnd2(amtDiff),
          date_diff: Math.round(dDiff),
        });
      }
      bankCandidates.sort((a, b) => (b.score as number) - (a.score as number));
    }

    const topScore = bankCandidates.length > 0 ? (bankCandidates[0].score as number) : -1;
    const matchConfidence: 'high' | 'medium' | 'low' | 'none' =
      bankCandidates.length === 0 ? 'none'
      : topScore >= 85 ? 'high'
      : topScore >= 55 ? 'medium'
      : 'low';

    return NextResponse.json({
      success: true,
      extracted,
      // Ce que l'humain devra regarder avant de confirmer. L'écran les
      // recalcule à chaque correction, et le serveur à la confirmation :
      // cette liste sert à l'affichage initial, pas à la décision.
      anomalies: checkInvoice(extracted, new Date().toISOString().slice(0, 10)),
      // Moteur ayant réellement produit la lecture, et celui du contrôle :
      // indispensable pour comparer Gemini et Claude sur les mêmes factures.
      ocr_engine: { ...outcome.engine, control: outcome.controlEngine },
      file_url: fileUrl,
      is_duplicate: !!extracted.doublon,
      duplicate_invoice: extracted.doublon,
      bank_candidates: bankCandidates,
      match_confidence: matchConfidence,
    });
  } catch (err) {
    console.error('Scanner error:', err);
    return NextResponse.json({ error: 'Erreur scanner IA' }, { status: 500 });
  }
}
