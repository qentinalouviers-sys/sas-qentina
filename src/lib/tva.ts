/**
 * tva.ts — Logique TVA partagée.
 * Source de vérité UNIQUE utilisée par le dashboard ET la page TVA
 * pour garantir des chiffres identiques partout.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface TvaResult {
  collectedTva: number;
  deductibleTva: number;
  netTva: number;
  collectedTvaBreakdown: { '5.5%': number; '10%': number; '20%': number; autre: number };
}

/** Taux TVA estimé par catégorie bancaire */
export function getVatRate(category: string): number {
  if (category === 'variable_fournisseur') return 0.10;
  if (category === 'fixe_loyer' || category === 'fixe_abonnement' || category === 'autre') return 0.20;
  return 0; // fixe_assurance, salaires → pas de TVA récupérable
}

/** TVA d'une facture — 0 si elle est marquée non récupérable (règle fiscale). */
function invoiceTva(inv: { total_ht: number | null; total_ttc: number | null; tva_recoverable?: boolean | null }): number {
  if (inv.tva_recoverable === false) return 0;
  return Math.max(0, (inv.total_ttc || 0) - (inv.total_ht || 0));
}

/**
 * Calcule la balance TVA pour une période donnée.
 * Respecte le masquage des fournisseurs ET le marquage tva_recoverable.
 */
export async function computeTva(
  supabase: SupabaseClient,
  startStr: string,
  endStr: string,
): Promise<TvaResult> {
  // ── 0. Lectures indépendantes en parallèle ───────────────────────────────
  const [settingsRes, ordersRes, invoicesRes, bankTxRes] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', 'masked_tva_suppliers'),
    supabase.from('square_orders')
      .select('id, net_amount, raw_data')
      .gte('service', startStr)
      .lte('service', endStr),
    supabase.from('invoices')
      .select('id, total_ht, total_ttc, tva_recoverable, supplier:suppliers(name)')
      .gte('date', startStr)
      .lte('date', endStr),
    supabase.from('bank_transactions')
      .select('id, date, description, amount, category, invoice_id')
      .in('category', ['variable_fournisseur', 'fixe_loyer', 'fixe_abonnement', 'fixe_assurance', 'autre'])
      .gte('date', startStr)
      .lte('date', endStr),
  ]);

  const maskedSuppliers: string[] =
    settingsRes.data && settingsRes.data.length > 0 && settingsRes.data[0].value
      ? JSON.parse(settingsRes.data[0].value)
      : [];

  // ── 1. TVA Collectée — depuis les commandes Square ───────────────────────
  let collectedTva = 0;
  const collectedTvaBreakdown: TvaResult['collectedTvaBreakdown'] = {
    '5.5%': 0, '10%': 0, '20%': 0, autre: 0,
  };

  (ordersRes.data || []).forEach((order: any) => {
    const taxCents = order.raw_data?.total_tax_money?.amount;
    if (taxCents !== undefined) {
      const taxEuro = taxCents / 100;
      collectedTva += taxEuro;

      if (order.raw_data?.line_items && Array.isArray(order.raw_data.line_items)) {
        order.raw_data.line_items.forEach((item: any) => {
          const itemTax = (item.total_tax_money?.amount || 0) / 100;
          const itemTotal = (item.total_money?.amount || 0) / 100;
          if (itemTax > 0) {
            const ht = itemTotal - itemTax;
            if (ht > 0) {
              const rate = itemTax / ht;
              if (rate >= 0.18 && rate <= 0.22) collectedTvaBreakdown['20%'] += itemTax;
              else if (rate >= 0.08 && rate <= 0.12) collectedTvaBreakdown['10%'] += itemTax;
              else if (rate >= 0.04 && rate <= 0.07) collectedTvaBreakdown['5.5%'] += itemTax;
              else collectedTvaBreakdown.autre += itemTax;
            } else {
              collectedTvaBreakdown.autre += itemTax;
            }
          }
        });
      } else {
        collectedTvaBreakdown['10%'] += taxEuro;
      }
    } else {
      const estimated = (order.net_amount || 0) * (0.10 / 1.10);
      collectedTva += estimated;
      collectedTvaBreakdown['10%'] += estimated;
    }
  });

  // ── 2. TVA Déductible ─────────────────────────────────────────────────────
  const invoicesList: any[] = invoicesRes.data || [];
  const bankTxList: any[] = bankTxRes.data || [];
  const invoicesById = new Map(invoicesList.map((i: any) => [i.id, i]));
  const linkedInvoiceIds = new Set(bankTxList.map((tx: any) => tx.invoice_id).filter(Boolean));

  // Factures liées à une transaction mais hors période : UNE seule requête
  // groupée (avant : une requête par transaction — boucle N+1).
  const missingInvoiceIds = [...linkedInvoiceIds].filter(id => !invoicesById.has(id));
  if (missingInvoiceIds.length > 0) {
    const { data: outerInvoices } = await supabase
      .from('invoices')
      .select('id, total_ht, total_ttc, tva_recoverable, supplier:suppliers(name)')
      .in('id', missingInvoiceIds);
    (outerInvoices || []).forEach((inv: any) => invoicesById.set(inv.id, inv));
  }

  let deductibleTva = 0;

  // A. Transactions bancaires de dépenses
  for (const tx of bankTxList) {
    const supName: string = tx.description || 'Inconnu';
    if (maskedSuppliers.includes(supName)) continue;

    const amt = Math.abs(tx.amount || 0);
    const inv = tx.invoice_id ? invoicesById.get(tx.invoice_id) : null;

    if (inv) {
      deductibleTva += invoiceTva(inv);
    } else {
      const rate = getVatRate(tx.category);
      deductibleTva += amt * (rate / (1 + rate));
    }
  }

  // B. Factures non liées à une transaction bancaire
  for (const inv of invoicesList) {
    if (linkedInvoiceIds.has(inv.id)) continue;
    const supName: string = (inv.supplier as any)?.name || 'Inconnu';
    if (maskedSuppliers.includes(supName)) continue;
    deductibleTva += invoiceTva(inv);
  }

  return {
    collectedTva,
    deductibleTva,
    netTva: collectedTva - deductibleTva,
    collectedTvaBreakdown,
  };
}
