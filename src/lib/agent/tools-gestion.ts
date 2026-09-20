/**
 * tools-gestion.ts — Outils de PILOTAGE (lecture) : ventes, compte de résultat
 * par poste, comptes courants en détail, mercuriale, coût des recettes, règles.
 *
 * Tous en lecture : ils comptent ce qui est en base et rendent une phrase de
 * synthèse. Les agrégations vivent dans `reports.ts`, testées à part.
 */

import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all';
import { monthBounds, monthLabel } from '@/lib/months';
import { round2 } from '@/lib/accounting';
import { calcRecipeCost } from '@/lib/recipes';
import { driverLabel } from '@/lib/mileage';
import { RECIPE_CATEGORY_LABELS } from '@/lib/utils';
import { aggregateSales, aggregatePnl, type SalesOrderRow, type SalesItemRow, type PnlBankRow } from './reports';
import { GUIDE_MARKDOWN } from './guide';
import { eur, resolveMonth, MONTH_PROP, LIMIT_PROP, ToolError, type AgentTool, type ToolContext } from './base';

const DATE_PROP = (what: string) => ({ type: 'string' as const, format: 'date' as const, description: `${what} (AAAA-MM-JJ).` });

/** Bornes d'une période : `month`, ou `from`/`to`, ou le mois en cours. */
function resolvePeriod(args: Record<string, unknown>, ctx: ToolContext): { start: string; end: string; label: string } {
  if (args.from || args.to) {
    const start = (args.from as string) || `${ctx.today.slice(0, 4)}-01-01`;
    const end = (args.to as string) || ctx.today;
    if (start > end) throw new ToolError(`La date de début (${start}) est après la date de fin (${end}).`, 'invalid_request');
    return { start, end, label: `du ${start} au ${end}` };
  }
  const month = resolveMonth(args, ctx);
  const { start, end } = monthBounds(month);
  return { start, end, label: monthLabel(month) };
}

const getSalesReport: AgentTool = {
  name: 'get_sales_report',
  description:
    "Les ventes de la caisse Square sur une période : chiffre d'affaires TTC et HT, nombre de commandes, "
    + "ticket moyen, chiffre par jour (meilleur jour), par jour de la semaine, articles les plus vendus "
    + "et ventilation par catégorie de carte. Répond à « quel a été le meilleur service », « combien de "
    + "margherita vendues », « le mardi vaut-il le coup ». Période : un mois, ou from/to.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      month: MONTH_PROP,
      from: DATE_PROP('Date de début incluse, à la place de month'),
      to: DATE_PROP('Date de fin incluse, à la place de month'),
      top: { type: 'integer', description: 'Nombre d\'articles dans le classement (défaut 10, plafond 50).', minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const { start, end, label } = resolvePeriod(args, ctx);
    const orders = await fetchAllRows<SalesOrderRow>((f0, f1) => ctx.supabase
      .from('square_orders').select('id, service, net_amount, raw_data')
      .gte('service', start).lte('service', end).range(f0, f1));
    const items = orders.length > 0
      ? await fetchAllRowsIn<SalesItemRow, string>(orders.map(o => o.id), (ids, f0, f1) => ctx.supabase
          .from('square_items').select('order_id, name, quantity, total_price, category_name')
          .in('order_id', ids).range(f0, f1))
      : [];

    const report = aggregateSales(orders, items, Number(args.top ?? 10));
    const top = report.top_items[0];
    return {
      summary: report.orders === 0
        ? `Aucune vente enregistrée ${label}. Si la caisse a tourné, la synchronisation Square est à vérifier (get_business_health).`
        : `Ventes ${label} : ${eur(report.ca_ttc)} TTC (${eur(report.ca_ht)} HT), ${report.orders} commandes sur `
          + `${report.days_with_sales} jour(s), ticket moyen ${eur(report.ticket_moyen_ttc)}.`
          + (report.best_day ? ` Meilleur jour : ${report.best_day.date} (${eur(report.best_day.ca_ttc)}).` : '')
          + (top ? ` Article n°1 : ${top.name} (${top.quantity} vendus, ${eur(top.ca_ttc)}).` : ''),
      data: { period: { start, end }, ...report },
      next: ['get_pnl_breakdown', 'get_recipe_costs'],
    };
  },
};

