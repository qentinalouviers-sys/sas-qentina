import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all';
import { monthBounds } from '@/lib/months';

export { monthBounds, monthLabel, recentMonths, isMonthOver } from '@/lib/months';
import { computeTva } from '@/lib/tva';
import { orderHtAmount, bankAmountHt, makeInvoiceMatcher, isFinancialFlow, round2 } from '@/lib/accounting';
import { inventorySessions, computeCogs, type CogsMethod } from '@/lib/cogs';
import { collectInterventionFacts, detectInterventions, type Intervention } from '@/lib/interventions';

/**
 * closures.ts — Clôture mensuelle : l'instantané d'un mois, et ses conditions.
 *
 * Le verrou lui-même est un trigger Postgres (db/migration_clotures.sql). Ce
 * module fait le reste : dire si un mois PEUT être clôturé (aucune intervention
 * critique ouverte, mois écoulé), et figer ses chiffres au moment où on le fait.
 * Le snapshot sert à deux choses : transmettre au cabinet exactement ce qui a
 * été validé, et détecter plus tard qu'un mois clôturé a bougé quand même (les
 * ventes Square, elles, ne sont pas verrouillées : une commande tardive ne doit
 * pas être perdue en silence).
 */

export interface ClosureSnapshot {
  ca_ttc: number;
  ca_ht: number;
  orders: number;
  achats_ht: number;
  cogs: number;
  cogs_method: CogsMethod;
  stock_variation: number;
  tva_collectee: number;
  tva_deductible: number;
  tva_nette: number;
  invoices: number;
  bank_transactions: number;
}

/** Ce qui empêche de clôturer, s'il y a lieu. */
export interface ClosureCheck {
  month: string;
  canClose: boolean;
  /** Mois pas encore terminé. */
  notOver: boolean;
  /** Interventions critiques ouvertes sur ce mois : le chiffre de base est faux. */
  blocking: Intervention[];
}

/**
 * Un mois se clôture s'il est terminé et qu'aucune intervention critique n'est
 * ouverte : clôturer un mois dont le CA est incomplet figerait un chiffre faux.
 */
export async function checkClosure(supabase: SupabaseClient, month: string, today: string): Promise<ClosureCheck> {
  const { start, end } = monthBounds(month);
  const notOver = end >= today;
  if (notOver) return { month, canClose: false, notOver, blocking: [] };

  const facts = await collectInterventionFacts(supabase, { start, end, today });
  const blocking = detectInterventions(facts).filter(i => i.severity === 'critique');
  return { month, canClose: blocking.length === 0, notOver, blocking };
}

/**
 * Chiffres du mois, calculés comme le P&L les calcule (mêmes règles, mêmes
 * fonctions) : CA Square HT/TTC, achats ventilés + paiements sans facture en
 * HT, coût matières consommé, TVA.
 */
export async function buildSnapshot(supabase: SupabaseClient, month: string): Promise<ClosureSnapshot> {
  const { start, end } = monthBounds(month);

  const [orders, invoices, bankSuppliers, bankAll, inventory, tva] = await Promise.all([
    fetchAllRows<{ id: string; net_amount: number | null; raw_data: unknown }>((f0, f1) => supabase
      .from('square_orders').select('id, net_amount, raw_data')
      .gte('service', start).lte('service', end).range(f0, f1)),
    fetchAllRows<{ id: string; total_ttc: number | null }>((f0, f1) => supabase
      .from('invoices').select('id, total_ttc')
      .gte('date', start).lte('date', end).range(f0, f1)),
    fetchAllRows<{ amount: number | null; description: string | null; category: string | null }>((f0, f1) => supabase
      .from('bank_transactions').select('amount, description, category')
      .eq('category', 'variable_fournisseur').is('invoice_id', null)
      .gte('date', start).lte('date', end).range(f0, f1)),
    fetchAllRows<{ id: string }>((f0, f1) => supabase
      .from('bank_transactions').select('id')
      .gte('date', start).lte('date', end).range(f0, f1)),
    fetchAllRows<{ ingredient_id: string; quantity: number | null; unit_price: number | null; counted_at: string }>((f0, f1) => supabase
      .from('inventory_counts').select('ingredient_id, quantity, unit_price, counted_at').range(f0, f1)),
    computeTva(supabase, start, end),
  ]);

  // Lignes de facture : alimentaire, boisson, emballage = coût matières.
  const invoiceIds = invoices.map(i => i.id);
  let cogsFactures = 0;
  if (invoiceIds.length > 0) {
    const lines = await fetchAllRowsIn<{ total_ht: number | null; category: string | null }, string>(
      invoiceIds, (ids, f0, f1) => supabase
        .from('invoice_lines').select('total_ht, category').in('invoice_id', ids).range(f0, f1));
    for (const l of lines) {
      if (['alimentaire', 'boisson', 'emballage'].includes(l.category ?? '')) cogsFactures += l.total_ht || 0;
    }
  }

  const matcher = makeInvoiceMatcher(invoices);
  const cogsBanque = bankSuppliers
    .filter(t => !isFinancialFlow(t.description ?? '', t.category))
    .filter(t => !matcher.alreadyInvoiced(t))
    .reduce((s, t) => s + bankAmountHt(t, 'variable_fournisseur'), 0);

  const achatsHt = round2(cogsFactures + cogsBanque);
  const cogs = computeCogs({ purchases: achatsHt, sessions: inventorySessions(inventory), start, end });

  let caTtc = 0;
  let caHt = 0;
  for (const o of orders) {
    caTtc += o.net_amount || 0;
    caHt += orderHtAmount(o);
  }

  return {
    ca_ttc: round2(caTtc),
    ca_ht: round2(caHt),
    orders: orders.length,
    achats_ht: achatsHt,
    cogs: cogs.cogs,
    cogs_method: cogs.method,
    stock_variation: cogs.stockVariation,
    tva_collectee: round2(tva.collectedTva),
    tva_deductible: round2(tva.deductibleTva),
    tva_nette: round2(tva.netTva),
    invoices: invoices.length,
    bank_transactions: bankAll.length,
  };
}
