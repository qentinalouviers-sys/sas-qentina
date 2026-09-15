/**
 * tools.ts — Les outils que QENTINA expose à un agent IA.
 *
 * ── Ce qu'un agent attend d'une API, et qu'un écran ne fournit pas ──
 *
 * Un agent ne lit pas un tableau : il appelle un outil, reçoit du JSON, et
 * doit pouvoir répondre SANS refaire le calcul. Quatre règles en découlent,
 * appliquées par chaque outil de ce fichier :
 *
 *  1. **Une phrase de synthèse en français** accompagne toute réponse. Un
 *     petit modèle qui reçoit `{ca_ht: 18234.55}` invente le commentaire ;
 *     celui qui reçoit la phrase la recopie. C'est la différence entre un
 *     chiffre juste et un chiffre juste bien présenté.
 *  2. **Tout est borné.** Chaque liste a un plafond et annonce `truncated`.
 *     Une réponse de 4 000 lignes ne fait pas déborder la fenêtre de contexte,
 *     elle la remplit de bruit et fait perdre le fil au modèle.
 *  3. **Les erreurs sont des instructions.** « Mois clôturé : rouvre-le depuis
 *     le P&L ou date l'écriture du mois courant » se corrige tout seul au tour
 *     suivant. « 500 Internal Server Error » fait inventer une réponse.
 *  4. **Les écritures sont idempotentes et rejouables.** Un agent réessaie :
 *     une clé d'idempotence en base (trajets) ou un contrôle d'unicité (compte
 *     courant) garantit qu'un second appel ne duplique rien.
 *
 * ── Ce que l'agent ne peut PAS faire ──
 *
 * Les outils d'écriture sont limités à deux gestes déjà verrouillés en base :
 * enregistrer des trajets détectés, et rattacher un virement au compte courant.
 * Tout le reste est en lecture. Ce n'est pas de la timidité : un agent qui se
 * trompe sur une facture ou une clôture produit une comptabilité fausse que
 * personne ne relit. Les verrous (mois clôturé, compte courant jamais débiteur,
 * anti-doublon) s'appliquent de toute façon — l'agent emprunte exactement les
 * mêmes chemins que l'écran.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { monthBounds, monthLabel, isMonthOver } from '@/lib/months';
import { collectInterventionFacts, detectInterventions } from '@/lib/interventions';
import { buildSnapshot, checkClosure } from '@/lib/closures';
import { computeTva } from '@/lib/tva';
import { round2 } from '@/lib/accounting';
import {
  checkCcaOperation, describeCcaViolation, analyseCcaReconciliation,
  mergeTransferTerms, type CcaMovementRow, type CcaBankLine, type CcaAssocie,
} from '@/lib/cca';
import {
  mergeConfig, computeTotals, buildTripCandidates, analyseCoverage, candidateNote,
  driverLabel, type InvoiceLike, type BankLineLike,
} from '@/lib/mileage';
import type { ToolSchema } from './schema';

export interface ToolContext {
  supabase: SupabaseClient;
  /** Date du jour en ISO — paramétrable, ce qui rend les outils testables. */
  today: string;
}

