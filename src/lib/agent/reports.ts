/**
 * reports.ts — Agrégations pures derrière les outils de pilotage.
 *
 * Rien ici ne touche à la base : les outils lisent, ces fonctions comptent.
 * C'est ce qui permet de les tester dans `npm run verify:compta` avec des
 * données synthétiques, et de garantir qu'un agent et un écran qui lisent
 * les mêmes lignes rendent le même chiffre.
 */

import { bankAmountHt, isFinancialFlow, orderHtAmount, makeInvoiceMatcher, round2 } from '@/lib/accounting';

// ── Ventes ─────────────────────────────────────────────────────────────────

export interface SalesOrderRow { id: string; service: string; net_amount: number | null; raw_data?: unknown }
export interface SalesItemRow { order_id: string; name: string | null; quantity: number | null; total_price: number | null; category_name: string | null }

export interface SalesReport {
  orders: number;
  ca_ttc: number;
  ca_ht: number;
  ticket_moyen_ttc: number;
  days_with_sales: number;
  by_day: { date: string; orders: number; ca_ttc: number }[];
  best_day: { date: string; orders: number; ca_ttc: number } | null;
  by_weekday: { weekday: string; orders: number; ca_ttc: number }[];
  top_items: { name: string; quantity: number; ca_ttc: number }[];
  by_category: { category: string; quantity: number; ca_ttc: number }[];
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * Le rapport de ventes d'une période. `top` borne les classements.
 * Les montants d'articles sont TTC (Square) ; le CA HT vient de la taxe lue
 * dans les données brutes, jamais d'un taux supposé.
 */
export function aggregateSales(orders: readonly SalesOrderRow[], items: readonly SalesItemRow[], top = 10): SalesReport {
  const byDay = new Map<string, { orders: number; ca: number }>();
  const byWeekday = new Map<number, { orders: number; ca: number }>();
  let ttc = 0, ht = 0;

  for (const o of orders) {
    const amount = o.net_amount || 0;
    ttc += amount;
    ht += orderHtAmount(o);
    const day = String(o.service).slice(0, 10);
    const d = byDay.get(day) ?? { orders: 0, ca: 0 };
    d.orders++; d.ca += amount; byDay.set(day, d);
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    const w = byWeekday.get(wd) ?? { orders: 0, ca: 0 };
    w.orders++; w.ca += amount; byWeekday.set(wd, w);
  }

  const byItem = new Map<string, { quantity: number; ca: number }>();
  const byCat = new Map<string, { quantity: number; ca: number }>();
  for (const it of items) {
    const name = (it.name || 'Article').trim();
    const q = Number(it.quantity) || 0;
    const p = Number(it.total_price) || 0;
    const i = byItem.get(name) ?? { quantity: 0, ca: 0 };
    i.quantity += q; i.ca += p; byItem.set(name, i);
    const cat = (it.category_name || 'Sans catégorie').trim();
    const c = byCat.get(cat) ?? { quantity: 0, ca: 0 };
    c.quantity += q; c.ca += p; byCat.set(cat, c);
  }

  const days = [...byDay].map(([date, d]) => ({ date, orders: d.orders, ca_ttc: round2(d.ca) })).sort((a, b) => a.date.localeCompare(b.date));
  const best = days.length > 0 ? days.reduce((m, d) => (d.ca_ttc > m.ca_ttc ? d : m), days[0]) : null;

  return {
    orders: orders.length,
    ca_ttc: round2(ttc),
    ca_ht: round2(ht),
    ticket_moyen_ttc: orders.length > 0 ? round2(ttc / orders.length) : 0,
    days_with_sales: days.length,
    by_day: days,
    best_day: best,
    by_weekday: [1, 2, 3, 4, 5, 6, 0]
      .filter(wd => byWeekday.has(wd))
      .map(wd => ({ weekday: WEEKDAYS[wd], orders: byWeekday.get(wd)!.orders, ca_ttc: round2(byWeekday.get(wd)!.ca) })),
    top_items: [...byItem].map(([name, i]) => ({ name, quantity: i.quantity, ca_ttc: round2(i.ca) }))
      .sort((a, b) => b.ca_ttc - a.ca_ttc).slice(0, top),
    by_category: [...byCat].map(([category, c]) => ({ category, quantity: c.quantity, ca_ttc: round2(c.ca) }))
      .sort((a, b) => b.ca_ttc - a.ca_ttc),
  };
}

// ── Compte de résultat par poste ───────────────────────────────────────────

export interface PnlLineRow { category: string | null; total_ht: number | null }
export interface PnlBankRow { id: string; date: string; description: string | null; amount: number | null; category: string | null; invoice_id: string | null }
export interface PnlInvoiceRow { id: string; total_ttc: number | null }

export interface PnlBreakdown {
  ca_ht: number;
  /** Achats (HT) : lignes de factures par catégorie + paiements fournisseurs non lettrés (HT indicatif). */
  achats: { alimentaire: number; boisson: number; emballage: number; materiel: number; autre: number; banque_sans_facture: number; total: number };
  /** Charges bancaires hors achats, par catégorie, en HT indicatif. */
  charges: { category: string; ht: number; ttc: number; count: number }[];
  charges_total_ht: number;
  salaires: number;
  investissements: number;
  /** Écarté du résultat : prêts, apports, compte courant, retraits. */
  flux_financiers: { count: number; total: number };
  /** Encaissements bancaires classés « recette » — indicatif, le CA vient de Square. */
  encaissements_banque: number;
  /** CA HT − achats − charges − salaires. Les investissements n'y entrent pas. */
  resultat_exploitation_indicatif: number;
  /** Paiements bancaires écartés parce qu'égaux au TTC d'une facture de la période. */
  paiements_apparies_factures: number;
}

const ACHAT_CATS = ['alimentaire', 'boisson', 'emballage', 'materiel', 'autre'] as const;

/**
 * Le compte de résultat d'un mois tel que le P&L l'affiche : CA Square HT,
 * achats en HT (lignes de facture + paiements fournisseurs non lettrés, sans
 * double compte), charges par catégorie, salaires, investissements à part,
 * flux financiers écartés.
 */
export function aggregatePnl(input: {
  orders: readonly { net_amount: number | null; raw_data?: unknown }[];
  invoiceLines: readonly PnlLineRow[];
  invoices: readonly PnlInvoiceRow[];
  bank: readonly PnlBankRow[];
}): PnlBreakdown {
  const caHt = round2(input.orders.reduce((s, o) => s + orderHtAmount(o), 0));

  const achats = { alimentaire: 0, boisson: 0, emballage: 0, materiel: 0, autre: 0, banque_sans_facture: 0, total: 0 };
  for (const l of input.invoiceLines) {
    const cat = (ACHAT_CATS as readonly string[]).includes(l.category ?? '') ? (l.category as typeof ACHAT_CATS[number]) : 'autre';
    achats[cat] += l.total_ht || 0;
  }

  const matcher = makeInvoiceMatcher([...input.invoices]);
  const charges = new Map<string, { ht: number; ttc: number; count: number }>();
  let salaires = 0, investissements = 0, encaissements = 0, fluxCount = 0, fluxTotal = 0, apparies = 0;

  for (const t of input.bank) {
    const amount = t.amount || 0;
    if (isFinancialFlow(t.description ?? '', t.category)) { fluxCount++; fluxTotal += Math.abs(amount); continue; }
    if (amount > 0) { if (t.category === 'recette') encaissements += amount; continue; }
    if (t.invoice_id) continue; // déjà compté par sa facture
    const cat = t.category || 'autre';
    if (cat === 'variable_fournisseur') {
      if (matcher.alreadyInvoiced(t)) { apparies++; continue; }
      achats.banque_sans_facture += bankAmountHt(t, 'variable_fournisseur');
      continue;
    }
    if (cat === 'variable_salaire') { salaires += Math.abs(amount); continue; }
    if (cat === 'investissement') { investissements += Math.abs(amount); continue; }
    if (cat === 'recette') continue; // un débit classé recette : un remboursement client, hors charges
    const c = charges.get(cat) ?? { ht: 0, ttc: 0, count: 0 };
    c.ht += bankAmountHt(t); c.ttc += Math.abs(amount); c.count++; charges.set(cat, c);
  }

  for (const k of ACHAT_CATS) achats[k] = round2(achats[k]);
  achats.banque_sans_facture = round2(achats.banque_sans_facture);
  achats.total = round2(achats.alimentaire + achats.boisson + achats.emballage + achats.materiel + achats.autre + achats.banque_sans_facture);

  const chargesList = [...charges].map(([category, c]) => ({ category, ht: round2(c.ht), ttc: round2(c.ttc), count: c.count }))
    .sort((a, b) => b.ht - a.ht);
  const chargesTotal = round2(chargesList.reduce((s, c) => s + c.ht, 0));

  return {
    ca_ht: caHt,
    achats,
    charges: chargesList,
    charges_total_ht: chargesTotal,
    salaires: round2(salaires),
    investissements: round2(investissements),
    flux_financiers: { count: fluxCount, total: round2(fluxTotal) },
    encaissements_banque: round2(encaissements),
    resultat_exploitation_indicatif: round2(caHt - achats.total - chargesTotal - salaires),
    paiements_apparies_factures: apparies,
  };
}

// ── Lettrage facture ↔ mouvement bancaire ──────────────────────────────────

export interface LinkCheck {
  ok: boolean;
  /** Code de refus, ou null si le lettrage est possible. */
  code: 'not_debit' | 'tx_already_linked' | 'invoice_already_linked' | 'amount_mismatch' | null;
  message: string;
  /** Avertissements non bloquants (écart de date). */
  warnings: string[];
  amount_diff: number;
  days_apart: number | null;
}

const AMOUNT_TOLERANCE = 0.05;
const DATE_WARN_DAYS = 60;

/**
 * Les conditions d'un lettrage. Montant égal au centime (à 5 centimes près)
 * sauf `force`, qui accepte un paiement partiel ou groupé en le disant. Un
 * mouvement ou une facture déjà lettrés refusent : lettrer deux fois compte
 * deux fois.
 */
export function checkInvoiceLink(
  tx: { amount: number | null; date: string; invoice_id: string | null },
  invoice: { total_ttc: number | null; date: string },
  linkedTxOfInvoice: { id: string } | null,
  force = false,
): LinkCheck {
  const amount = tx.amount || 0;
  const diff = round2(Math.abs(Math.abs(amount) - (invoice.total_ttc || 0)));
  const days = tx.date && invoice.date
    ? Math.round(Math.abs(Date.parse(tx.date) - Date.parse(invoice.date)) / 86_400_000)
    : null;
  const warnings: string[] = [];
  if (days !== null && days > DATE_WARN_DAYS) warnings.push(`${days} jours séparent la facture du paiement : vérifie que c'est bien le bon.`);

  const eurs = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;
  if (amount >= 0) return { ok: false, code: 'not_debit', message: 'Ce mouvement est un encaissement : une facture fournisseur se lettre avec un débit.', warnings, amount_diff: diff, days_apart: days };
  if (tx.invoice_id) return { ok: false, code: 'tx_already_linked', message: 'Ce mouvement est déjà lettré avec une facture. Délie-le depuis l\'écran Banque avant d\'en lier une autre.', warnings, amount_diff: diff, days_apart: days };
  if (linkedTxOfInvoice) return { ok: false, code: 'invoice_already_linked', message: `Cette facture est déjà lettrée avec le mouvement ${linkedTxOfInvoice.id}. Une facture n'a qu'un paiement.`, warnings, amount_diff: diff, days_apart: days };
  if (diff > AMOUNT_TOLERANCE && !force) {
    return {
      ok: false, code: 'amount_mismatch',
      message: `Le paiement (${eurs(Math.abs(amount))}) ne correspond pas au TTC de la facture (${eurs(invoice.total_ttc || 0)}), écart ${eurs(diff)}. `
        + 'Si c\'est bien ce paiement (règlement partiel ou groupé), rappelle avec force: true.',
      warnings, amount_diff: diff, days_apart: days,
    };
  }
  if (diff > AMOUNT_TOLERANCE) warnings.push(`Lettrage forcé avec un écart de ${eurs(diff)}.`);
  return { ok: true, code: null, message: 'Lettrage possible.', warnings, amount_diff: diff, days_apart: days };
}
