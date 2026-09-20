import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { InvoiceValidationError } from '@/lib/invoice-checks';
import { registerInvoice } from '@/lib/scanner';

/**
 * Scanner IA — étape 2 : enregistrement après relecture et correction par
 * l'utilisateur. La logique (re-normalisation, doublon, anomalies, facture +
 * lignes, mercuriale, compte courant, lettrage) vit dans lib/scanner.ts et
 * sert aussi à l'outil d'agent register_invoice.
 *
 * `confirmations` : codes des anomalies que l'utilisateur a cochées « vérifié ».
 * Le serveur recalcule et refuse (422) tout ce qui n'a pas été acquitté —
 * l'écran peut être contourné, pas cette route.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const {
      extracted, ocr_original, ocr_engine, file_url, bank_tx_id,
      payment_method = 'bank', payment_notes, associe, confirmations = [],
    } = await req.json();

    if (!extracted) {
      return NextResponse.json({ error: 'Données extraites manquantes' }, { status: 400 });
    }

    const saved = await registerInvoice(createServiceRoleClient(), {
      extracted,
      ocrOriginal: ocr_original ?? null,
      ocrEngine: ocr_engine && typeof ocr_engine === 'object' ? ocr_engine : null,
      fileUrl: file_url ?? null,
      bankTxId: bank_tx_id ?? null,
      paymentMethod: payment_method,
      paymentNotes: payment_notes ?? null,
      associe: associe ?? null,
      confirmations: Array.isArray(confirmations) ? confirmations.map(String) : [],
    });

    return NextResponse.json({
      success: true,
      invoice_id: saved.invoiceId,
      accounting_ref: saved.accountingRef,
      reconciled: saved.reconciled,
    });
  } catch (err: unknown) {
    if (err instanceof InvoiceValidationError) {
      return NextResponse.json({ error: err.message, anomalies: err.anomalies }, { status: 422 });
    }
    console.error('Scanner confirm error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Erreur confirmation scanner' }, { status: 500 });
  }
}