export interface ToolResult {
  /** Réponse déjà rédigée, en français. L'agent peut la citer telle quelle. */
  summary: string;
  data: Record<string, unknown>;
  /** Vrai quand une liste a été coupée par `limit`. */
  truncated?: boolean;
  /** Suites possibles, nommées par leur outil : de quoi enchaîner sans deviner. */
  next?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  schema: ToolSchema;
  /** 'read' ne modifie rien. 'write' exige une clé portant la portée write. */
  scope: 'read' | 'write';
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Erreur destinée au modèle : le message dit quoi faire, pas ce qui a planté. */
export class ToolError extends Error {
  constructor(message: string, readonly code = 'invalid_request') {
    super(message);
    this.name = 'ToolError';
  }
}

const eur = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Le mois demandé, ou le mois en cours. Refuse un mois futur, qui n'a rien à dire. */
function resolveMonth(args: Record<string, unknown>, ctx: ToolContext): string {
  const month = (args.month as string) || ctx.today.slice(0, 7);
  if (month > ctx.today.slice(0, 7)) {
    throw new ToolError(
      `Le mois ${month} n'a pas encore commencé. Demande un mois écoulé ou le mois en cours (${ctx.today.slice(0, 7)}).`,
      'out_of_range',
    );
  }
  return month;
}

const MONTH_PROP = {
  type: 'string' as const,
  format: 'month' as const,
  description: 'Mois au format AAAA-MM. Par défaut : le mois en cours.',
};
const LIMIT_PROP = (def: number, max: number) => ({
  type: 'integer' as const,
  description: `Nombre maximum de lignes renvoyées (défaut ${def}, plafond ${max}).`,
  minimum: 1,
  maximum: max,
  default: def,
});

// ════════════════════════════════════════════════════════════════════════════
//  Lecture
// ════════════════════════════════════════════════════════════════════════════

const getBusinessHealth: AgentTool = {
  name: 'get_business_health',
  description:
    "L'état de santé du restaurant : tout ce qui rend un chiffre faux ou coûte de l'argent, "
    + "classé par gravité (critique, important, à vérifier). À appeler EN PREMIER quand on demande "
    + "« est-ce que tout va bien », « qu'est-ce que je dois faire », ou avant de clôturer un mois. "
    + "Chaque point porte son constat chiffré, son impact et l'action à mener.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      month: MONTH_PROP,
      severity: {
        type: 'string',
        enum: ['critique', 'important', 'a_verifier'],
        description: "Ne renvoyer que cette gravité. Par défaut : toutes.",
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const month = resolveMonth(args, ctx);
    const { start, end } = monthBounds(month);
    const facts = await collectInterventionFacts(ctx.supabase, { start, end, today: ctx.today });
    const all = detectInterventions(facts);
    const filtered = args.severity ? all.filter(i => i.severity === args.severity) : all;

    const counts = {
      critique: all.filter(i => i.severity === 'critique').length,
      important: all.filter(i => i.severity === 'important').length,
      a_verifier: all.filter(i => i.severity === 'a_verifier').length,
    };
    const summary = all.length === 0
      ? `Rien à signaler sur ${monthLabel(month)} : aucun point ouvert.`
      : `${monthLabel(month)} — ${counts.critique} point(s) critique(s), ${counts.important} important(s), `
        + `${counts.a_verifier} à vérifier. ${all[0].title}.`;

    return {
      summary,
      data: {
        month,
        counts,
        interventions: filtered.map(i => ({
          id: i.id, severity: i.severity, title: i.title,
          impact: i.impact, action: i.action, amount: i.amount ?? null, page: i.href,
        })),
      },
      next: counts.critique > 0 ? ['get_monthly_summary', 'get_closure_status'] : undefined,
    };
  },
};

const getMonthlySummary: AgentTool = {
  name: 'get_monthly_summary',
  description:
    "Les chiffres d'un mois : chiffre d'affaires HT et TTC, nombre de commandes, achats, "
    + "coût matières (et s'il est mesuré par inventaire ou seulement estimé), variation de stock, "
    + "TVA collectée, déductible et nette. Ce sont exactement les chiffres du P&L.",
  scope: 'read',
  schema: { type: 'object', properties: { month: MONTH_PROP }, additionalProperties: false },
  async handler(args, ctx) {
    const month = resolveMonth(args, ctx);
    const snap = await buildSnapshot(ctx.supabase, month);
    const foodCost = snap.ca_ht > 0 ? round2((snap.cogs / snap.ca_ht) * 100) : null;
    const mesure = snap.cogs_method === 'inventaire';

    return {
      summary:
        `${monthLabel(month)} : ${eur(snap.ca_ttc)} TTC (${eur(snap.ca_ht)} HT) sur ${snap.orders} commandes. `
        + `Coût matières ${foodCost === null ? 'non calculable' : `${foodCost} %`} `
        + `(${mesure ? 'mesuré par inventaire' : 'estimé sur les achats, faute d\'inventaire'}). `
        + `TVA nette ${eur(snap.tva_nette)}.`,
      data: {
        month,
        ...snap,
        food_cost_percent: foodCost,
        cogs_is_measured: mesure,
      },
      next: ['get_vat_report', 'get_closure_status'],
    };
  },
};

const getVatReport: AgentTool = {
  name: 'get_vat_report',
  description:
    "Déclaration de TVA d'un mois : collectée ventilée par taux (5,5 %, 10 %, 20 %), déductible "
    + "sur factures, et solde net à payer ou crédit. Précise la part de TVA collectée non ventilée.",
  scope: 'read',
  schema: { type: 'object', properties: { month: MONTH_PROP }, additionalProperties: false },
  async handler(args, ctx) {
    const month = resolveMonth(args, ctx);
    const { start, end } = monthBounds(month);
    const tva = await computeTva(ctx.supabase, start, end);

    return {
      summary:
        `TVA ${monthLabel(month)} : ${eur(tva.collectedTva)} collectée, ${eur(tva.deductibleTva)} déductible, `
        + `soit ${tva.netTva >= 0 ? `${eur(tva.netTva)} à payer` : `${eur(-tva.netTva)} de crédit`}.`
        + (tva.collectedTvaBreakdown.nonVentile > 0
          ? ` ${eur(tva.collectedTvaBreakdown.nonVentile)} de TVA collectée ne sont pas ventilés par taux : à instruire avant de déclarer.`
          : '')
        + (tva.unInvoicedCount > 0
          ? ` ${tva.unInvoicedCount} dépense(s) sans facture représentent ${eur(tva.recoverableIfInvoiced)} de TVA non récupérée.`
          : ''),
      data: { month, ...tva },
    };
  },
};

const listInvoices: AgentTool = {
  name: 'list_invoices',
  description:
    "Les factures fournisseurs d'une période, les plus récentes d'abord. Filtrable par fournisseur "
    + "et par mode de paiement. Pour le détail des lignes d'une facture, enchaîner sur get_invoice.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', format: 'date', description: 'Date de début incluse (AAAA-MM-JJ).' },
      to: { type: 'string', format: 'date', description: 'Date de fin incluse (AAAA-MM-JJ).' },
      supplier: { type: 'string', description: "Fragment du nom du fournisseur (insensible à la casse)." },
      payment_method: {
        type: 'string', enum: ['bank', 'cash', 'card_perso'],
        description: "Mode de règlement : bank (compte société), cash (espèces), card_perso (carte d'un associé).",
      },
      limit: LIMIT_PROP(50, 200),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 50);
    let q = ctx.supabase
      .from('invoices')
      .select('id, date, invoice_number, total_ht, total_ttc, payment_method, accounting_ref, supplier:suppliers(name)')
      .order('date', { ascending: false })
      .limit(limit + 1);

