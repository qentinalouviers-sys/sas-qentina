import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedInvoiceData } from '@/lib/ai/invoice-ocr';
import { assertInvoiceAccepted } from '@/lib/invoice-checks';
import { cleanName, findSupplierMatch, matchIngredient } from '@/lib/referentiel';

/**
 * invoices.ts — Enregistrement d'une facture extraite par l'IA.
 *
 * Un seul chemin d'entrée : /api/scanner/confirm, après relecture humaine.
 * L'import « en un clic » (analyse + enregistrement + rapprochement au
 * premier montant approchant) a été retiré : deux factures Metro de 84,30 €
 * la même semaine se lettaient sur la mauvaise transaction, en silence.
 *
 * Prérequis : le schéma consolidé (db/migration_consolidee.sql) doit être
 * appliqué — plus aucun "fallback schéma legacy" ici.
 */

export function generateAccountingRef(date?: string | null): string {
  const ym = (date || new Date().toISOString().slice(0, 10)).slice(0, 7).replace('-', '');
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FAC-${ym}-${suffix}`;
}

/**
 * Retrouve un fournisseur par son nom, ou le crée.
 *
 * La correspondance est une égalité après normalisation (accents, casse,
 * encodage cassé), jamais une inclusion : l'ancien `ilike '%Métro%'` ne
 * retrouvait pas « MÃ©tro » et aurait capté un « Eurométro ». La table est
 * petite (quelques dizaines de fiches) : on la lit entière plutôt que de
 * déléguer la comparaison à SQL, qui ne sait pas normaliser comme nous.
 */
export async function findOrCreateSupplier(
  supabase: SupabaseClient,
  name: string | null | undefined
): Promise<string | null> {
  const clean = cleanName(name ?? '');
  if (!clean) return null;

  const { data: all } = await supabase.from('suppliers').select('id, name');
  const found = findSupplierMatch(clean, (all ?? []) as { id: string; name: string }[]);
  if (found) return found.id;

  const { data: created } = await supabase
    .from('suppliers')
    .insert({ name: clean })
    .select('id')
    .single();
  return created?.id ?? null;
}

export interface SaveInvoiceOptions {
  fileUrl?: string | null;
  paymentMethod?: string;
  paymentNotes?: string | null;
  /**
   * Codes d'anomalies que l'humain a explicitement acquittés à l'écran.
   * Sans eux, toute facture inhabituelle est refusée : le serveur ne fait pas
   * confiance au client pour avoir montré les avertissements.
   */
  confirmations?: readonly string[];
  /** Date du jour en ISO — paramétrable pour les tests. */
  today?: string;
}

export interface SavedInvoice {
  id: string;
  accountingRef: string;
  supplierId: string | null;
}

/**
 * Insère la facture + ses lignes.
 *
 * @throws InvoiceValidationError si la facture est incohérente ou si un point
 *   inhabituel n'a pas été acquitté — voir lib/invoice-checks.ts.
 */
export async function saveInvoice(
  supabase: SupabaseClient,
  extracted: ExtractedInvoiceData,
  options: SaveInvoiceOptions = {}
): Promise<SavedInvoice> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  assertInvoiceAccepted(extracted, today, options.confirmations ?? []);

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
 * alimentaire/boisson d'une facture.
 *
 * Seules les désignations qui correspondent EXACTEMENT à un ingrédient — par
 * son nom ou par un alias validé dans Réglages — mettent un prix à jour. Plus
 * aucune création automatique : chaque ligne inconnue créait un ingrédient à
 * son libellé brut, et « le nom contient » faisait porter le prix du concentré
 * à la tomate. Les désignations non reconnues attendent dans Réglages →
 * Ingrédients, où un humain les rattache.
 */
export async function updateIngredientPrices(
  supabase: SupabaseClient,
  lignes: NonNullable<ExtractedInvoiceData['lignes']>
): Promise<{ updated: number; unmatched: string[] }> {
  const foodLines = lignes.filter(l => l.categorie === 'alimentaire' || l.categorie === 'boisson');
  if (foodLines.length === 0) return { updated: 0, unmatched: [] };

  const [{ data: ingredients }, { data: aliases }] = await Promise.all([
    supabase.from('ingredients').select('id, name, last_unit_price'),
    supabase.from('ingredient_aliases').select('alias, ingredient_id'),
  ]);
  const all = (ingredients ?? []) as { id: string; name: string; last_unit_price: number | null }[];
  const now = new Date().toISOString();
  const unmatched: string[] = [];
  let updated = 0;

  for (const l of foodLines) {
    const match = matchIngredient(l.designation ?? '', all, aliases ?? []);
    if (!match) {
      unmatched.push(l.designation);
      continue;
    }
    const price = Number(l.prix_unitaire_ht);
    if (!Number.isFinite(price) || price <= 0 || price === match.last_unit_price) continue;

    await supabase
      .from('ingredients')
      .update({ last_unit_price: price, last_updated: now })
      .eq('id', match.id);
    match.last_unit_price = price;
    updated++;
  }

  if (unmatched.length > 0) {
    console.log(`[Mercuriale] ${updated} prix mis à jour, ${unmatched.length} désignation(s) non rattachée(s) : ${unmatched.slice(0, 5).join(' | ')}`);
  }
  return { updated, unmatched };
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
