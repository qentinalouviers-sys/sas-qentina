import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import {
  saveInvoice,
  updateIngredientPrices,
  linkBankTransaction,
  createCcaMovementForInvoice,
  findDuplicateInvoice,
} from '@/lib/invoices';
import { InvoiceValidationError } from '@/lib/invoice-checks';
import { normalizeExtracted } from '@/lib/invoice-normalize';

/**
 * Scanner IA — étape 2 : enregistrement après relecture et correction par
 * l'utilisateur. Crée la facture + lignes, le mouvement CCA si payé en perso,
 * et lie la transaction bancaire choisie.
 *
 * `extracted` : la facture telle que l'humain l'a validée (corrections
 * comprises). `ocr_original` : ce que l'OCR avait lu, pour la trace.
 * `confirmations` : codes des anomalies que l'utilisateur a cochées « vérifié ».
 *
 * Le serveur ne reprend rien de l'écran sans le refaire : il re-normalise les
 * montants, recherche lui-même un doublon, recalcule les anomalies et refuse
 * (422) tout ce qui n'a pas été acquitté — l'écran peut être contourné, pas
 * cette route.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const {
      extracted: extractedInput,
      ocr_original,
      ocr_engine,
      file_url,
      bank_tx_id,
      payment_method = 'bank',
      payment_notes,
      associe,
      confirmations = [],
    } = await req.json();

    if (!extractedInput) {
      return NextResponse.json({ error: 'Données extraites manquantes' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    const extracted = normalizeExtracted(extractedInput);
    // Le doublon est recherché ici, pas repris de l'écran : une facture
    // enregistrée entre la lecture et la confirmation serait sinon invisible.
    extracted.doublon = await findDuplicateInvoice(supabase, extracted);

    // 1. Facture + lignes
    const saved = await saveInvoice(supabase, extracted, {
      fileUrl: file_url,
      paymentMethod: payment_method,
      paymentNotes: payment_notes,
      confirmations: Array.isArray(confirmations) ? confirmations.map(String) : [],
      ocr: {
        original: ocr_original ?? null,
        engine: ocr_engine && typeof ocr_engine === 'object'
          ? { provider: String(ocr_engine.provider ?? ''), model: String(ocr_engine.model ?? '') }
          : null,
        controlEngine: ocr_engine?.control ? String(ocr_engine.control) : null,
      },
    });

    // 2. Mise à jour de la mercuriale (prix des ingrédients)
    if (extracted.lignes?.length) {
      await updateIngredientPrices(supabase, extracted.lignes);
    }

    // 3. Mouvement CCA si payé avec l'argent personnel d'un associé
    if ((payment_method === 'card_perso' || payment_method === 'cash') && associe) {
      await createCcaMovementForInvoice(supabase, saved.id, extracted, associe, payment_method, file_url);
    }

    // 4. Lien avec la transaction bancaire choisie
    if (bank_tx_id) {
      await linkBankTransaction(supabase, bank_tx_id, saved.id, extracted.compte_comptable);
    }

    return NextResponse.json({
      success: true,
      invoice_id: saved.id,
      accounting_ref: saved.accountingRef,
      reconciled: !!bank_tx_id,
    });
  } catch (err: unknown) {
    if (err instanceof InvoiceValidationError) {
      return NextResponse.json(
        { error: err.message, anomalies: err.anomalies },
        { status: 422 }
      );
    }
    console.error('Scanner confirm error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erreur confirmation scanner' }, { status: 500 });
  }
}