    if (args.from) q = q.gte('date', args.from as string);
    if (args.to) q = q.lte('date', args.to as string);
    if (args.payment_method) q = q.eq('payment_method', args.payment_method as string);

    const { data, error } = await q;
    if (error) throw new ToolError(`Lecture des factures impossible : ${error.message}`, 'database_error');

    let rows = (data ?? []).map(r => ({
      id: r.id,
      date: r.date,
      invoice_number: r.invoice_number,
      supplier: (Array.isArray(r.supplier) ? r.supplier[0]?.name : (r.supplier as { name?: string } | null)?.name) ?? null,
      total_ht: r.total_ht,
      total_ttc: r.total_ttc,
      payment_method: r.payment_method,
      accounting_ref: r.accounting_ref,
    }));

    // Le filtre par fournisseur porte sur une relation : Supabase ne sait pas
    // le faire dans la même requête sans jointure explicite, on filtre ici.
    if (args.supplier) {
      const needle = String(args.supplier).toLowerCase();
      rows = rows.filter(r => (r.supplier ?? '').toLowerCase().includes(needle));
    }

    const truncated = rows.length > limit;
    rows = rows.slice(0, limit);
    const total = round2(rows.reduce((s, r) => s + (Number(r.total_ttc) || 0), 0));

    return {
      summary: rows.length === 0
        ? 'Aucune facture ne correspond à ces critères.'
        : `${rows.length} facture(s)${truncated ? ' (liste tronquée)' : ''}, ${eur(total)} TTC au total.`,
      data: { invoices: rows, count: rows.length, total_ttc: total },
      truncated,
    };
  },
};

const getInvoice: AgentTool = {
  name: 'get_invoice',
  description: "Une facture et le détail de ses lignes (désignation, quantité, prix, catégorie).",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', format: 'uuid', description: "Identifiant de la facture, obtenu via list_invoices." },
    },
    required: ['invoice_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = args.invoice_id as string;
    const [{ data: inv, error }, { data: lines }] = await Promise.all([
      ctx.supabase.from('invoices')
        .select('id, date, invoice_number, total_ht, total_ttc, payment_method, accounting_ref, accounting_class, type_document, tva_recoverable, supplier:suppliers(name)')
        .eq('id', id).maybeSingle(),
      ctx.supabase.from('invoice_lines')
        .select('designation, quantity, unit, unit_price_ht, total_ht, category')
        .eq('invoice_id', id),
    ]);

    if (error) throw new ToolError(`Lecture impossible : ${error.message}`, 'database_error');
    if (!inv) throw new ToolError(`Aucune facture avec l'identifiant ${id}. Utilise list_invoices pour trouver le bon.`, 'not_found');

    const supplier = (Array.isArray(inv.supplier) ? inv.supplier[0]?.name : (inv.supplier as { name?: string } | null)?.name) ?? 'fournisseur inconnu';
    return {
      summary: `Facture ${inv.invoice_number || 'sans numéro'} — ${supplier}, ${inv.date}, ${eur(Number(inv.total_ttc) || 0)} TTC, ${(lines ?? []).length} ligne(s).`,
      data: { invoice: { ...inv, supplier }, lines: lines ?? [] },
    };
  },
};

