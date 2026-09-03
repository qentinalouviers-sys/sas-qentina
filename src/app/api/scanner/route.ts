import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { runInvoiceOcr, describeOcrEngine, type OcrFile } from '@/lib/ai/invoice-ocr';
import { uploadInvoiceFile } from '@/lib/invoices';
import { checkInvoice } from '@/lib/invoice-checks';

const rnd2 = (v: number) => Math.round(Number(v) * 100) / 100;

// L'OCR d'une facture de plusieurs pages dépasse largement le délai par défaut
// d'une fonction Vercel. L'appel Gemini n'est pas streamé : sans ce réglage,
// une grosse facture se solde par un 504 avant toute réponse.
export const maxDuration = 60;

/**
 * Scanner IA — étape 1 : OCR + détection de doublons + candidats bancaires.
 * N'enregistre RIEN : l'utilisateur vérifie puis confirme via /api/scanner/confirm.
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

    // ── 1. OCR (une ou plusieurs pages) ────────────────────────────────────
    const ocrFiles: OcrFile[] =
      files && Array.isArray(files) && files.length > 0
        ? files
        : [{ fileBase64, mimeType }];

    let extracted;
    try {
      extracted = await runInvoiceOcr(ocrFiles);
    } catch (e: any) {
      return NextResponse.json({ error: e.message || 'Erreur OCR' }, { status: 500 });
    }

    // ── 2. Détection de doublons ───────────────────────────────────────────
    let isDuplicate = false;
    let duplicateInvoice: any = null;

    // Par numéro de facture
    if (extracted.numero_facture) {
      const { data: byNum } = await supabase
        .from('invoices')
        .select('id, invoice_number, date, total_ttc, accounting_ref, suppliers(name)')
        .eq('invoice_number', extracted.numero_facture)
        .limit(1);
      if (byNum && byNum.length > 0) {
        isDuplicate = true;
        duplicateInvoice = byNum[0];
      }
    }

    // Par date + montant TTC (tickets sans numéro)
    if (!isDuplicate && extracted.total_ttc && extracted.date) {
      const ttc = rnd2(extracted.total_ttc);
      const { data: byAmt } = await supabase
        .from('invoices')
        .select('id, invoice_number, date, total_ttc, accounting_ref, suppliers(name)')
        .eq('date', extracted.date)
        .gte('total_ttc', ttc - 0.5)
        .lte('total_ttc', ttc + 0.5)
        .limit(1);
      if (byAmt && byAmt.length > 0) {
        isDuplicate = true;
        duplicateInvoice = byAmt[0];
      }
    }

    // ── 3. Upload fichier(s) dans Supabase Storage ─────────────────────────
    let fileUrl: string | null = null;
    if (!isDuplicate) {
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
    }

    // ── 4. Candidats de rapprochement bancaire (scorés) ────────────────────
    const bankCandidates: any[] = [];
    if (!isDuplicate && extracted.total_ttc && extracted.date) {
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
      bankCandidates.sort((a, b) => b.score - a.score);
    }

    const matchConfidence: 'high' | 'medium' | 'low' | 'none' =
      bankCandidates.length === 0      ? 'none'
      : bankCandidates[0].score >= 85  ? 'high'
      : bankCandidates[0].score >= 55  ? 'medium'
      :                                  'low';

    return NextResponse.json({
      success: true,
      extracted,
      // Ce que l'humain devra regarder avant de confirmer. Le serveur les
      // recalcule à la confirmation : cette liste sert à l'affichage, pas à
      // la décision.
      anomalies: checkInvoice(extracted, new Date().toISOString().slice(0, 10)),
      // Moteur ayant réellement produit la lecture : indispensable pour
      // comparer Gemini et Claude sur les mêmes factures.
      ocr_engine: await describeOcrEngine(),
      file_url: fileUrl,
      is_duplicate: isDuplicate,
      duplicate_invoice: duplicateInvoice,
      bank_candidates: bankCandidates,
      match_confidence: matchConfidence,
    });
  } catch (err) {
    console.error('Scanner error:', err);
    return NextResponse.json({ error: 'Erreur scanner IA' }, { status: 500 });
  }
}
