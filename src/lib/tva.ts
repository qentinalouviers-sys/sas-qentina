/**
 * tva.ts — Logique TVA partagée
 * Utilisée par la page TVA ET la home page pour garantir des chiffres identiques.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface TvaResult {
  collectedTva: number;
  deductibleTva: number;
  netTva: number;
  collectedTvaBreakdown: { '5.5%': number; '10%': number; '20%': number; autre: number };
}

/** Taux TVA estimé par catégorie bancaire */
function getVatRate(category: string): number {
  if (category === 'variable_fournisseur') return 0.10;
  if (category === 'fixe_loyer' || category === 'fixe_abonnement' || category === 'autre') return 0.20;
  return 0; // fixe_assurance, salaires → pas de TVA récupérable
}

/**
 * Calcule la balance TVA pour une période donnée.
 * Respecte le masquage des fournisseurs sauvegardé en base.
 */
export async function computeTva(
  supabase: SupabaseClient,
  startStr: string,
  endStr: string,
): Promise<TvaResult> {
  // ── 0. Charger les fournisseurs masqués ──────────────────────────────────
  const { data: settingsData } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'masked_tva_suppliers');

  const maskedSuppliers: string[] =
    settingsData && settingsData.length > 0 && settingsData[0].value
      ? JSON.parse(settingsData[0].value)
      : [];

  // ── 1. TVA Collectée — depuis les commandes Square ───────────────────────
  const { data: orders } = await supabase
    .from('square_orders')
    .select('id, net_amount, raw_data')
    .gte('service', startStr)
    .lte('service', endStr);

  let collectedTva = 0;
  const collectedTvaBreakdown: TvaResult['collectedTvaBreakdown'] = {
    '5.5%': 0, '10%': 0, '20%': 0, autre: 0,
  };

  (orders || []).forEach((order: any) => {
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

  // ── 2. Factures de la période ────────────────────────────────────────────
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, total_ht, total_ttc, supplier:suppliers(name)')
    .gte('date', startStr)
    .lte('date', endStr);

  const invoicesList: any[] = invoices || [];

  // ── 3. Transactions bancaires de dépenses ────────────────────────────────
  const { data: bankTx } = await supabase
    .from('bank_transactions')
    .select('id, date, description, amount, category, invoice_id')
    .in('category', ['variable_fournisseur', 'fixe_loyer', 'fixe_abonnement', 'fixe_assurance', 'autre'])
    .gte('date', startStr)
    .lte('date', endStr);

  const bankTxList: any[] = bankTx || [];
  const linkedInvoiceIds = new Set(bankTxList.map((tx: any) => tx.invoice_id).filter(Boolean));

  let deductibleTva = 0;

  // A. Traitement des transactions bancaires
  for (const tx of bankTxList) {
    const supName: string = tx.description || 'Inconnu';
    const isMasked = maskedSuppliers.includes(supName);

    const amt = Math.abs(tx.amount || 0);
    let tva = 0;

    if (tx.invoice_id) {
      // Chercher dans les factures de la période
      let inv: any = invoicesList.find((i: any) => i.id === tx.invoice_id);

      // Si absente (facture hors période), aller la chercher
      if (!inv) {
        const { data: outerInv } = await supabase
          .from('invoices')
          .select('id, total_ht, total_ttc, supplier:suppliers(name)')
          .eq('id', tx.invoice_id)
          .single();
        if (outerInv) inv = outerInv;
      }

      if (inv) {
        tva = Math.max(0, (inv.total_ttc || 0) - (inv.total_ht || 0));
      } else {
        const rate = getVatRate(tx.category);
        tva = amt * (rate / (1 + rate));
      }
    } else {
      const rate = getVatRate(tx.category);
      tva = amt * (rate / (1 + rate));
    }

    if (!isMasked) {
      deductibleTva += tva;
    }
  }

  // B. Factures non liées à une transaction bancaire
  const unpaidInvoices = invoicesList.filter((inv: any) => !linkedInvoiceIds.has(inv.id));
  for (const inv of unpaidInvoices) {
    const supName: string = (inv.supplier as any)?.name || 'Inconnu';
    const isMasked = maskedSuppliers.includes(supName);
    const tva = Math.max(0, (inv.total_ttc || 0) - (inv.total_ht || 0));
    if (!isMasked) {
      deductibleTva += tva;
    }
  }

  return {
    collectedTva,
    deductibleTva,
    netTva: collectedTva - deductibleTva,
    collectedTvaBreakdown,
  };
}