const listBankTransactions: AgentTool = {
  name: 'list_bank_transactions',
  description:
    "Les écritures du compte bancaire, les plus récentes d'abord. Filtrable par période, statut "
    + "(pending_invoice = en attente de facture, facture_ok, reconciled, ignored), sens (débit/crédit) "
    + "et fragment de libellé.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', format: 'date', description: 'Date de début incluse (AAAA-MM-JJ).' },
      to: { type: 'string', format: 'date', description: 'Date de fin incluse (AAAA-MM-JJ).' },
      status: {
        type: 'string', enum: ['pending_invoice', 'facture_ok', 'reconciled', 'ignored'],
        description: 'Statut de rapprochement.',
      },
      direction: {
        type: 'string', enum: ['debit', 'credit'],
        description: 'debit = sortie d\'argent, credit = entrée.',
      },
      search: { type: 'string', description: 'Fragment de libellé bancaire (insensible à la casse).' },
      limit: LIMIT_PROP(50, 200),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 50);
    let q = ctx.supabase
      .from('bank_transactions')
      .select('id, date, description, amount, category, status, accounting_class, invoice_id')
      .order('date', { ascending: false })
      .limit(limit + 1);

    if (args.from) q = q.gte('date', args.from as string);
    if (args.to) q = q.lte('date', args.to as string);
    if (args.status) q = q.eq('status', args.status as string);
    if (args.direction === 'debit') q = q.lt('amount', 0);
    if (args.direction === 'credit') q = q.gt('amount', 0);
    if (args.search) q = q.ilike('description', `%${String(args.search).replace(/[%_]/g, '')}%`);

    const { data, error } = await q;
    if (error) throw new ToolError(`Lecture du relevé impossible : ${error.message}`, 'database_error');

    const all = data ?? [];
    const truncated = all.length > limit;
    const rows = all.slice(0, limit);
    const debits = round2(rows.filter(r => (r.amount ?? 0) < 0).reduce((s, r) => s + Math.abs(r.amount ?? 0), 0));
    const credits = round2(rows.filter(r => (r.amount ?? 0) > 0).reduce((s, r) => s + (r.amount ?? 0), 0));

    return {
      summary: rows.length === 0
        ? 'Aucune écriture bancaire ne correspond à ces critères.'
        : `${rows.length} écriture(s)${truncated ? ' (liste tronquée)' : ''} : ${eur(debits)} de sorties, ${eur(credits)} d'entrées.`,
      data: { transactions: rows, count: rows.length, debits, credits },
      truncated,
    };
  },
};

