import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedInvoiceData } from '@/lib/ai/invoice-ocr';

/**
 * invoices.ts — Enregistrement d'une facture extraite par l'IA.
 * Logique unique partagée par /api/invoices/extract et /api/scanner/confirm.
 *
 * Prérequis : le schéma consolidé (db/migration_consolidee.sql) doit être
 * appliqué — plus aucun "fallback schéma legacy" ici.
 */

export function generateAccountingRef(date?: string | null): string {
  const ym = (date || new Date().toISOString().slice(0, 10)).slice(0, 7).replace('-', '');
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FAC-${ym}-${suffix}`;
}

/** Retrouve un fournisseur par nom approchant, ou le crée. */
export async function findOrCreateSupplier(
  supabase: SupabaseClient,
  name: string | null | undefined
): Promise<string | null> {
  if (!name) return null;

  const { data: found } = await supabase
    .from('suppliers')
    .select('id')
    .ilike('name', `%${name}%`)
    .limit(1)
    .maybeSingle();

  if (found) return found.id;

  const { data: created } = await supabase
    .from('suppliers')
    .insert({ name })
    .select('id')
    .single();
  return created?.id ?? null;
}

export interface SaveInvoiceOptions {
  fileUrl?: string | null;
  paymentMethod?: string;
  paymentNotes?: string | null;
}

export interface SavedInvoice {
  id: string;
  accountingRef: string;
  supplierId: string | null;
}

/** Insère la facture + ses lignes. */
export async function saveInvoice(
  supabase: SupabaseClient,
  extracted: ExtractedInvoiceData,
  options: SaveInvoiceOptions = {}
): Promise<SavedInvoice> {
  const supplierId = await findOrCreateSupplier(supabase, extracted.fournisseur);
  const accountingRef = generateAccountingRef(extracted.date);

  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      supplier_id: supplierId,
      invoice_number: extracted.numero_facture,
      date: extracted.date,
      total_ht: extracted.total_ht,
      total_ttc: extracted.total_ttc,
      pdf_url: options.fileUrl ?? null,
      accounting_ref: accountingRef,
      accounting_class: extracted.compte_comptable || '601',
      payment_method: options.paymentMethod || 'bank',
      payment_notes: options.paymentNotes || null,
      type_document: extracted.type_document || 'facture',
      company_name_present: extracted.nom_entreprise_present ?? true,
      tva_recoverable: extracted.tva_recoverable ?? true,
    })
    .select('id')
    .single();

  if (error || !invoice) {
    throw new Error(`Insertion facture impossible : ${error?.message || 'inconnue'}`);
  }

  if (extracted.lignes?.length) {
    const { error: linesError } = await supabase.from('invoice_lines').insert(
      extracted.lignes.map(l => ({
        invoice_id: invoice.id,
        designation: l.designation,
        quantity: l.quantite,
        unit: l.unite,
        unit_price_ht: l.prix_unitaire_ht,
        total_ht: l.prix_total_ht,
        category: l.categorie,
      }))
    );
    if (linesError) console.error('Insertion lignes facture:', linesError);
  }

  return { id: invoice.id, accountingRef, supplierId };
}

/**
 * Met à jour le prix des ingrédients (mercuriale) à partir des lignes
 * alimentaire/boisson. Une seule requête de lecture (plus de N+1).
 */
export async function updateIngredientPrices(
  supabase: SupabaseClient,
  lignes: NonNullable<ExtractedInvoiceData['lignes']>
): Promise<void> {
  const foodLines = lignes.filter(l => l.categorie === 'alimentaire' || l.categorie === 'boisson');
  if (foodLines.length === 0) return;

  const { data: ingredients } = await supabase.from('ingredients').select('id, name');
  const all = ingredients || [];
  const now = new Date().toISOString();

  for (const l of foodLines) {
    const needle = (l.designation || '').toLowerCase();
    const match = all.find(
      (ing: { id: string; name: string }) =>
        needle.includes(ing.name.toLowerCase()) || ing.name.toLowerCase().includes(needle)
    );

    if (match) {
      await supabase
        .from('ingredients')
        .update({ last_unit_price: l.prix_unitaire_ht, last_updated: now })
        .eq('id', match.id);
    } else {
      const { data: created } = await supabase
        .from('ingredients')
        .insert({
          name: l.designation,
          unit: l.unite || 'kg',
          last_unit_price: l.prix_unitaire_ht,
          last_updated: now,
        })
        .select('id, name')
        .single();
      if (created) all.push(created);
    }
  }
}

/**
 * Rapprochement bancaire automatique : cherche une transaction en attente
 * au même montant (±0,50 €) dans les ±10 jours et la lie à la facture.
 */
export async function autoReconcileBankTx(
  supabase: SupabaseClient,
  invoiceId: string,
  extracted: ExtractedInvoiceData
): Promise<string | null> {
  if (!extracted.total_ttc || !extracted.date) return null;

  const targetAmount = -Math.abs(extracted.total_ttc);
  const invoiceDate = new Date(extracted.date);
  const minDate = new Date(invoiceDate); minDate.setDate(invoiceDate.getDate() - 10);
  const maxDate = new Date(invoiceDate); maxDate.setDate(invoiceDate.getDate() + 10);

  const { data: bankTx } = await supabase
    .from('bank_transactions')
    .select('id')
    .eq('status', 'pending_invoice')
    .gte('amount', targetAmount - 0.5)
    .lte('amount', targetAmount + 0.5)
    .gte('date', minDate.toISOString().split('T')[0])
    .lte('date', maxDate.toISOString().split('T')[0])
    .limit(1)
    .maybeSingle();

  if (!bankTx) return null;

  await linkBankTransaction(supabase, bankTx.id, invoiceId, extracted.compte_comptable);
  return bankTx.id;
}

/** Marque une transaction bancaire comme rapprochée avec une facture. */
export async function linkBankTransaction(
  supabase: SupabaseClient,
  bankTxId: string,
  invoiceId: string,
  accountingClass?: string | null
): Promise<void> {
  const { error } = await supabase
    .from('bank_transactions')
    .update({
      status: 'reconciled',
      invoice_id: invoiceId,
      accounting_class: accountingClass || '601',
    })
    .eq('id', bankTxId);
  if (error) console.error('Lien transaction bancaire:', error);
}

/**
 * Crée un mouvement de Compte Courant d'Associé quand une facture
 * est payée avec l'argent personnel d'un associé (CB perso / espèces).
 */
export async function createCcaMovementForInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  extracted: ExtractedInvoiceData,
  associe: string,
  paymentMethod: string,
  fileUrl?: string | null
): Promise<void> {
  const { error } = await supabase.from('mouvements_cca').insert({
    date: extracted.date || new Date().toISOString().split('T')[0],
    associe,
    sens: 'apport',
    sous_type: 'facture_payee_perso',
    montant: extracted.total_ttc || extracted.total_ht || 0,
    piece_justif: fileUrl ?? null,
    note: `Règlement ${paymentMethod === 'cash' ? 'espèces ' : ''}facture ${extracted.numero_facture || ''} (${extracted.fournisseur || 'Inconnu'}) [Scanner]`,
    rapproche_banque: false,
    invoice_id: invoiceId,
  });
  if (error) {
    console.error('Insertion mouvement CCA:', error);
    throw error;
  }
}

/** Upload du fichier scanné dans Supabase Storage, renvoie l'URL publique. */
export async function uploadInvoiceFile(
  supabase: SupabaseClient,
  fileBase64: string,
  mimeType: string,
  filename?: string | null
): Promise<string | null> {
  try {
    const bytes = Buffer.from(fileBase64, 'base64');
    const isPDF = mimeType.includes('pdf');
    const ext = isPDF ? 'pdf' : (mimeType.split('/')[1] || 'jpg');
    const ts = Date.now();
    const safeFile = (filename || `scan_${ts}.${ext}`)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .substring(0, 80);
    const now = new Date();
    const path = `invoices/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${ts}_${safeFile}`;

    const { error: uploadErr } = await supabase.storage
      .from('invoice-files')
      .upload(path, bytes, { contentType: mimeType, upsert: false });

    if (uploadErr) {
      console.warn('Upload storage échoué (bucket "invoice-files" absent ?):', uploadErr.message);
      return null;
    }

    const { data: { publicUrl } } = supabase.storage
      .from('invoice-files')
      .getPublicUrl(path);
    return publicUrl;
  } catch (e) {
    console.warn('Exception upload storage (non bloquante):', e);
    return null;
  }
}