const getPnlBreakdown: AgentTool = {
  name: 'get_pnl_breakdown',
  description:
    "Le compte de résultat d'un mois par poste, tel que le P&L l'affiche : chiffre d'affaires HT Square, "
    + "achats HT (lignes de factures par catégorie + paiements fournisseurs sans facture), charges "
    + "bancaires par catégorie (loyer, assurances, abonnements, impôts…), salaires, investissements à "
    + "part, flux financiers écartés du résultat, et résultat d'exploitation indicatif. Pour « où part "
    + "l'argent », « combien de charges fixes ». Le HT des dépenses sans facture est indicatif.",
  scope: 'read',
  schema: { type: 'object', properties: { month: MONTH_PROP }, additionalProperties: false },
  async handler(args, ctx) {
    const month = resolveMonth(args, ctx);
    const { start, end } = monthBounds(month);
    const [orders, invoices, bank] = await Promise.all([
      fetchAllRows<{ net_amount: number | null; raw_data: unknown }>((f0, f1) => ctx.supabase
        .from('square_orders').select('net_amount, raw_data').gte('service', start).lte('service', end).range(f0, f1)),
      fetchAllRows<{ id: string; total_ttc: number | null }>((f0, f1) => ctx.supabase
        .from('invoices').select('id, total_ttc').gte('date', start).lte('date', end).range(f0, f1)),
      fetchAllRows<PnlBankRow>((f0, f1) => ctx.supabase
        .from('bank_transactions').select('id, date, description, amount, category, invoice_id')
        .gte('date', start).lte('date', end).range(f0, f1)),
    ]);
    const invoiceLines = invoices.length > 0
      ? await fetchAllRowsIn<{ category: string | null; total_ht: number | null }, string>(invoices.map(i => i.id), (ids, f0, f1) => ctx.supabase
          .from('invoice_lines').select('category, total_ht').in('invoice_id', ids).range(f0, f1))
      : [];

    const pnl = aggregatePnl({ orders, invoiceLines, invoices, bank });
    const foodCost = pnl.ca_ht > 0 ? round2((pnl.achats.total / pnl.ca_ht) * 100) : null;
    return {
      summary:
        `${monthLabel(month)} : CA ${eur(pnl.ca_ht)} HT, achats ${eur(pnl.achats.total)} HT`
        + (foodCost !== null ? ` (${foodCost} % du CA, sur les achats — pas le coût matières consommé)` : '')
        + `, charges ${eur(pnl.charges_total_ht)} HT, salaires ${eur(pnl.salaires)}, résultat d'exploitation indicatif ${eur(pnl.resultat_exploitation_indicatif)}.`
        + (pnl.investissements > 0 ? ` Investissements hors résultat : ${eur(pnl.investissements)}.` : '')
        + (pnl.flux_financiers.count > 0 ? ` ${pnl.flux_financiers.count} flux financier(s) écarté(s) (${eur(pnl.flux_financiers.total)}).` : ''),
      data: { month, food_cost_on_purchases_percent: foodCost, ...pnl },
      next: ['get_monthly_summary', 'get_vat_report', 'get_business_health'],
    };
  },
};