const getPartnerAccounts: AgentTool = {
  name: 'get_partner_accounts',
  description:
    "Comptes courants d'associés : solde de chacun, et l'état du rapprochement avec les virements "
    + "bancaires sortants. Signale les virements versés à un associé qui ne sont pas portés au compte "
    + "courant (le solde est alors surévalué) et ceux portés deux fois. Un solde négatif est interdit "
    + "au dirigeant (art. L.225-43 du code de commerce).",
  scope: 'read',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    const [movements, bank, suppliers, termsRes] = await Promise.all([
      fetchAllRows<CcaMovementRow>((f0, f1) => ctx.supabase.from('mouvements_cca')
        .select('id, date, associe, sens, sous_type, montant, rapproche_banque, bank_transaction_id, note')
        .range(f0, f1)),
      fetchAllRows<CcaBankLine>((f0, f1) => ctx.supabase.from('bank_transactions')
        .select('id, date, description, amount').range(f0, f1)),
      fetchAllRows<{ name: string }>((f0, f1) => ctx.supabase.from('suppliers').select('name').range(f0, f1)),
      ctx.supabase.from('app_settings').select('value').eq('key', 'cca_transfer_terms').maybeSingle(),
    ]);

    let terms = mergeTransferTerms(null);
    try { if (termsRes.data?.value) terms = mergeTransferTerms(JSON.parse(termsRes.data.value)); } catch { /* défauts */ }

    const balances: Record<string, number> = {};
    for (const m of movements) {
      const signed = m.sens === 'apport' ? Number(m.montant) : -Number(m.montant);
      balances[m.associe] = round2((balances[m.associe] ?? 0) + signed);
    }

    const rec = analyseCcaReconciliation(
      movements,
      bank.map(l => ({ ...l, description: l.description || '' })),
      terms,
      suppliers.map(s => s.name),
    );

    const soldes = Object.entries(balances).map(([associe, solde]) => ({ associe, solde }));
    const debiteur = soldes.filter(s => s.solde < 0);

    return {
      summary:
        soldes.map(s => `${driverLabel(s.associe)} : ${eur(s.solde)}`).join(' · ')
        + (rec.unlinked.length > 0
          ? ` — attention, ${rec.unlinked.length} virement(s) sortant(s) vers un associé ne sont pas portés au compte courant : ces soldes sont surévalués.`
          : ' — tous les virements identifiés sont rapprochés.')
        + (debiteur.length > 0 ? ` COMPTE DÉBITEUR : ${debiteur.map(d => driverLabel(d.associe)).join(', ')} — interdit au dirigeant.` : ''),
      data: {
        balances: soldes,
        movements_count: movements.length,
        reconciliation: {
          unlinked_transfers: rec.unlinked.map(u => ({
            bank_transaction_id: u.line.id, date: u.line.date,
            label: u.line.description, amount: Math.abs(u.line.amount), associe: u.associe,
          })),
          unlinked_total: rec.unlinkedTotal,
          unidentified_transfers: rec.unidentified.slice(0, 20).map(l => ({
            bank_transaction_id: l.id, date: l.date, label: l.description, amount: Math.abs(l.amount),
          })),
          double_linked_count: rec.doubleLinked.length,
          refunds_without_bank_count: rec.refundsWithoutBank.length,
        },
      },
      next: rec.unlinked.length > 0 ? ['link_bank_transfer_to_partner_account'] : undefined,
    };
  },
};

/** Charge tout ce qu'il faut pour reconstituer les déplacements d'une année. */
async function loadMileageYear(ctx: ToolContext, year: number) {
  const [tripRows, settingsRes, invoiceRows, bankRows] = await Promise.all([
    fetchAllRows<{ id: string; date: string; destination_key: string; label: string; distance_km: number; toll_amount: number; driver: string; source: string; cca_movement_id: string | null }>(
      (f0, f1) => ctx.supabase.from('mileage_trips').select('*').order('date').range(f0, f1)),
    ctx.supabase.from('app_settings').select('value').eq('key', 'mileage_config').maybeSingle(),
    fetchAllRows<{ id: string; date: string; invoice_number: string | null; payment_method: string | null; supplier: unknown }>(
      (f0, f1) => ctx.supabase.from('invoices')
        .select('id, date, invoice_number, payment_method, supplier:suppliers(name)')
        .gte('date', `${year - 1}-12-01`).lte('date', `${year}-12-31`).range(f0, f1)),
    fetchAllRows<{ date: string; description: string | null }>(
      (f0, f1) => ctx.supabase.from('bank_transactions')
        .select('date, description').lt('amount', 0)
        .gte('date', `${year}-01-01`).lte('date', `${year + 1}-12-31`).range(f0, f1)),
  ]);

  let config = mergeConfig(null);
  try { if (settingsRes.data?.value) config = mergeConfig(JSON.parse(settingsRes.data.value)); } catch { /* défauts */ }

  const invoices: InvoiceLike[] = invoiceRows.map(r => ({
    id: r.id, date: r.date, invoice_number: r.invoice_number, payment_method: r.payment_method,
    supplier_name: (r.supplier as { name?: string } | null)?.name || '',
  }));
  const bankLines: BankLineLike[] = bankRows.map(r => ({ date: r.date, description: r.description || '' }));
  const candidates = buildTripCandidates(invoices, bankLines, config, year);

  return { trips: tripRows, config, candidates };
}

