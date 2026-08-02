import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { runInvoiceOcr } from '@/lib/ai/invoice-ocr';
import {
  saveInvoice,
  updateIngredientPrices,
  autoReconcileBankTx,
  uploadInvoiceFile,
} from '@/lib/invoices';

/**
 * Extraction + enregistrement d'une facture en un seul appel.
 * (Le Scanner utilise le flux en deux temps /api/scanner → /api/scanner/confirm,
 * qui permet de vérifier les données avant enregistrement.)
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { pdfBase64, fileBase64, mimeType, filename } = await request.json();
    const activeBase64 = fileBase64 || pdfBase64;
    if (!activeBase64) {
      return NextResponse.json({ error: 'Fichier requis (PDF ou image)' }, { status: 400 });
    }
    const activeMimeType = mimeType || 'application/pdf';

    // 1. OCR Claude
    let extracted;
    try {
      extracted = await runInvoiceOcr([{ fileBase64: activeBase64, mimeType: activeMimeType }]);
    } catch (e: any) {
      return NextResponse.json({ error: e.message || 'Extraction impossible' }, { status: 500 });
    }

    const supabase = createServiceRoleClient();

    // 2. Détection de doublon (même numéro de facture)
    if (extracted.numero_facture) {
      const { data: duplicate } = await supabase
        .from('invoices')
        .select('id')
        .eq('invoice_number', extracted.numero_facture)
        .limit(1)
        .maybeSingle();

      if (duplicate) {
        return NextResponse.json({
          success: false,
          error: `Facture doublon détectée (n° ${extracted.numero_facture}). Elle a déjà été importée.`,
        });
      }
    }

    // 3. Upload du fichier
    const fileUrl = await uploadInvoiceFile(supabase, activeBase64, activeMimeType, filename);

    // 4. Enregistrement facture + lignes
    const saved = await saveInvoice(supabase, extracted, { fileUrl });

    // 5. Mise à jour de la mercuriale (prix des ingrédients)
    if (extracted.lignes?.length) {
      await updateIngredientPrices(supabase, extracted.lignes);
    }

    // 6. Rapprochement bancaire automatique
    const reconciledTxId = await autoReconcileBankTx(supabase, saved.id, extracted);

    return NextResponse.json({
      success: true,
      invoice_id: saved.id,
      pdf_url: fileUrl,
      extracted,
      reconciled_tx_id: reconciledTxId,
      accounting_ref: saved.accountingRef,
    });
  } catch (error) {
    console.error('Extract error:', error);
    return NextResponse.json({ error: 'Erreur extraction' }, { status: 500 });
  }
}
