/**
 * tva.ts — Calcul de TVA. Source de vérité UNIQUE pour le tableau de bord,
 * la page TVA et le P&L.
 *
 * ── Deux principes, tirés d'un contrôle qui a révélé un crédit de TVA fictif ──
 *
 * 1. **La TVA collectée vient de la caisse Square, et de rien d'autre.**
 *    Square est la référence du chiffre d'affaires. Un encaissement bancaire
 *    n'est pas une vente : un prêt, un apport ou un virement de trésorerie
 *    arrivent aussi sur le compte.
 *
 * 2. **La TVA déductible vient des factures, et de rien d'autre.**
 *    L'article 271 du CGI subordonne la déduction à une facture. Estimer la
 *    TVA depuis un libellé bancaire fabrique un droit à déduction qui n'existe
 *    pas — c'est exactement ce que faisait la version précédente, y compris
 *    sur des prêts et des retraits d'espèces.
 *
 *    Ce que l'outil *peut* faire, c'est chiffrer ce qui serait récupérable si
 *    les factures étaient rattachées. Ce montant est renvoyé séparément, sous
 *    un nom qui interdit de le confondre avec un chiffre déclarable.
 *
 * ── Sur l'arithmétique ──
 *
 * Tous les cumuls se font en **centimes entiers**. Additionner des euros en
 * virgule flottante finit toujours par coûter un centime, et une ventilation
 * de TVA doit tomber juste à l'euro près sur une déclaration. La ventilation
 * par taux est donc exacte par construction : le total EST la somme des
 * tranches, il n'est pas calculé à côté puis comparé.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { isFinancialFlow, estimatedVatRate, invoiceVat, round2 } from './accounting';

export interface TvaBreakdown {
  '5.5%': number;
  '10%': number;
  '20%': number;
  /**
   * TVA dont le taux n'a pas pu être déterminé depuis Square (commande sans
   * détail de lignes, ou écart entre le total de la commande et la somme de
   * ses lignes). Exposée au lieu d'être répartie au hasard : sur une
   * déclaration, mieux vaut un montant à instruire qu'un montant deviné.
   */
  nonVentile: number;
}

export interface TvaResult {
  // ── Montants déclarables ────────────────────────────────────────────────
  /** TVA collectée sur les ventes Square. Égale la somme de la ventilation. */
  collectedTva: number;
  /** TVA déductible justifiée par une facture. Seul montant déductible. */
  deductibleTva: number;
  /** Positif = à payer, négatif = crédit de TVA. */
  netTva: number;
  collectedTvaBreakdown: TvaBreakdown;

  // ── Indicateurs de pilotage, NON déclarables ────────────────────────────
  /**
   * TVA qui deviendrait récupérable si les dépenses concernées étaient
   * appuyées d'une facture. Sert à chiffrer l'intérêt de finir le
   * rapprochement bancaire — jamais à remplir une déclaration.
   */
  recoverableIfInvoiced: number;
  /** Nombre de dépenses sans facture rattachée. */
  unInvoicedCount: number;
  /** Montant TTC de ces dépenses. */
  unInvoicedAmount: number;

  // ── Contrôles de fiabilité ──────────────────────────────────────────────
  /** Montant des flux financiers écartés (prêts, apports, compte courant…). */
  financialFlowAmount: number;
  financialFlowCount: number;
  /** Commandes Square dont la TVA a dû être estimée faute de données. */
  estimatedOrdersCount: number;
  /** Nombre de factures ayant alimenté la TVA déductible. */
  invoiceCount: number;
}

/** Taux de TVA indicatif d'une catégorie — réexporté pour les écrans. */
export { estimatedVatRate as getVatRate } from './accounting';

/**
 * Tranche correspondant à un taux exprimé en pourcentage (10 pour 10 %).
 *
 * La tolérance est serrée (±0,6 point) parce que ce taux est LU dans les
 * données Square, pas deviné : il n'a pas à absorber du bruit d'arrondi. Une
 * fourchette large classait une TVA à 7 % dans la tranche 5,5 % — sur une
 * déclaration, c'est une erreur de ventilation.
 */