const getMileageReport: AgentTool = {
  name: 'get_mileage_report',
  description:
    "Frais kilométriques d'une année : distance, indemnité au barème fiscal, péages, et ce qui reste "
    + "à porter au compte courant. Donne aussi le contrôle de couverture — les déplacements attestés "
    + "par une facture ou par le relevé bancaire qui n'ont pas encore de trajet enregistré.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      year: { type: 'integer', format: 'year', description: "Année civile. Par défaut : l'année en cours." },
      driver: { type: 'string', enum: ['justine', 'yohan'], description: 'Conducteur. Par défaut : celui des réglages.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const year = Number(args.year ?? ctx.today.slice(0, 4));
    const { trips, config, candidates } = await loadMileageYear(ctx, year);
    const driver = (args.driver as string) || config.defaultDriver;

    const yearTrips = trips.filter(t => t.date?.startsWith(String(year)) && t.driver === driver);
    const totals = computeTotals(yearTrips, config);
    const coverage = analyseCoverage(candidates, trips, year);

    return {
      summary:
        `${driverLabel(driver)}, ${year} : ${totals.tripCount} trajet(s), ${totals.totalKm.toLocaleString('fr-FR')} km, `
        + `${eur(totals.total)} à rembourser (barème ${config.baremeYear}, ${totals.bracket}).`
        + (coverage.missing.length > 0
          ? ` ${coverage.missing.length} déplacement(s) attesté(s) par une pièce n'ont pas encore de trajet enregistré.`
          : ' Tous les déplacements attestés sont enregistrés.'),
      data: {
        year, driver, totals,
        vehicle: config.vehicle,
        bareme_year: config.baremeYear,
        coverage: {
          candidates: candidates.length,
          covered: coverage.counts.covered,
          missing: coverage.missing.map(c => ({
            date: c.date, destination: c.dest.label, km: c.dest.km,
            attested_by: c.fromInvoice && c.fromBank ? 'facture+banque' : c.fromInvoice ? 'facture' : 'banque',
            justification: candidateNote(c),
          })),
          invoice_only: coverage.counts.invoiceOnly,
          bank_only: coverage.counts.bankOnly,
          trips_without_proof: coverage.unsupported.length,
        },
      },
      next: coverage.missing.length > 0 ? ['record_missing_mileage_trips'] : undefined,
    };
  },
};

const getClosureStatus: AgentTool = {
  name: 'get_closure_status',
  description:
    "Dit si un mois est clôturé, et s'il peut l'être : un mois ne se clôture que s'il est terminé et "
    + "qu'aucun point critique n'est ouvert. Renvoie les points bloquants. La clôture elle-même reste "
    + "un geste humain — elle n'est pas exposée aux agents.",
  scope: 'read',
  schema: { type: 'object', properties: { month: MONTH_PROP }, additionalProperties: false },
  async handler(args, ctx) {
    const month = resolveMonth(args, ctx);
    const { start } = monthBounds(month);
    const [{ data: closure }, check] = await Promise.all([
      ctx.supabase.from('closures').select('closed_at, reopened_at, closed_by').eq('month', start).maybeSingle(),
      checkClosure(ctx.supabase, month, ctx.today),
    ]);

    const isClosed = Boolean(closure?.closed_at && !closure?.reopened_at);
    return {
      summary: isClosed
        ? `${monthLabel(month)} est clôturé : les écritures de ce mois sont refusées par la base.`
        : check.notOver
          ? `${monthLabel(month)} n'est pas terminé : rien à clôturer avant le ${monthBounds(month).end}.`
          : check.canClose
            ? `${monthLabel(month)} peut être clôturé : aucun point critique ouvert.`
            : `${monthLabel(month)} ne peut pas être clôturé : ${check.blocking.length} point(s) critique(s) à régler d'abord.`,
      data: {
        month, is_closed: isClosed, can_close: check.canClose, month_over: !check.notOver,
        closed_at: closure?.closed_at ?? null,
        blocking: check.blocking.map(i => ({ id: i.id, title: i.title, action: i.action })),
      },
    };
  },
};