const listPartnerMovements: AgentTool = {
  name: 'list_partner_movements',
  description:
    "Le détail des mouvements de compte courant d'associé (apports, remboursements, factures payées de "
    + "sa poche), par ordre chronologique, avec le solde après chaque ligne. Filtrable par associé et "
    + "par période. Pour les soldes et le rapprochement, préférer get_partner_accounts.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      associe: { type: 'string', enum: ['justine', 'yohan'], description: 'Associé. Par défaut : les deux.' },
      from: DATE_PROP('Date de début incluse'),
      to: DATE_PROP('Date de fin incluse'),
      limit: LIMIT_PROP(50, 200),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 50);
    let q = ctx.supabase.from('mouvements_cca')
      .select('id, date, associe, sens, sous_type, montant, note, rapproche_banque, bank_transaction_id, invoice_id')
      .order('date', { ascending: true }).order('created_at', { ascending: true });
    if (args.associe) q = q.eq('associe', args.associe as string);
    const rows = await fetchAllRows<{ id: string; date: string; associe: string; sens: string; sous_type: string; montant: number; note: string | null; rapproche_banque: boolean; bank_transaction_id: string | null; invoice_id: string | null }>(
      (f0, f1) => q.range(f0, f1));

    // Le solde courant se calcule sur TOUT l'historique, puis on filtre la
    // période : un solde qui partirait de zéro au 1er du mois serait faux.
    const balance: Record<string, number> = {};
    const withBalance = rows.map(m => {
      const signed = m.sens === 'apport' ? Number(m.montant) : -Number(m.montant);
      balance[m.associe] = round2((balance[m.associe] ?? 0) + signed);
      return { ...m, montant: Number(m.montant), solde_apres: balance[m.associe] };
    });
    const inPeriod = withBalance.filter(m => (!args.from || m.date >= (args.from as string)) && (!args.to || m.date <= (args.to as string)));
    const truncated = inPeriod.length > limit;
    const shown = inPeriod.slice(-limit);

    return {
      summary: shown.length === 0
        ? 'Aucun mouvement de compte courant sur cette sélection.'
        : `${shown.length} mouvement(s)${truncated ? ' (les plus récents)' : ''}. Soldes actuels : `
          + Object.entries(balance).map(([a, s]) => `${driverLabel(a)} ${eur(s)}`).join(' · ') + '.',
      data: { movements: shown, balances: balance, count: inPeriod.length },
      truncated,
      next: ['get_partner_accounts'],
    };
  },
};

const getIngredientPrices: AgentTool = {
  name: 'get_ingredient_prices',
  description:
    "La mercuriale : le dernier prix d'achat HT connu de chaque ingrédient (unité, date de mise à jour), "
    + "tel que les factures scannées l'ont fixé. Filtrable par fragment de nom. Signale les ingrédients "
    + "sans prix et les désignations de factures encore non rattachées à un ingrédient.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Fragment de nom d\'ingrédient (insensible à la casse). Vide = tous.' },
      limit: LIMIT_PROP(50, 300),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 50);
    let q = ctx.supabase.from('ingredients').select('id, name, unit, last_unit_price, last_updated').order('name').limit(limit + 1);
    if (args.query) q = q.ilike('name', `%${String(args.query).replace(/[%_]/g, '')}%`);
    const [{ data, error }, { count: aliasCount }] = await Promise.all([
      q,
      ctx.supabase.from('ingredient_aliases').select('*', { count: 'exact', head: true }),
    ]);
    if (error) throw new ToolError(`Lecture de la mercuriale impossible : ${error.message}`, 'database_error');

    const all = data ?? [];
    const truncated = all.length > limit;
    const rows = all.slice(0, limit);
    const sansPrix = rows.filter(r => !r.last_unit_price);
    return {
      summary: rows.length === 0
        ? `Aucun ingrédient ne correspond à « ${args.query ?? ''} ».`
        : `${rows.length} ingrédient(s)${truncated ? ' (liste tronquée)' : ''}`
          + (sansPrix.length > 0 ? `, dont ${sansPrix.length} sans prix connu` : '')
          + `. Exemple : ${rows.slice(0, 3).map(r => `${r.name} ${r.last_unit_price ? `${eur(Number(r.last_unit_price))}/${r.unit ?? 'unité'}` : 'sans prix'}`).join(', ')}.`,
      data: { ingredients: rows, without_price: sansPrix.map(r => r.name), aliases_count: aliasCount ?? 0 },
      truncated,
    };
  },
};