function bucketForPercentage(pct: number): keyof TvaBreakdown | null {
  if (Math.abs(pct - 20) <= 0.6) return '20%';
  if (Math.abs(pct - 10) <= 0.6) return '10%';
  if (Math.abs(pct - 5.5) <= 0.6) return '5.5%';
  return null;
}

/**
 * Tranche déduite du rapport taxe/HT — dernier recours, quand Square ne donne
 * pas le taux. La fourchette est un peu plus large pour tolérer les arrondis
 * au centime sur de petits montants, mais reste bien séparée des taux voisins.
 */
function bucketForRatio(taxCents: number, htCents: number): keyof TvaBreakdown | null {
  if (htCents <= 0) return null;
  return bucketForPercentage((taxCents / htCents) * 100);
}

/** Taux d'une taxe Square, en pourcentage, ou null s'il est illisible. */
function percentageOf(tax: any): number | null {
  const raw = tax?.percentage;
  if (raw === undefined || raw === null) return null;
  const pct = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Balance de TVA pour une période.
 *
 * @param startStr / @param endStr bornes ISO incluses (YYYY-MM-DD)
 */
export async function computeTva(
  supabase: SupabaseClient,
  startStr: string,
  endStr: string,
): Promise<TvaResult> {
  // Toutes ces lectures sont paginées : Supabase plafonne une réponse à
  // 1 000 lignes SANS le signaler. Sur un exercice complet, la TVA collectée
  // était calculée sur les 1 000 premières commandes seulement.
  const [settingsRes, orders, invoices, bankTx] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', 'masked_tva_suppliers'),
    fetchAllRows<any>((from, to) => supabase.from('square_orders')
      .select('id, net_amount, raw_data')
      .gte('service', startStr)
      .lte('service', endStr)
      .range(from, to)),
    fetchAllRows<any>((from, to) => supabase.from('invoices')
      .select('id, total_ht, total_ttc, tva_recoverable, supplier:suppliers(name)')
      .gte('date', startStr)
      .lte('date', endStr)
      .range(from, to)),
    fetchAllRows<any>((from, to) => supabase.from('bank_transactions')
      .select('id, date, description, amount, category, invoice_id')
      .lt('amount', 0) // seules les dépenses peuvent porter de la TVA déductible
      .gte('date', startStr)
      .lte('date', endStr)
      .range(from, to)),
  ]);

  const maskedSuppliers: string[] =
    settingsRes.data && settingsRes.data.length > 0 && settingsRes.data[0].value
      ? JSON.parse(settingsRes.data[0].value)
      : [];

  // ── 1. TVA collectée — Square, en centimes entiers ───────────────────────
  const cents: Record<keyof TvaBreakdown, number> = {
    '5.5%': 0, '10%': 0, '20%': 0, nonVentile: 0,
  };
  let estimatedOrdersCount = 0;

  for (const order of orders) {
    const orderTaxCents: number | undefined = order.raw_data?.total_tax_money?.amount;

    if (orderTaxCents === undefined) {
      // Aucune donnée de taxe Square : on estime au taux dominant de la
      // restauration sur place, et on le compte pour que ce soit visible.
      const estimated = Math.round((order.net_amount || 0) * (0.10 / 1.10) * 100);
      cents.nonVentile += estimated;
      estimatedOrdersCount++;
      continue;
    }

    const items = Array.isArray(order.raw_data?.line_items) ? order.raw_data.line_items : [];

    // Taxes définies au niveau de la commande, référencées par les lignes via
    // `applied_taxes[].tax_uid`. Square utilise indifféremment les deux formes.
    const orderTaxRates = new Map<string, number>();
    for (const t of (Array.isArray(order.raw_data?.taxes) ? order.raw_data.taxes : [])) {
      const pct = percentageOf(t);
      if (t?.uid && pct !== null) orderTaxRates.set(t.uid, pct);
    }

    let allocated = 0;

    for (const item of items) {
      // 1er choix : la taxe portée par la ligne, avec son taux déclaré.
      const itemTaxes = Array.isArray(item.taxes) ? item.taxes : [];
      let ventileParTaxe = false;

      for (const t of itemTaxes) {
        const applied: number = t?.applied_money?.amount ?? 0;
        if (applied <= 0) continue;
        const pct = percentageOf(t);
        const bucket = pct !== null ? bucketForPercentage(pct) : null;
        if (bucket) {
          cents[bucket] += applied;
          allocated += applied;
          ventileParTaxe = true;
        }
      }

      // 2e choix : taxe définie au niveau commande et appliquée à la ligne.
      if (!ventileParTaxe) {
        for (const at of (Array.isArray(item.applied_taxes) ? item.applied_taxes : [])) {
          const applied: number = at?.applied_money?.amount ?? 0;
          if (applied <= 0) continue;
          const pct = at?.tax_uid !== undefined ? orderTaxRates.get(at.tax_uid) : undefined;
          const bucket = pct !== undefined ? bucketForPercentage(pct) : null;
          if (bucket) {
            cents[bucket] += applied;
            allocated += applied;
            ventileParTaxe = true;
          }
        }
      }

      // Dernier recours : déduire le taux du rapport taxe/HT de la ligne.
      if (!ventileParTaxe) {
        const itemTax: number = item.total_tax_money?.amount || 0;
        if (itemTax <= 0) continue;
        const itemTotal: number = item.total_money?.amount || 0;
        const bucket = bucketForRatio(itemTax, itemTotal - itemTax);
        if (bucket) {
          cents[bucket] += itemTax;
          allocated += itemTax;
        }
        // Taux hors tranches connues : laissé au résidu plutôt que forcé.
      }
    }

    // Le total de la commande peut dépasser la somme de ses lignes (remise ou
    // frais de service au niveau commande). L'écart est conservé tel quel :
    // c'est ce résidu que l'ancienne version perdait, d'où une ventilation
    // qui ne réconciliait pas avec le total affiché.
    const residual = orderTaxCents - allocated;
    if (residual !== 0) cents.nonVentile += residual;
  }

  // Le total EST la somme des tranches : l'égalité est structurelle.
  const collectedCents = cents['5.5%'] + cents['10%'] + cents['20%'] + cents.nonVentile;

  // ── 2. TVA déductible — factures uniquement ──────────────────────────────
  const invoicesList = invoices;
  const bankTxList = bankTx;

  let deductibleCents = 0;
  let invoiceCount = 0;

  for (const inv of invoicesList) {
    const supName: string = (inv.supplier as any)?.name || 'Inconnu';
    if (maskedSuppliers.includes(supName)) continue;
    const tva = invoiceVat(inv);
    if (tva > 0) invoiceCount++;
    deductibleCents += Math.round(tva * 100);
  }

  // ── 3. Indicateur : ce qui serait récupérable avec les factures ──────────
  let recoverableCents = 0;
  let unInvoicedCount = 0;
  let unInvoicedCents = 0;
  let financialFlowCents = 0;
  let financialFlowCount = 0;

  for (const tx of bankTxList) {
    const description: string = tx.description || '';
    const amountCents = Math.round(Math.abs(tx.amount || 0) * 100);

    // Hors exploitation et hors champ de la TVA : ni déductible, ni même
    // « récupérable un jour ». Compté à part pour que l'écart soit explicable.
    if (isFinancialFlow(description, tx.category)) {
      financialFlowCents += amountCents;
      financialFlowCount++;
      continue;
    }

    if (tx.invoice_id) continue;              // déjà couvert par sa facture
    if (maskedSuppliers.includes(description)) continue;

    const rate = estimatedVatRate(tx.category);
    unInvoicedCount++;
    unInvoicedCents += amountCents;
    if (rate > 0) {
      recoverableCents += Math.round(amountCents * (rate / (1 + rate)));
    }
  }

  return {
    collectedTva: round2(collectedCents / 100),
    deductibleTva: round2(deductibleCents / 100),
    netTva: round2((collectedCents - deductibleCents) / 100),
    collectedTvaBreakdown: {
      '5.5%': round2(cents['5.5%'] / 100),
      '10%': round2(cents['10%'] / 100),
      '20%': round2(cents['20%'] / 100),
      nonVentile: round2(cents.nonVentile / 100),
    },
    recoverableIfInvoiced: round2(recoverableCents / 100),
    unInvoicedCount,
    unInvoicedAmount: round2(unInvoicedCents / 100),
    financialFlowAmount: round2(financialFlowCents / 100),
    financialFlowCount,
    estimatedOrdersCount,
    invoiceCount,
  };
}
