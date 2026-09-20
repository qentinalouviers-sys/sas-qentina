import type { SupabaseClient } from '@supabase/supabase-js';
import { runInvoiceOcr, type OcrFile, type OcrProvider } from '@/lib/ai/invoice-ocr';
import {
  uploadInvoiceFile, findDuplicateInvoice, saveInvoice, updateIngredientPrices,
  linkBankTransaction, createCcaMovementForInvoice,
} from '@/lib/invoices';
import { checkInvoice, type InvoiceAnomaly } from '@/lib/invoice-checks';
import { normalizeExtracted, type ExtractedInvoiceData } from '@/lib/invoice-normalize';

/**
 * scanner.ts — Les deux étapes du Scanner, sans HTTP.
 *
 * L'écran (routes /api/scanner et /api/scanner/confirm) et les agents IA
 * (outils analyze_invoice_document et register_invoice) passent par ces deux
 * fonctions. Un seul chemin d'entrée pour une facture, quel que soit
 * l'appelant : mêmes lectures, mêmes contrôles, mêmes verrous.
 */

const rnd2 = (v: number) => Math.round(Number(v) * 100) / 100;

export interface BankCandidate {
  id: string; date: string; description: string; amount: number; status: string; category: string | null;
  score: number; amount_diff: number; date_diff: number;
}

export interface AnalyzedInvoice {
  extracted: ExtractedInvoiceData;
  anomalies: InvoiceAnomaly[];
  ocr_engine: { provider: OcrProvider; model: string; control: OcrProvider | null };
  file_url: string | null;
  is_duplicate: boolean;
  bank_candidates: BankCandidate[];
  match_confidence: 'high' | 'medium' | 'low' | 'none';
}

/** Mouvements bancaires en attente dont le montant et la date approchent ceux de la facture, scorés. */
export async function findBankCandidates(
  supabase: SupabaseClient,
  extracted: Pick<ExtractedInvoiceData, 'total_ttc' | 'date'>,
): Promise<BankCandidate[]> {
  if (!extracted.total_ttc || !extracted.date) return [];
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

  const out: BankCandidate[] = [];
  for (const c of candidates || []) {
    const amtDiff = Math.abs(Math.abs(Number(c.amount)) - Math.abs(targetAmt));
    const dDiff = Math.abs(new Date(c.date).getTime() - d.getTime()) / 86_400_000;
    // Score 0–100 : montant ×0.7 + date ×0.3
    const amtScore = Math.max(0, 100 - (amtDiff / Math.max(Math.abs(targetAmt), 1)) * 500);
    const dScore = Math.max(0, 100 - dDiff * 8);
    out.push({ ...c, score: Math.round(amtScore * 0.7 + dScore * 0.3), amount_diff: rnd2(amtDiff), date_diff: Math.round(dDiff) });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function matchConfidenceOf(candidates: readonly BankCandidate[]): AnalyzedInvoice['match_confidence'] {
  if (candidates.length === 0) return 'none';
  const top = candidates[0].score;
  return top >= 85 ? 'high' : top >= 55 ? 'medium' : 'low';
}

/**
 * Étape 1 : lecture (double), doublon, pièce jointe, candidats bancaires.
 * N'écrit rien dans la comptabilité — le fichier est déposé dans Storage,
 * c'est la pièce justificative de la facture à venir.
 */
export async function analyzeInvoiceFiles(
  supabase: SupabaseClient,
  files: OcrFile[],
  filename: string | null | undefined,
  today = new Date().toISOString().slice(0, 10),
): Promise<AnalyzedInvoice> {
  const outcome = await runInvoiceOcr(files);
  const extracted = outcome.extracted;
  extracted.doublon = await findDuplicateInvoice(supabase, extracted);

  let fileUrl: string | null = null;
  if (files.length > 1) {
    const urls = await Promise.all(files.map((f, idx) => uploadInvoiceFile(supabase, f.fileBase64, f.mimeType, `${idx}_${filename || 'scan'}`)));
    const valid = urls.filter(Boolean);
    if (valid.length > 0) fileUrl = JSON.stringify(valid);
  } else {
    fileUrl = await uploadInvoiceFile(supabase, files[0].fileBase64, files[0].mimeType, filename);
  }

  const candidates = await findBankCandidates(supabase, extracted);

  return {
    extracted,
    anomalies: checkInvoice(extracted, today),
    ocr_engine: { ...outcome.engine, control: outcome.controlEngine },
    file_url: fileUrl,
    is_duplicate: !!extracted.doublon,
    bank_candidates: candidates,
    match_confidence: matchConfidenceOf(candidates),
  };
}

export interface RegisterInvoiceInput {
  extracted: unknown;
  /** Lecture OCR initiale, avant correction, pour la trace. */
  ocrOriginal?: unknown;
  ocrEngine?: { provider?: string; model?: string; control?: string | null } | null;
  fileUrl?: string | null;
  bankTxId?: string | null;
  paymentMethod?: string;
  paymentNotes?: string | null;
  associe?: string | null;
  confirmations?: readonly string[];
  today?: string;
}

export interface RegisteredInvoice {
  invoiceId: string;
  accountingRef: string;
  reconciled: boolean;
  mercuriale: { updated: number; unmatched: string[] };
}

/**
 * Étape 2 : enregistrement après relecture. Re-normalise, refait la
 * recherche de doublon, recompte les anomalies et refuse (InvoiceValidationError)
 * tout ce qui n'a pas été acquitté. Puis facture + lignes, mercuriale,
 * mouvement de compte courant si payé en perso, lettrage bancaire.
 */
export async function registerInvoice(supabase: SupabaseClient, input: RegisterInvoiceInput): Promise<RegisteredInvoice> {
  const extracted = normalizeExtracted(input.extracted);
  extracted.doublon = await findDuplicateInvoice(supabase, extracted);

  const paymentMethod = input.paymentMethod || 'bank';
  const saved = await saveInvoice(supabase, extracted, {
    fileUrl: input.fileUrl ?? null,
    paymentMethod,
    paymentNotes: input.paymentNotes ?? null,
    confirmations: input.confirmations ?? [],
    today: input.today,
    ocr: {
      original: input.ocrOriginal ? normalizeExtracted(input.ocrOriginal) : null,
      engine: input.ocrEngine && input.ocrEngine.provider
        ? { provider: String(input.ocrEngine.provider), model: String(input.ocrEngine.model ?? '') }
        : null,
      controlEngine: input.ocrEngine?.control ? String(input.ocrEngine.control) : null,
    },
  });

  const mercuriale = extracted.lignes?.length
    ? await updateIngredientPrices(supabase, extracted.lignes)
    : { updated: 0, unmatched: [] };

  if ((paymentMethod === 'card_perso' || paymentMethod === 'cash') && input.associe) {
    await createCcaMovementForInvoice(supabase, saved.id, extracted, input.associe, paymentMethod, input.fileUrl ?? null);
  }

  if (input.bankTxId) {
    await linkBankTransaction(supabase, input.bankTxId, saved.id, extracted.compte_comptable);
  }

  return { invoiceId: saved.id, accountingRef: saved.accountingRef, reconciled: !!input.bankTxId, mercuriale };
}