const getRecipeCosts: AgentTool = {
  name: 'get_recipe_costs',
  description:
    "Le coût matière de chaque fiche technique (recette) à la mercuriale du jour, par portion, avec "
    + "le prix de vente TTC, le coût matière en pourcentage du prix HT (cible 28-32 %) et la marge. "
    + "Répond à « quelle pizza rapporte le plus », « lesquelles dépassent 32 % ». Filtrable par catégorie.",
  scope: 'read',
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: Object.keys(RECIPE_CATEGORY_LABELS), description: 'Catégorie de recette. Par défaut : toutes.' },
      limit: LIMIT_PROP(50, 200),
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const limit = Number(args.limit ?? 50);
    const { data, error } = await ctx.supabase.from('recipes')
      .select('id, name, category, portions, selling_price, recipe_ingredients(ingredient_id, sub_recipe_id, quantity, unit, ingredient:ingredients(unit, last_unit_price))')
      .order('name');
    if (error) throw new ToolError(`Lecture des recettes impossible : ${error.message}`, 'database_error');

    type Rec = { id: string; name: string; category: string | null; portions: number | null; selling_price: number | null;
      recipe_ingredients: { ingredient_id: string | null; sub_recipe_id: string | null; quantity: number | null; unit: string | null; ingredient: unknown }[] };
    const all = ((data ?? []) as unknown as Rec[]).map(r => ({
      ...r,
      recipe_ingredients: r.recipe_ingredients.map(ri => ({ ...ri, ingredient: (Array.isArray(ri.ingredient) ? ri.ingredient[0] : ri.ingredient) as { unit?: string | null; last_unit_price?: number | null } | null })),
    }));

    const rows = all
      .filter(r => !args.category || r.category === args.category)
      .map(r => {
        const cost = calcRecipeCost(r.recipe_ingredients, all);
        const portions = r.portions && r.portions > 0 ? r.portions : 1;
        const costPortion = round2(cost / portions);
        const priceTtc = Number(r.selling_price) || 0;
        // Vente sur place à 10 % : le prix de carte est TTC.
        const priceHt = round2(priceTtc / 1.10);
        const foodCost = priceHt > 0 ? round2((costPortion / priceHt) * 100) : null;
        return {
          id: r.id, name: r.name, category: r.category, portions,
          cost_per_portion_ht: costPortion, selling_price_ttc: priceTtc, selling_price_ht: priceHt,
          food_cost_percent: foodCost, margin_ht: priceHt > 0 ? round2(priceHt - costPortion) : null,
          ingredients_without_price: r.recipe_ingredients.filter(ri => ri.ingredient_id && !ri.ingredient?.last_unit_price).length,
        };
      })
      .sort((a, b) => (b.margin_ht ?? -1) - (a.margin_ht ?? -1));

    const truncated = rows.length > limit;
    const shown = rows.slice(0, limit);
    const sold = shown.filter(r => r.food_cost_percent !== null);
    const over = sold.filter(r => (r.food_cost_percent ?? 0) > 32);
    return {
      summary: shown.length === 0
        ? 'Aucune fiche technique ne correspond.'
        : `${shown.length} recette(s)${truncated ? ' (liste tronquée)' : ''}. `
          + (sold.length > 0 ? `Meilleure marge : ${sold[0].name} (${eur(sold[0].margin_ht ?? 0)} HT, coût ${sold[0].food_cost_percent} %). ` : '')
          + (over.length > 0 ? `${over.length} au-dessus de 32 % de coût matière : ${over.slice(0, 5).map(r => `${r.name} (${r.food_cost_percent} %)`).join(', ')}.` : 'Aucune au-dessus de 32 %.')
          + ' Le prix HT suppose une vente sur place à 10 %.',
      data: { recipes: shown, count: rows.length, target_food_cost_percent: 32 },
      truncated,
      next: ['get_ingredient_prices'],
    };
  },
};

const getBusinessRules: AgentTool = {
  name: 'get_business_rules',
  description:
    "Le guide de l'agent : conventions, méthode de travail, procédure pour traiter une facture ou "
    + "lettrer la banque, règles métier (compte courant jamais débiteur, mois clôturé, TVA sur factures) "
    + "et pièges. À lire une fois en début de session si le skill qentina-gestion n'est pas chargé.",
  scope: 'read',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    return {
      summary: 'Guide de l\'agent QENTINA — à lire avant d\'écrire dans la comptabilité.',
      data: { guide_markdown: GUIDE_MARKDOWN },
    };
  },
};

export const GESTION_TOOLS: readonly AgentTool[] = [
  getSalesReport, getPnlBreakdown, listPartnerMovements, getIngredientPrices, getRecipeCosts, getBusinessRules,
];