const searchSuppliers: AgentTool = {
  name: 'search_suppliers',
  description: "Cherche un fournisseur par fragment de nom. Utile pour lever une ambiguïté avant list_invoices.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Fragment de nom. Vide = tous les fournisseurs.' },
      limit: LIMIT_PROP(25, 100),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 25);
    let q = ctx.supabase.from('suppliers').select('id, name').order('name').limit(limit + 1);
    if (args.query) q = q.ilike('name', `%${String(args.query).replace(/[%_]/g, '')}%`);

    const { data, error } = await q;
    if (error) throw new ToolError(`Lecture impossible : ${error.message}`, 'database_error');

    const all = data ?? [];
    const truncated = all.length > limit;
    const rows = all.slice(0, limit);
    return {
      summary: rows.length === 0
        ? `Aucun fournisseur ne correspond à « ${args.query ?? ''} ».`
        : `${rows.length} fournisseur(s) : ${rows.slice(0, 8).map(r => r.name).join(', ')}${rows.length > 8 ? '…' : ''}.`,
      data: { suppliers: rows },
      truncated,
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
//  Écriture — deux gestes, déjà verrouillés en base
// ════════════════════════════════════════════════════════════════════════════

const recordMissingMileageTrips: AgentTool = {
  name: 'record_missing_mileage_trips',
  description:
    "Enregistre les déplacements attestés par une facture ou par le relevé bancaire qui n'ont pas "
    + "encore de trajet. Idempotent : relancer n'ajoute jamais de doublon (clé jour + destination). "
    + "Les mois clôturés sont laissés de côté et signalés. Appeler d'abord get_mileage_report, et "
    + "utiliser dry_run pour voir ce qui serait créé sans rien écrire.",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      year: { type: 'integer', format: 'year', description: "Année civile. Par défaut : l'année en cours." },
      driver: { type: 'string', enum: ['justine', 'yohan'], description: 'Conducteur au nom duquel enregistrer.' },
      dry_run: { type: 'boolean', description: 'true = simuler sans écrire. Défaut : false.', default: false },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const year = Number(args.year ?? ctx.today.slice(0, 4));
    const { trips, config, candidates } = await loadMileageYear(ctx, year);
    const driver = (args.driver as string) || config.defaultDriver;
    const coverage = analyseCoverage(candidates, trips, year);

    if (coverage.missing.length === 0) {
      return {
        summary: `Rien à enregistrer : les ${candidates.length} déplacements ${year} attestés ont déjà leur trajet.`,
        data: { year, added: 0, missing: 0 },
      };
    }

    const { data: closures } = await ctx.supabase.from('closures').select('month').is('reopened_at', null);
    const closed = new Set((closures ?? []).map(c => String(c.month).slice(0, 7)));
    const open = coverage.missing.filter(c => !closed.has(c.date.slice(0, 7)));
    const skippedClosed = coverage.missing.length - open.length;

    if (args.dry_run) {
      return {
        summary: `Simulation : ${open.length} trajet(s) seraient enregistrés au nom de ${driverLabel(driver)}`
          + (skippedClosed > 0 ? `, ${skippedClosed} laissé(s) de côté (mois clôturé).` : '.'),
        data: {
          year, dry_run: true, would_add: open.length, skipped_closed: skippedClosed,
          trips: open.map(c => ({ date: c.date, destination: c.dest.label, km: c.dest.km })),
        },
      };
    }

    if (open.length === 0) {
      throw new ToolError(
        `Les ${skippedClosed} déplacement(s) à enregistrer tombent tous dans des mois clôturés. `
        + `Rouvre le mois depuis le P&L (geste humain, motivé et journalisé) ou laisse-les de côté.`,
        'month_closed',
      );
    }

    const { data, error } = await ctx.supabase
      .from('mileage_trips')
      .upsert(
        open.map(c => ({
          date: c.date, destination_key: c.dest.key, label: c.dest.label,
          distance_km: c.dest.km, toll_amount: c.dest.toll, driver,
          invoice_id: c.invoiceId, source: 'auto', note: candidateNote(c) || null, dedupe_key: c.key,
        })),
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      )
      .select('id, date, label');

    if (error) throw new ToolError(`Enregistrement refusé : ${error.message}`, 'database_error');

    const added = data?.length ?? 0;
    return {
      summary: `${added} trajet(s) enregistré(s) au nom de ${driverLabel(driver)} pour ${year}`
        + (skippedClosed > 0 ? `, ${skippedClosed} laissé(s) de côté (mois clôturé).` : '.'),
      data: { year, driver, added, skipped_closed: skippedClosed, trips: data ?? [] },
      next: ['get_mileage_report'],
    };
  },
};

const linkBankTransfer: AgentTool = {
  name: 'link_bank_transfer_to_partner_account',
  description:
    "Porte un virement bancaire sortant au compte courant d'un associé (remboursement). Les trois "
    + "verrous s'appliquent : le compte ne peut pas devenir débiteur, un virement ne peut pas être "
    + "porté deux fois, un mois clôturé refuse l'écriture. Obtenir les identifiants via "
    + "get_partner_accounts (unlinked_transfers).",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      bank_transaction_id: { type: 'string', format: 'uuid', description: "Identifiant de l'écriture bancaire (get_partner_accounts)." },
      associe: { type: 'string', enum: ['justine', 'yohan'], description: "Associé remboursé." },
      dry_run: { type: 'boolean', description: 'true = vérifier sans écrire. Défaut : false.', default: false },
    },
    required: ['bank_transaction_id', 'associe'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const txId = args.bank_transaction_id as string;
    const associe = args.associe as CcaAssocie;

    const [{ data: tx }, { data: existing }, movements] = await Promise.all([
      ctx.supabase.from('bank_transactions').select('id, date, description, amount').eq('id', txId).maybeSingle(),
      ctx.supabase.from('mouvements_cca').select('id, date, associe, montant').eq('bank_transaction_id', txId).maybeSingle(),
      fetchAllRows<CcaMovementRow>((f0, f1) => ctx.supabase.from('mouvements_cca')
        .select('id, date, associe, sens, montant, created_at').range(f0, f1)),
    ]);

    if (!tx) throw new ToolError(`Aucune écriture bancaire avec l'identifiant ${txId}.`, 'not_found');
    if ((tx.amount ?? 0) >= 0) {
      throw new ToolError(
        `Cette écriture est un encaissement (${eur(tx.amount ?? 0)}), pas un virement sortant : `
        + `elle ne peut pas rembourser un compte courant.`,
        'invalid_request',
      );
    }
    if (existing) {
      throw new ToolError(
        `Ce virement est déjà porté au compte courant de ${driverLabel(existing.associe)} `
        + `(${eur(Number(existing.montant))} au ${existing.date}). L'enregistrer une seconde fois `
        + `débiterait deux fois le même versement.`,
        'already_linked',
      );
    }

    const montant = round2(Math.abs(tx.amount ?? 0));
    const violation = checkCcaOperation(movements, {
      type: 'insert',
      movement: { date: tx.date, associe, sens: 'remboursement', montant },
    });
    if (violation) throw new ToolError(describeCcaViolation(violation), 'cca_debtor');

    if (args.dry_run) {
      return {
        summary: `Simulation : ${eur(montant)} seraient portés au compte courant de ${driverLabel(associe)} au ${tx.date}. Aucun verrou ne s'y oppose.`,
        data: { dry_run: true, bank_transaction_id: txId, associe, montant, date: tx.date },
      };
    }

    const { data: movement, error } = await ctx.supabase
      .from('mouvements_cca')
      .insert({
        date: tx.date, associe, sens: 'remboursement', sous_type: 'avance_tresorerie',
        montant, rapproche_banque: true, date_virement_banque: tx.date,
        note: `Virement bancaire : ${tx.description ?? ''} [agent]`,
        bank_transaction_id: txId,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') throw new ToolError('Ce virement vient d\'être rapproché ailleurs : rien n\'a été enregistré en double.', 'already_linked');
      throw new ToolError(`Écriture refusée : ${error.message}`, 'database_error');
    }

    await ctx.supabase.from('bank_transactions')
      .update({ status: 'reconciled', accounting_class: '455' })
      .eq('id', txId);

    return {
      summary: `${eur(montant)} portés au compte courant de ${driverLabel(associe)} au ${tx.date}.`,
      data: { movement_id: movement?.id, bank_transaction_id: txId, associe, montant, date: tx.date },
      next: ['get_partner_accounts'],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════

export const AGENT_TOOLS: readonly AgentTool[] = [
  getBusinessHealth,
  getMonthlySummary,
  getVatReport,
  listInvoices,
  getInvoice,
  listBankTransactions,
  getPartnerAccounts,
  getMileageReport,
  getClosureStatus,
  searchSuppliers,
  recordMissingMileageTrips,
  linkBankTransfer,
];

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find(t => t.name === name);
}

/** Noms des outils les plus proches, pour rattraper une faute de frappe du modèle. */
export function suggestTools(name: string, max = 3): string[] {
  const needle = name.toLowerCase().replace(/[^a-z]/g, '');
  return AGENT_TOOLS
    .map(t => {
      const candidate = t.name.replace(/[^a-z]/g, '');
      const common = [...new Set(needle)].filter(ch => candidate.includes(ch)).length;
      return { name: t.name, score: common };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(t => t.name);
}

export { isMonthOver };
