/**
 * verify-comptable.mjs — Contrôles de non-régression sur les calculs comptables.
 *
 *   npm run verify:compta
 *
 * À lancer après toute modification touchant la TVA, le P&L ou la
 * classification des écritures bancaires. Chaque contrôle correspond à une
 * erreur qui a réellement été commise :
 *
 *  - de la TVA déductible calculée sans facture, y compris sur des prêts et
 *    des retraits d'espèces (crédit de TVA fictif) ;
 *  - une ventilation par taux qui ne réconciliait pas avec son propre total ;
 *  - un taux à 7 % classé dans la tranche 5,5 % ;
 *  - un encaissement classé « autre » traité comme un achat déductible.
 *
 * Les données sont synthétiques : ce fichier doit tourner partout, sans base
 * et sans relevé bancaire réel.
 */

import { computeTva } from '../src/lib/tva.ts';
import {
  isFinancialFlow, estimatedVatRate,
  orderHtAmount, bankAmountHt, makeInvoiceMatcher, round2,
} from '../src/lib/accounting.ts';
import { detectInterventions, collectInterventionFacts } from '../src/lib/interventions.ts';
import { categoryFromRules } from '../src/lib/bank-csv.ts';
import { suggestInvoicesForTransaction, sumDebits } from '../src/lib/reconciliation.ts';
import { checkInvoice, assertInvoiceAccepted } from '../src/lib/invoice-checks.ts';
import {
  repairMojibake, normalizeName, findSupplierMatch, matchIngredient, unmatchedDesignations,
} from '../src/lib/referentiel.ts';
import { checkCcaOperation, firstDebitDay } from '../src/lib/cca.ts';
import { inventorySessions, sessionAtBoundary, computeCogs } from '../src/lib/cogs.ts';
import { monthBounds, recentMonths, isMonthOver } from '../src/lib/months.ts';

/**
 * Faux client Supabase, qui applique réellement les filtres utilisés.
 *
 * **Il plafonne à 1 000 lignes, comme le vrai.** C'est délibéré : Supabase
 * tronque toute réponse à 1 000 lignes sans le signaler — `error` reste nul et
 * le tableau est parfaitement valide, simplement incomplet. Un faux client sans
 * ce plafond rend le défaut invisible aux tests, et c'est exactement ce qui
 * s'est produit : sur un exercice de 1 788 commandes, le chiffre d'affaires
 * affiché était amputé de 44 % et aucun contrôle ne s'en apercevait.
 */
const MAX_ROWS = 1000;

function fakeSupabase(tables) {
  return {
    from(table) {
      let rows = (tables[table] || []).slice();
      let start = 0;
      let end = MAX_ROWS - 1;
      const q = {
        select: () => q,
        // Le tri est réellement appliqué : plusieurs règles reposent dessus
        // (première et dernière vente enregistrées). Un `order` neutre rendait
        // ces contrôles muets — ils passaient quel que soit le code.
        order(col, opts) {
          const asc = opts?.ascending !== false;
          rows = rows.slice().sort((a, b) => {
            const x = String(a[col] ?? ''), y = String(b[col] ?? '');
            return asc ? x.localeCompare(y) : y.localeCompare(x);
          });
          return q;
        },
        eq(col, v) { rows = rows.filter(r => r[col] === v); return q; },
        lt(col, v) { rows = rows.filter(r => Number(r[col]) < v); return q; },
        gte(col, v) { rows = rows.filter(r => String(r[col]) >= v); return q; },
        lte(col, v) { rows = rows.filter(r => String(r[col]) <= v); return q; },
        in(col, vs) { rows = rows.filter(r => vs.includes(r[col])); return q; },
        limit(n) { rows = rows.slice(0, n); return q; },
        range(from, to) {
          start = from;
          // Le serveur ne rend jamais plus de MAX_ROWS, même si on en demande
          // davantage : demander 0-4999 renvoie 1 000 lignes, pas 5 000.
          end = Math.min(to, from + MAX_ROWS - 1);
          return q;
        },
        then(res) {
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null }).then(res);
        },
      };
      return q;
    },
  };
}

let echecs = 0;
const cents = v => Math.round(v * 100);

/**
 * Compare une valeur à son attendu.
 *
 * La comparaison était purement numérique : deux chaînes égales donnaient
 * `NaN < 0.005` — donc un échec — et deux chaînes différentes aussi. Un test
 * de chaîne ne pouvait pas passer, et rien ne le disait clairement. Les nombres
 * gardent leur tolérance au centime ; tout le reste se compare strictement.
 */
function verifie(nom, reel, attendu) {
  const ok = (typeof reel === 'number' && typeof attendu === 'number')
    ? Math.abs(reel - attendu) < 0.005
    : reel === attendu;
  if (!ok) echecs++;
  console.log(`  ${ok ? '✓' : '✗'} ${nom.padEnd(56)} ${String(reel).padStart(10)}${ok ? '' : `  attendu ${attendu}`}`);
}

const AN = ['2026-01-01', '2026-12-31'];
const tva = (t) => computeTva(fakeSupabase(t), ...AN);

// ═══ 1. Classification des flux financiers ═══════════════════════════════
console.log('\n1. Flux financiers — reconnaissance');
const fluxAttendus = [
  'VIR SEPA DE FARIA HOLDING - Pret Tekotek', 'VIR SEPA PIZZA MILANO TEKOTEK',
  'tresorerie holding', 'compte associe', 'compte assosie',
  'remboursement compte associe', 'RETRAIT EXPRESS 08335 LOUVIERS',
  'APPORT EN COMPTE COURANT', 'VIREMENT INTERNE', 'EMPRUNT BANCAIRE',
];
const chargesReelles = [
  'VIR SEPA SQUAREUP INTERNATIONAL', 'CB42METRO FRANCE 04/06/26',
  'PRLV SEPA EURO CIBUS', 'CB42CARREFOUR MA', 'PRLV SEPA VERISURE',
  'VIR INST OBJECTIF PIERRE GESTI', 'PRLV SEPA ELECTRICITE DE FRANCE',
  'PRLV SEPA ABEILLE IARD ET SANTE', 'LOYER QENTINA', 'PRLV SEPA URSSAF',
  'REM CHQ 00001CH', 'CB42BUTCHERMARKE', 'Metro 27/03',
];
verifie('flux financiers reconnus', fluxAttendus.filter(l => isFinancialFlow(l)).length, fluxAttendus.length);
verifie('faux positifs sur charges réelles', chargesReelles.filter(l => isFinancialFlow(l)).length, 0);

// ═══ 2. Aucune catégorie ne fabrique de TVA sur l'inconnu ════════════════
console.log('\n2. Taux indicatifs — prudence sur l\'inconnu');
verifie('catégorie « autre » (était 20 %)', estimatedVatRate('autre'), 0);
verifie('catégorie inconnue', estimatedVatRate('n_importe_quoi'), 0);
verifie('flux financier', estimatedVatRate('flux_financier'), 0);
verifie('assurance (exonérée)', estimatedVatRate('fixe_assurance'), 0);
verifie('fournisseur alimentaire', estimatedVatRate('variable_fournisseur'), 0.10);

// ═══ 3. TVA déductible : factures uniquement ═════════════════════════════
console.log('\n3. TVA déductible — sans facture, rien n\'est déductible');
const depensesSansFacture = [
  { id: 't1', date: '2026-06-01', description: 'CB42METRO FRANCE', amount: -1100, category: 'variable_fournisseur', invoice_id: null },
  { id: 't2', date: '2026-06-02', description: 'VIR SEPA DE FARIA HOLDING Pret', amount: -12500, category: 'autre', invoice_id: null },
  { id: 't3', date: '2026-06-03', description: 'RETRAIT EXPRESS LOUVIERS', amount: -400, category: 'autre', invoice_id: null },
  { id: 't4', date: '2026-06-04', description: 'SO LOUNGE', amount: -60, category: 'autre', invoice_id: null },
];
let r = await tva({ bank_transactions: depensesSansFacture });
verifie('TVA déductible', r.deductibleTva, 0);
verifie('flux financiers écartés', r.financialFlowCount, 2);
verifie('montant des flux écartés', r.financialFlowAmount, 12900);
verifie('récupérable si facturé (Metro à 10 % seul)', r.recoverableIfInvoiced, 100);
verifie('dépenses sans facture', r.unInvoicedCount, 2);

// ═══ 4. Un encaissement n'est jamais un achat ════════════════════════════
console.log('\n4. Encaissements — jamais traités comme des achats');
r = await tva({ bank_transactions: [
  { id: 'c1', date: '2026-06-01', description: 'VIR SEPA SQUAREUP', amount: 1500, category: 'recette', invoice_id: null },
  { id: 'c2', date: '2026-06-02', description: 'ENCAISSEMENT DIVERS', amount: 900, category: 'autre', invoice_id: null },
]});
verifie('TVA déductible sur des crédits', r.deductibleTva, 0);
verifie('crédits comptés comme dépenses', r.unInvoicedCount, 0);

// ═══ 5. Ventilation de la TVA collectée ══════════════════════════════════
console.log('\n5. TVA collectée — ventilation lue dans Square');
const commandes = [
  { id: 'o1', net_amount: 0, service: '2026-06-05', raw_data: {
      total_tax_money: { amount: 300 },
      line_items: [
        { total_money: { amount: 1100 }, total_tax_money: { amount: 100 }, taxes: [{ percentage: '10.0', applied_money: { amount: 100 } }] },
        { total_money: { amount: 1200 }, total_tax_money: { amount: 200 }, taxes: [{ percentage: '20.0', applied_money: { amount: 200 } }] },
      ] } },
  { id: 'o2', net_amount: 0, service: '2026-06-06', raw_data: {
      total_tax_money: { amount: 55 },
      taxes: [{ uid: 'TX55', percentage: '5.5' }],
      line_items: [{ total_money: { amount: 1055 }, total_tax_money: { amount: 55 }, applied_taxes: [{ tax_uid: 'TX55', applied_money: { amount: 55 } }] }] } },
  { id: 'o3', net_amount: 0, service: '2026-06-07', raw_data: {
      total_tax_money: { amount: 147 },
      line_items: [{ total_money: { amount: 1100 }, total_tax_money: { amount: 100 }, taxes: [{ percentage: '10.0', applied_money: { amount: 100 } }] }] } },
  { id: 'o4', net_amount: 22, service: '2026-06-08', raw_data: null },
  { id: 'o5', net_amount: 0, service: '2026-06-09', raw_data: {
      total_tax_money: { amount: 70 },
      line_items: [{ total_money: { amount: 1070 }, total_tax_money: { amount: 70 }, taxes: [{ percentage: '7.0', applied_money: { amount: 70 } }] }] } },
];
r = await tva({ square_orders: commandes });
const b = r.collectedTvaBreakdown;
verifie('tranche 10 %', b['10%'], 2.00);
verifie('tranche 20 %', b['20%'], 2.00);
verifie('tranche 5,5 % (taxe niveau commande)', b['5.5%'], 0.55);
verifie('7 % NON classé en 5,5 %', b['5.5%'], 0.55);
verifie('non ventilé (0,47 résidu + 0,70 à 7 % + 2,00 estimé)', b.nonVentile, 3.17);
verifie('INVARIANT : somme des tranches = total (centimes)',
  cents(b['10%']) + cents(b['20%']) + cents(b['5.5%']) + cents(b.nonVentile), cents(r.collectedTva));
verifie('commandes à TVA estimée', r.estimatedOrdersCount, 1);

// ═══ 6. Factures ═════════════════════════════════════════════════════════
console.log('\n6. Factures — récupérable, exonéré, masqué, doublon');
const factures = [
  { id: 'i1', date: '2026-06-10', total_ht: 100, total_ttc: 110, tva_recoverable: true, supplier: { name: 'Metro' } },
  { id: 'i2', date: '2026-06-11', total_ht: 200, total_ttc: 240, tva_recoverable: true, supplier: { name: 'Point P' } },
  { id: 'i3', date: '2026-06-12', total_ht: 1624, total_ttc: 1624, tva_recoverable: false, supplier: { name: 'Abeille IARD' } },
  { id: 'i4', date: '2026-06-13', total_ht: 50, total_ttc: 60, tva_recoverable: true, supplier: { name: 'Masqué SARL' } },
];
r = await tva({ invoices: factures });
verifie('déductible = 10 + 40 + 0 exonérée + 10', r.deductibleTva, 60);
verifie('nombre de factures avec TVA', r.invoiceCount, 3);

r = await tva({ invoices: factures, app_settings: [{ key: 'masked_tva_suppliers', value: JSON.stringify(['Masqué SARL']) }] });
verifie('fournisseur masqué exclu', r.deductibleTva, 50);

r = await tva({
  invoices: [factures[0]],
  bank_transactions: [{ id: 'tx', date: '2026-06-10', description: 'CB42METRO', amount: -110, category: 'variable_fournisseur', invoice_id: 'i1' }],
});
verifie('facture payée comptée une seule fois', r.deductibleTva, 10);
verifie('pas de récupérable en double', r.recoverableIfInvoiced, 0);

// ═══ 7. Balance ══════════════════════════════════════════════════════════
console.log('\n7. Balance de TVA');
r = await tva({ square_orders: commandes, invoices: factures });
verifie('net = collectée − déductible', r.netTva, r.collectedTva - r.deductibleTva);
verifie('crédit de TVA (net négatif)', r.netTva < 0, true);

// ═══ 8. Interventions ════════════════════════════════════════════════════
// Une alerte qui se déclenche à tort est pire que pas d'alerte : elle apprend
// à ignorer le module. Chaque règle est donc testée dans les deux sens — elle
// se déclenche quand il faut, et elle se TAIT quand tout va bien.
console.log('\n8. Interventions — détection des anomalies');

const joursDeVente = [];
for (let j = 1; j <= 28; j++) joursDeVente.push(`2026-06-${String(j).padStart(2, '0')}`);

const TVA_SAINE = {
  collectedTva: 2700, deductibleTva: 800, netTva: 1900,
  collectedTvaBreakdown: { '5.5%': 0, '10%': 2700, '20%': 0, nonVentile: 0 },
  recoverableIfInvoiced: 0, unInvoicedCount: 0, unInvoicedAmount: 0,
  financialFlowAmount: 0, financialFlowCount: 0,
  estimatedOrdersCount: 0, invoiceCount: 12,
};

// Situation de référence : tout est en ordre, rien ne doit remonter.
const faits = (o = {}) => ({
  start: '2026-06-01', end: '2026-06-30', today: '2026-07-01',
  caSquareTtc: 30000, caSquareHt: 27273, ordersCount: 900,
  daysWithSales: joursDeVente,
  lastSyncedService: '2026-06-30',
  squarePayoutsTtc: 25000, squarePayoutsCount: 45,
  debitsCount: 100,
  uncategorizedDebits: { count: 0, amount: 0 },
  tva: TVA_SAINE,
  foodCostPercent: 30,
  foodCostBankSharePercent: 5,
  laborPercent: 31,
  laborAmount: 14500,
  bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-06-30' },
  firstSaleEver: '2024-01-15',
  suspectDateInvoices: { count: 0, sample: [] },
  mojibakeSuppliers: [],
  ccaBalances: [{ associe: 'yohan', balance: 1200 }],
  tripsNotInCca: { count: 0 },
  unmatchedDesignations: { count: 0, sample: [] },
  legacyMaskedItems: 0,
  inventoryClosing: { found: true, day: '2026-06-30' },
  ...o,
});

const ids = (o) => detectInterventions(faits(o)).map(i => i.id);
const declenche = (nom, o, id) => verifie(nom, ids(o).includes(id), true);
const silence = (nom, o, id) => verifie(nom, ids(o).includes(id), false);

verifie('situation saine : aucune intervention', ids().length, 0);

// Synchro de caisse
declenche('caisse muette depuis 5 jours', { lastSyncedService: '2026-06-26' }, 'square-desynchronise');
silence('caisse à jour la veille', { lastSyncedService: '2026-06-30', today: '2026-07-01' }, 'square-desynchronise');
declenche('aucune vente en base', { ordersCount: 0, lastSyncedService: null, daysWithSales: [] }, 'square-jamais-synchronise');

// Versements Square > CA enregistré : preuve arithmétique de ventes manquantes.
// Les espèces et la commission Square ne peuvent que creuser l'écart.
declenche('versements 25 000 > CA 8 000', { caSquareTtc: 8000 }, 'ca-square-incomplet');
silence('CA 30 000 > versements 25 000 (normal)', {}, 'ca-square-incomplet');
silence('écart de 400 € seulement', { caSquareTtc: 24600 }, 'ca-square-incomplet');
silence('aucun versement sur la période', { squarePayoutsTtc: 0, caSquareTtc: 0 }, 'ca-square-incomplet');
verifie(
  'écart annoncé = versements − CA',
  detectInterventions(faits({ caSquareTtc: 8000 })).find(i => i.id === 'ca-square-incomplet').amount,
  17000,
);

// Trous dans l'historique : les 2 derniers jours sont ignorés, la synchro
// nocturne n'a pas encore tourné pour eux.
declenche('3 jours consécutifs sans vente',
  { start: '2026-06-01', end: '2026-06-10', daysWithSales: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-07', '2026-06-08'] },
  'trou-historique-ventes');
silence('un seul jour sans vente (fermeture hebdo)',
  { start: '2026-06-01', end: '2026-06-10', daysWithSales: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-06', '2026-06-07', '2026-06-08'] },
  'trou-historique-ventes');
silence('2 derniers jours non synchronisés : pas une alerte',
  { start: '2026-06-01', end: '2026-06-10', daysWithSales: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08'] },
  'trou-historique-ventes');

// TVA
declenche('TVA non ventilée significative',
  { tva: { ...TVA_SAINE, collectedTvaBreakdown: { '5.5%': 0, '10%': 2400, '20%': 0, nonVentile: 300 } } },
  'tva-non-ventilee');
silence('résidu de 15 € : bruit d\'arrondi',
  { tva: { ...TVA_SAINE, collectedTvaBreakdown: { '5.5%': 0, '10%': 2685, '20%': 0, nonVentile: 15 } } },
  'tva-non-ventilee');
declenche('TVA perdue faute de factures',
  { tva: { ...TVA_SAINE, recoverableIfInvoiced: 1400, unInvoicedCount: 60, unInvoicedAmount: 15400 } },
  'depenses-sans-facture');
verifie('… classée critique au-delà de 1 000 €',
  detectInterventions(faits({ tva: { ...TVA_SAINE, recoverableIfInvoiced: 1400, unInvoicedCount: 60, unInvoicedAmount: 15400 } }))
    .find(i => i.id === 'depenses-sans-facture').severity === 'critique', true);

// Dépenses non classées
declenche('dépenses sans catégorie', { uncategorizedDebits: { count: 12, amount: 2557 } }, 'depenses-non-categorisees');
silence('une seule petite dépense non classée', { uncategorizedDebits: { count: 1, amount: 42 } }, 'depenses-non-categorisees');

// Fiabilité du food cost. Une facture scannée est ventilée ligne à ligne et
// sort le matériel du calcul ; un virement fournisseur sans facture entre en
// entier, produits d'entretien compris. Au-delà d'un certain seuil, le ratio
// n'est plus une mesure mais un majorant — et il faut le dire avant de
// reprocher un food cost trop haut.
declenche('coût matières à 78 % sans facture',
  { foodCostBankSharePercent: 78 }, 'food-cost-non-mesure');
silence('presque tout est facturé', { foodCostBankSharePercent: 5 }, 'food-cost-non-mesure');
silence('part inconnue : pas d\'alerte',
  { foodCostBankSharePercent: null }, 'food-cost-non-mesure');
silence('sans CA, le ratio n\'a pas de sens',
  { foodCostBankSharePercent: 78, caSquareHt: 0 }, 'food-cost-non-mesure');
verifie('la fiabilité est annoncée en clair',
  detectInterventions(faits({ foodCostBankSharePercent: 78 }))
    .find(i => i.id === 'food-cost-non-mesure').title,
  'Food cost fiable à 22 % seulement');

// La cause avant la conséquence : la fiabilité passe avant « food cost haut ».
const fc = detectInterventions(faits({ foodCostPercent: 62, foodCostBankSharePercent: 78 }))
  .map(i => i.id);
verifie('fiabilité annoncée avant le food cost hors norme',
  fc.indexOf('food-cost-non-mesure') < fc.indexOf('food-cost-trop-haut'), true);

// Couverture bancaire. Le CA vient de la caisse et couvre toujours la période
// entière ; les achats viennent des relevés importés, qui peuvent n'en couvrir
// qu'un morceau. Diviser huit mois de ventes par deux mois d'achats ne donne
// pas un food cost — ça ne donne rien du tout. Cas réel : 46 855 € de CA sur
// huit mois face à un seul relevé de juin-juillet.
declenche('relevés sur 2 mois, ventes sur 8',
  { start: '2026-01-01', end: '2026-12-31', today: '2026-08-03',
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-01' } },
  'banque-periode-incomplete');
silence('relevés couvrant toute la période',
  { start: '2026-06-01', end: '2026-08-31', today: '2026-08-31',
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-30' } },
  'banque-periode-incomplete');
silence('période trop courte pour conclure',
  { start: '2026-08-01', end: '2026-08-31', today: '2026-08-10',
    bankCoverage: { firstDate: '2026-08-01', lastDate: '2026-08-02' } },
  'banque-periode-incomplete');
silence('aucun relevé importé : autre alerte s\'en charge',
  { bankCoverage: { firstDate: null, lastDate: null } },
  'banque-periode-incomplete');
verifie('la fenêtre s\'arrête à aujourd\'hui, pas à fin décembre',
  detectInterventions(faits({
    start: '2026-01-01', end: '2026-12-31', today: '2026-08-03',
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-01' },
  })).find(i => i.id === 'banque-periode-incomplete').title,
  'Achats connus sur 62 jours, ventes sur 215');

// Ouverture récente. Rien de ce qui précède la première vente n'a de sens à
// reprocher : l'outil réclamait des relevés bancaires pour janvier et signalait
// « 113 jours consécutifs sans aucune vente » pour un local en travaux.
declenche('année entière, ouverture au 24 avril : trou avant ouverture ignoré',
  { start: '2026-01-01', end: '2026-12-31', today: '2026-08-03',
    firstSaleEver: '2026-04-24', daysWithSales: [],
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-01' } },
  'banque-periode-incomplete');
verifie('les ventes comptent depuis l\'ouverture, pas depuis janvier',
  detectInterventions(faits({
    start: '2026-01-01', end: '2026-12-31', today: '2026-08-03',
    firstSaleEver: '2026-04-24',
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-01' },
  })).find(i => i.id === 'banque-periode-incomplete').title,
  'Achats connus sur 62 jours, ventes sur 102');
verifie('le ratio est annoncé MINORÉ, pas majoré',
  detectInterventions(faits({
    start: '2026-01-01', end: '2026-12-31', today: '2026-08-03',
    firstSaleEver: '2026-04-24',
    bankCoverage: { firstDate: '2026-06-01', lastDate: '2026-08-01' },
  })).find(i => i.id === 'banque-periode-incomplete').impact.includes('MINORÉ'), true);

// Le trou de ventes ne compte plus les jours d'avant l'ouverture.
silence('aucune vente avant l\'ouverture : ce n\'est pas un trou',
  { start: '2026-01-01', end: '2026-08-31', today: '2026-08-03',
    firstSaleEver: '2026-08-01',
    daysWithSales: ['2026-08-01'] },
  'trou-historique-ventes');

// Un établissement de moins de six mois ne se juge pas au 28-32 %.
verifie('le rodage est mentionné pour un jeune établissement',
  detectInterventions(faits({ foodCostPercent: 62, firstSaleEver: '2026-04-24', today: '2026-08-03' }))
    .find(i => i.id === 'food-cost-trop-haut').impact.includes('mois d\'activité'), true);
verifie('… mais pas pour un établissement installé',
  detectInterventions(faits({ foodCostPercent: 62, firstSaleEver: '2024-01-15' }))
    .find(i => i.id === 'food-cost-trop-haut').impact.includes('mois d\'activité'), false);

// Masse salariale. Un restaurant sans salaires n'est pas impossible — deux
// associés non rémunérés au démarrage — mais ça change la lecture de tous les
// autres ratios, donc ça doit être un choix affiché et non un oubli.
declenche('1 370 € de salaires pour 1 627 commandes',
  { laborPercent: 2.9, laborAmount: 1370, ordersCount: 1627 },
  'masse-salariale-invraisemblable');
silence('masse salariale normale à 31 %', {}, 'masse-salariale-invraisemblable');
silence('trop peu de commandes pour conclure',
  { laborPercent: 2.9, laborAmount: 1370, ordersCount: 40 },
  'masse-salariale-invraisemblable');
silence('masse salariale inconnue',
  { laborPercent: null, ordersCount: 1627 },
  'masse-salariale-invraisemblable');

// Food cost — ne se déclenche que s'il y a du CA, sinon c'est une conséquence
declenche('food cost à 62 %', { foodCostPercent: 62 }, 'food-cost-trop-haut');
declenche('food cost à 9 %', { foodCostPercent: 9 }, 'food-cost-trop-bas');
silence('food cost à 30 %', { foodCostPercent: 30 }, 'food-cost-trop-haut');
silence('food cost ignoré sans CA', { foodCostPercent: 62, caSquareHt: 0 }, 'food-cost-trop-haut');
silence('food cost inconnu', { foodCostPercent: null }, 'food-cost-trop-haut');

// Compte courant d'associé
declenche('compte courant débiteur', { ccaBalances: [{ associe: 'yohan', balance: -3200 }] }, 'cca-debiteur-yohan');
silence('compte courant créditeur', { ccaBalances: [{ associe: 'yohan', balance: 3200 }] }, 'cca-debiteur-yohan');

// Qualité des données
declenche('facture au 1er janvier', { suspectDateInvoices: { count: 3, sample: ['2024-01-01'] } }, 'factures-date-suspecte');
declenche('fournisseur mal encodé', { mojibakeSuppliers: ['MÃ©tro'] }, 'fournisseurs-mojibake');
declenche('trajets hors compte courant', { tripsNotInCca: { count: 7 } }, 'trajets-hors-cca');

// Ordre de traitement : le CA d'abord, il rend faux tout ce qui le suit.
const ordre = detectInterventions(faits({ caSquareTtc: 8000, foodCostPercent: 62, tripsNotInCca: { count: 7 } }));
verifie('le CA manquant passe avant le food cost', ordre[0].id === 'ca-square-incomplet', true);
verifie('les points à vérifier ferment la liste', ordre[ordre.length - 1].severity === 'a_verifier', true);

// Collecte des faits depuis la base
console.log('\n9. Interventions — lecture de la base');
const factsBase = await collectInterventionFacts(fakeSupabase({
  square_orders: [
    { service: '2026-06-10', net_amount: 220, raw_data: { total_tax_money: { amount: 2000 } } },
    { service: '2026-06-10', net_amount: 110, raw_data: { total_tax_money: { amount: 1000 } } },
  ],
  bank_transactions: [
    { id: 'b1', date: '2026-06-11', description: 'VIR SEPA SQUAREUP INTERNATIONAL', amount: 900, category: 'recette', invoice_id: null },
    { id: 'b2', date: '2026-06-18', description: 'VIR SEPA SQUARE UP', amount: 600, category: 'recette', invoice_id: null },
    { id: 'b3', date: '2026-06-20', description: 'VIR SEPA DE FARIA HOLDING - Pret', amount: 5000, category: null, invoice_id: null },
    { id: 'b4', date: '2026-06-21', description: 'PRLV SEPA INCONNU SARL', amount: -450, category: 'autre', invoice_id: null },
    { id: 'b5', date: '2026-06-22', description: 'CB42METRO FRANCE', amount: -300, category: 'variable_fournisseur', invoice_id: null },
    { id: 'b6', date: '2026-06-23', description: 'RETRAIT EXPRESS 08335', amount: -200, category: null, invoice_id: null },
  ],
  invoices: [
    { id: 'i1', date: '2026-06-10', total_ht: 100, total_ttc: 110, tva_recoverable: true, supplier: { name: 'Metro' } },
    { id: 'i2', date: '2024-01-01', total_ht: 80, total_ttc: 88, tva_recoverable: true, supplier: { name: 'Metro' } },
  ],
  suppliers: [{ name: 'Metro' }, { name: 'MÃ©tro' }],
  mouvements_cca: [
    { associe: 'yohan', sens: 'apport', montant: 500 },
    { associe: 'yohan', sens: 'remboursement', montant: 900 },
    { associe: 'justine', sens: 'apport', montant: 300 },
  ],
  mileage_trips: [{ id: 't1', cca_movement_id: null }, { id: 't2', cca_movement_id: 'm1' }],
}), { start: '2026-06-01', end: '2026-06-30', today: '2026-07-05',
      foodCostPercent: 41, foodCostBankSharePercent: 88 });

verifie('CA Square TTC lu', factsBase.caSquareTtc, 330);
verifie('CA Square HT (taxes déduites)', factsBase.caSquareHt, 300);
verifie('versements Square additionnés', factsBase.squarePayoutsTtc, 1500);
verifie('nombre de versements', factsBase.squarePayoutsCount, 2);
verifie('prêt holding non compté en versement', factsBase.squarePayoutsTtc === 1500, true);
verifie('dépenses hors flux financiers', factsBase.debitsCount, 2);
verifie('retrait d\'espèces exclu des dépenses', factsBase.debitsCount === 2, true);
verifie('dépense « autre » signalée', factsBase.uncategorizedDebits.amount, 450);
verifie('facture au 1er janvier repérée', factsBase.suspectDateInvoices.count, 1);
verifie('fournisseur mal encodé repéré', factsBase.mojibakeSuppliers.length, 1);
verifie('compte courant yohan débiteur', factsBase.ccaBalances.find(b => b.associe === 'yohan').balance, -400);
verifie('compte courant justine créditeur', factsBase.ccaBalances.find(b => b.associe === 'justine').balance, 300);
verifie('trajets hors compte courant', factsBase.tripsNotInCca.count, 1);
verifie('part non facturée transmise', factsBase.foodCostBankSharePercent, 88);
verifie('première date de relevé lue', factsBase.bankCoverage.firstDate === '2026-06-11', true);
verifie('dernière date de relevé lue', factsBase.bankCoverage.lastDate === '2026-06-23', true);
verifie('dernier service synchronisé', factsBase.lastSyncedService === '2026-06-10', true);
verifie('première vente (date d\'ouverture déduite)', factsBase.firstSaleEver === '2026-06-10', true);

const vues = detectInterventions(factsBase).map(i => i.id);
verifie('ventes manquantes détectées sur ces données', vues.includes('ca-square-incomplet'), true);
verifie('compte courant débiteur détecté', vues.includes('cca-debiteur-yohan'), true);
verifie('caisse désynchronisée détectée', vues.includes('square-desynchronise'), true);

// ═══ 10. Bases de calcul : HT partout ════════════════════════════════════
// Le P&L et le tableau de bord affichaient deux food cost différents pour le
// même mois : l'un divisait des HT par un CA TTC, l'autre non. Ces trois
// fonctions sont désormais la seule façon de changer de base.
console.log('\n10. Bases de calcul — HT sur HT');

verifie('CA HT d\'une commande (taxe lue dans Square)',
  orderHtAmount({ net_amount: 22, raw_data: { total_tax_money: { amount: 200 } } }), 20);
verifie('… repli sur net_amounts.tax_money',
  orderHtAmount({ net_amount: 11, raw_data: { net_amounts: { tax_money: { amount: 100 } } } }), 10);
verifie('… commande sans détail de taxe : TTC tel quel',
  orderHtAmount({ net_amount: 15, raw_data: {} }), 15);

verifie('fournisseur : TTC 110 → HT à 10 %',
  round2(bankAmountHt({ amount: -110, category: 'variable_fournisseur' })), 100);
verifie('loyer : TTC 1 200 → HT à 20 %',
  round2(bankAmountHt({ amount: -1200, category: 'fixe_loyer' })), 1000);
verifie('assurance exonérée : montant inchangé',
  round2(bankAmountHt({ amount: -1624, category: 'fixe_assurance' })), 1624);
verifie('catégorie inconnue : aucune TVA supposée',
  round2(bankAmountHt({ amount: -500, category: 'autre' })), 500);
verifie('catégorie absente : repli explicite honoré',
  round2(bankAmountHt({ amount: -110, category: null }, 'variable_fournisseur')), 100);

// Apparieur souple facture ↔ paiement
const m = makeInvoiceMatcher([{ total_ttc: 110 }, { total_ttc: 110 }, { total_ttc: 240 }]);
verifie('paiement de 110 apparié', m.alreadyInvoiced({ amount: -110 }), true);
verifie('2e paiement de 110 apparié (2 factures)', m.alreadyInvoiced({ amount: -110 }), true);
verifie('3e paiement de 110 NON apparié', m.alreadyInvoiced({ amount: -110 }), false);
verifie('un centime d\'écart ne suffit pas', m.alreadyInvoiced({ amount: -239.99 }), false);
verifie('paiement de 240 apparié', m.alreadyInvoiced({ amount: -240 }), true);
verifie('nombre d\'appariements annoncé', m.count(), 3);
verifie('facture à 0 € jamais appariée',
  makeInvoiceMatcher([{ total_ttc: 0 }]).alreadyInvoiced({ amount: 0 }), false);

// ═══ 11. Catégorisation des dépenses ═════════════════════════════════════
// 49 % des décaissements d'un relevé réel tombaient en « autre » — donc dans
// les charges fixes au lieu du coût matières. Chaque libellé ci-dessous vient
// de ce relevé.
console.log('\n11. Catégorisation — le libellé décide du poste');

const attendu = (label, cat, montant) =>
  verifie(label.slice(0, 52), categoryFromRules(label, montant) === cat, true);

// Achats revendus : ils appartiennent au coût matières.
attendu('PRLV SEPA VALLEE DE SEINE BOISS', 'variable_fournisseur');
attendu('PRLV SEPA LES DELICES DU PALAIS', 'variable_fournisseur');
attendu('SHOP COFFEE', 'variable_fournisseur');
attendu('LA FERME DU PLESSIS', 'variable_fournisseur');
// Le bois de four cuit les pizzas : c'est une matière première, pas une charge.
attendu('GRUCHY BOIS', 'variable_fournisseur');
attendu('PRLV SEPA EURO CIBUS', 'variable_fournisseur');
attendu('CB42METRO FRANCE 04/06/26', 'variable_fournisseur');

// Le libellé d'un administrateur de biens ne contient jamais « loyer ».
attendu('VIR INST OBJECTIF PIERRE GESTI', 'fixe_loyer');

// « VIREMENT PERMANENT » est le loyer chez ce restaurant, mais le libellé seul
// ne le dit pas : la règle exige le montant. Un futur virement permanent
// (emprunt, épargne) resterait ainsi non classé — visible — au lieu d'être
// silencieusement compté en loyer.
attendu('VIREMENT PERMANENT', 'fixe_loyer', -1332.65);
verifie('virement permanent d\'un autre montant : non classé',
  categoryFromRules('VIREMENT PERMANENT', -450) === null, true);
verifie('… ni classé sans montant connu',
  categoryFromRules('VIREMENT PERMANENT') === null, true);
verifie('tolérance de 1 € sur le loyer (centimes de révision)',
  categoryFromRules('VIREMENT PERMANENT', -1333.10), 'fixe_loyer');

// Droits musicaux et logiciels : charges fixes, pas des achats.
attendu('PRLV SEPA SACEM-SOC AUTEUR COMP', 'fixe_abonnement');
attendu('PRLV SEPA SPRE', 'fixe_abonnement');
attendu('IA CLAUDE JUILLET', 'fixe_abonnement');
attendu('APPLE.COM/BI', 'fixe_abonnement');

// Fournisseurs identifiés par l'exploitant, libellés tronqués par la banque.
attendu('LAGUETTE PRI', 'variable_fournisseur');
attendu('VAL DE', 'variable_fournisseur');

// Honoraires : charge de structure récurrente, pas un achat revendu.
attendu('PRLV SEPA SAS PARTEXIA', 'fixe_abonnement');
attendu('VIR INST JUKACREA', 'fixe_abonnement');
attendu('PAPETERIE DE', 'fixe_abonnement');

// Équipement et travaux : hors coût matières ET hors charges fixes. Un four
// acheté 1 400 € une fois ne fait pas partie du coût de structure mensuel.
attendu('VIR INST GUILLAUME TRIPOLI', 'investissement');
attendu('LOCATION CAMION TRAVAUX', 'investissement');
attendu('VIR INST SEBASTIEN ANTONY DE F', 'investissement');
attendu('ELECTRO DEPO', 'investissement');
attendu('BRICOMARCHE', 'investissement');
attendu('LEROY MERLIN', 'investissement');
attendu('WEST PHONE', 'investissement');
verifie('un équipement ne fabrique aucune TVA supposée',
  estimatedVatRate('investissement'), 0);

// « SEBASTIEN ANTONY DE F » est tronqué : le motif des flux financiers
// (« de faria ») ne doit pas l'attraper, sinon les travaux disparaissent
// du résultat au lieu d'y figurer.
verifie('travaux non pris pour un flux financier',
  isFinancialFlow('VIR INST SEBASTIEN ANTONY DE F'), false);

// Une règle trop large est pire qu'une règle absente : ces libellés doivent
// rester non reconnus plutôt que d'être rangés au hasard. « SO LOUNGE » est un
// prélèvement erroné à se faire rembourser, « B&M » une enseigne dont on ignore
// ce qui y a été acheté : dans les deux cas, seul l'exploitant peut trancher.
const inconnus = [
  'SIEGE 27', 'RESULTAT ARRETE COMPTE 30062026', 'SO LOUNGE', 'B&M',
  'EVREUX', 'SAS DUBREUIL', 'DEMEURE', 'PHARMACIE LA', 'ESSO31769ROC',
];
verifie('libellés inconnus laissés non classés',
  inconnus.filter(l => categoryFromRules(l, -100) === null).length, inconnus.length);

// Les flux financiers restent reconnus comme tels, quoi qu'en dise la règle.
verifie('mouvements de compte courant hors exploitation',
  ['COMPTE ASSOCIE', 'COMPTE ASSOSIE', 'REMBOURSEMENT COMPTE ASSOCIE',
   'VIR INST DE FARIA PEREIRA'].filter(l => isFinancialFlow(l)).length, 4);

// ═══ 12. Trous de ventes : ne jamais compter demain ══════════════════════
// Le 3 du mois, l'outil annonçait « 28 jours consécutifs sans aucune vente » :
// la fenêtre allait jusqu'à la fin du mois en cours, donc dans le futur.
console.log('\n12. Jours sans vente — la fenêtre s\'arrête à aujourd\'hui');

const moisEnCours = {
  start: '2026-08-01', end: '2026-08-31', today: '2026-08-03',
  daysWithSales: ['2026-08-01', '2026-08-02', '2026-08-03'],
  lastSyncedService: '2026-08-03',
};
silence('mois en cours, ventes à jour : aucun trou', moisEnCours, 'trou-historique-ventes');
verifie('… et aucune intervention du tout', ids(moisEnCours).length, 0);

// La caisse s'est arrêtée le 10 : le trou réel est compté, pas le futur.
const arret = {
  start: '2026-08-01', end: '2026-08-31', today: '2026-08-20',
  daysWithSales: ['2026-08-01', '2026-08-02', '2026-08-03'],
  lastSyncedService: '2026-08-03',
};
declenche('caisse arrêtée le 3, vu le 20 : trou détecté', arret, 'trou-historique-ventes');
verifie('longueur = jours écoulés (15), pas jours du mois (28)',
  detectInterventions(faits(arret)).find(i => i.id === 'trou-historique-ventes').title
    === '15 jours consécutifs sans aucune vente', true);

// ═══ 13. Lettrage et compteurs de la page Banque ═════════════════════════
console.log('\n13. Lettrage — le signe et le lien avant la date');

const fMetro = { date: '2026-06-10', total_ttc: 110, supplier: { name: 'Metro' } };
const fEdf   = { date: '2026-06-11', total_ttc: 282, supplier: { name: 'EDF' } };
const fLot   = { date: '2026-06-12', total_ttc: 476.31, supplier: { name: 'Euro Cibus' } };
const factsF = [fMetro, fEdf, fLot];

const sug = (tx) => suggestInvoicesForTransaction(tx, factsF);

// Le cas exact rapporté : un encaissement Square proposé face à une facture EDF.
verifie('encaissement Square : aucune suggestion',
  sug({ date: '2026-06-11', description: 'VIR SEPA SQUAREUP', amount: 282 }).length, 0);
verifie('… même au centime près du TTC d\'une facture',
  sug({ date: '2026-06-11', description: 'VIR SEPA SQUAREUP', amount: 282 }).length, 0);

// Un débit sans aucun lien ne doit rien proposer, même le jour même.
verifie('débit sans lien de montant ni de nom',
  sug({ date: '2026-06-11', description: 'PRLV SEPA SAS PARTEXIA', amount: -549.60 }).length, 0);

// Montant exact : la suggestion évidente.
let s1 = sug({ date: '2026-06-10', description: 'CB42METRO FRANCE', amount: -110 });
verifie('montant exact + nom + date : proposé', s1.length > 0, true);
verifie('… et c\'est la bonne facture', s1[0].invoice === fMetro, true);

// Nom seul, montant différent (paiement groupé) : légitime, on propose.
let s2 = sug({ date: '2026-06-14', description: 'PRLV SEPA EURO CIBUS', amount: -1203.44 });
verifie('nom reconnu, montant différent : proposé', s2.length > 0, true);
verifie('… la facture Euro Cibus arrive en tête', s2[0].invoice === fLot, true);

// Montant seul, fournisseur inconnu du libellé : légitime aussi.
verifie('montant exact, nom absent du libellé : proposé',
  sug({ date: '2026-06-13', description: 'PRLV SEPA INCONNU', amount: -476.31 }).length > 0, true);

console.log('\n14. Compteurs Banque — rien ne se compense');
const mouvements = [
  { amount: -14539.43 }, { amount: -6484.15 },   // décaissements fournisseurs
  { amount: 20772.67 },                          // versements Square
  { amount: -0.40 },
];
verifie('total des dépenses (était 250,91 par compensation)',
  sumDebits(mouvements), 21023.98);
verifie('un encaissement seul ne compte pas', sumDebits([{ amount: 900 }]), 0);
verifie('liste vide', sumDebits([]), 0);
verifie('montant absent traité comme zéro', sumDebits([{ amount: null }, { amount: -10 }]), 10);

// ═══ 15. Le plafond des 1 000 lignes ═════════════════════════════════════
// Supabase tronque toute réponse à 1 000 lignes SANS le signaler : `error`
// reste nul et le tableau est valide, simplement incomplet. Sur un exercice
// réel de 1 788 commandes, le chiffre d'affaires affiché était amputé de 44 %,
// et comme le CA est le dénominateur de tous les ratios, le food cost et la
// masse salariale étaient gonflés d'autant.
//
// Le symptôme reconnaissable est un compte EXACTEMENT rond. Ces contrôles
// travaillent donc volontairement au-dessus du plafond.
console.log('\n15. Pagination — au-delà de 1 000 lignes');

// 1 788 commandes à 11 € TTC dont 1 € de TVA : 19 668 € TTC, 1 788 € de TVA.
const EXERCICE = Array.from({ length: 1788 }, (_, i) => ({
  id: `o${i}`,
  net_amount: 11,
  service: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
  raw_data: {
    total_tax_money: { amount: 100 },
    line_items: [{
      total_money: { amount: 1100 }, total_tax_money: { amount: 100 },
      taxes: [{ percentage: '10.0', applied_money: { amount: 100 } }],
    }],
  },
}));

r = await tva({ square_orders: EXERCICE });
verifie('TVA collectée sur 1 788 commandes (était 1 000)', r.collectedTva, 1788);
verifie('tout est ventilé à 10 %', r.collectedTvaBreakdown['10%'], 1788);
verifie('rien de non ventilé', r.collectedTvaBreakdown.nonVentile, 0);

// 2 500 dépenses : deux pages pleines plus une partielle.
const DEPENSES = Array.from({ length: 2500 }, (_, i) => ({
  id: `t${i}`, date: '2026-06-15', description: 'CB42METRO FRANCE',
  amount: -11, category: 'variable_fournisseur', invoice_id: null,
}));
r = await tva({ bank_transactions: DEPENSES });
verifie('2 500 dépenses lues (était 1 000)', r.unInvoicedCount, 2500);
verifie('récupérable si facturé, sur le total', r.recoverableIfInvoiced, 2500);

// Le collecteur d'interventions lit les mêmes tables.
const gros = await collectInterventionFacts(fakeSupabase({ square_orders: EXERCICE }), {
  start: '2026-01-01', end: '2026-12-31', today: '2027-01-05',
});
verifie('interventions : CA TTC complet', gros.caSquareTtc, 19668);
verifie('interventions : nombre de commandes', gros.ordersCount, 1788);

// Le compte exactement rond est la signature du défaut : s'il réapparaît,
// c'est qu'une requête a perdu sa pagination.
verifie('aucun compte ne tombe sur 1 000 pile',
  [r.unInvoicedCount, gros.ordersCount].includes(1000), false);


// ═══════════════════════════════════════════════════════════════════════════
//  Verrous à l'enregistrement d'une facture
//
//  Chaque cas correspond à une facture qui est réellement entrée en base
//  fausse : date inventée au 1er janvier, HT recopié dans le TTC, lignes
//  amputées par une réponse tronquée. Le contrôle doit refuser ce qu'il faut
//  ET se taire sur une facture normale — une alerte à tort finit ignorée.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Verrous facture ──');

const AUJOURDHUI = '2026-09-03';
const FACTURE_SAINE = {
  fournisseur: 'Métro', date: '2026-08-28', numero_facture: 'F-2026-4471',
  total_ht: 100, total_ttc: 110, tva: 10, type_document: 'facture',
  lignes: [
    { designation: 'Farine', quantite: 25, unite: 'kg', prix_unitaire_ht: 2, prix_total_ht: 50, categorie: 'alimentaire' },
    { designation: 'Mozzarella', quantite: 5, unite: 'kg', prix_unitaire_ht: 10, prix_total_ht: 50, categorie: 'alimentaire' },
  ],
};
const codes = (inv) => checkInvoice({ ...FACTURE_SAINE, ...inv }, AUJOURDHUI).map(a => a.code);
const niveau = (inv, code) => checkInvoice({ ...FACTURE_SAINE, ...inv }, AUJOURDHUI).find(a => a.code === code)?.level;

verifie('facture saine : aucune anomalie', codes({}).length, 0);
verifie('ticket sans numéro : rien à signaler', codes({ numero_facture: null, type_document: 'ticket_caisse' }).length, 0);

verifie('date absente → bloquant', niveau({ date: null }, 'date-manquante'), 'bloquant');
verifie('date illisible → bloquant', niveau({ date: '2026-13-45' }, 'date-manquante'), 'bloquant');
verifie('date future → bloquant', niveau({ date: '2026-11-02' }, 'date-future'), 'bloquant');
verifie('demain accepté (fuseau)', codes({ date: '2026-09-04' }).includes('date-future'), false);
verifie('HT > TTC → bloquant', niveau({ total_ht: 110, total_ttc: 100, tva: 10 }, 'ht-superieur-ttc'), 'bloquant');
verifie('montants nuls → bloquant', niveau({ total_ht: 0, total_ttc: 0 }, 'montant-nul'), 'bloquant');
verifie('fournisseur vide → bloquant', niveau({ fournisseur: '' }, 'fournisseur-manquant'), 'bloquant');

verifie('1er janvier → à confirmer', niveau({ date: '2026-01-01' }, 'date-premier-janvier'), 'a_confirmer');
verifie('facture de 2 ans → à confirmer', niveau({ date: '2024-06-01' }, 'date-ancienne'), 'a_confirmer');
verifie('17 mois : acceptée sans bruit', codes({ date: '2025-04-15' }).includes('date-ancienne'), false);
verifie('facture sans numéro → à confirmer', niveau({ numero_facture: null }, 'numero-manquant'), 'a_confirmer');
verifie('HT + TVA ≠ TTC → à confirmer', niveau({ tva: 20 }, 'tva-incoherente'), 'a_confirmer');
verifie('arrondi de 3 centimes toléré', codes({ total_ttc: 110.03 }).includes('tva-incoherente'), false);
verifie('HT = TTC sur une facture → à confirmer', niveau({ total_ht: 110, tva: 0 }, 'sans-tva'), 'a_confirmer');
verifie('HT = TTC sur un ticket : normal', codes({ total_ht: 110, tva: 0, type_document: 'ticket_caisse' }).includes('sans-tva'), false);
verifie('lignes qui ne somment pas → à confirmer',
  niveau({ lignes: [FACTURE_SAINE.lignes[0]] }, 'lignes-incoherentes'), 'a_confirmer');
verifie('écart de 1 % sur les lignes toléré', codes({ total_ht: 100.9, total_ttc: 110.9 }).includes('lignes-incoherentes'), false);
verifie('6 000 € TTC → à confirmer', niveau({ total_ht: 5000, total_ttc: 6000, tva: 1000 }, 'montant-inhabituel'), 'a_confirmer');

// Le serveur ne fait pas confiance à l'écran : un point non acquitté refuse.
const tente = (inv, confirmations) => {
  try { assertInvoiceAccepted({ ...FACTURE_SAINE, ...inv }, AUJOURDHUI, confirmations); return 'acceptée'; }
  catch (e) { return e.name === 'InvoiceValidationError' ? 'refusée' : 'erreur'; }
};
verifie('saine, sans acquittement : acceptée', tente({}, []), 'acceptée');
verifie('sans numéro, non acquittée : refusée', tente({ numero_facture: null }, []), 'refusée');
verifie('sans numéro, acquittée : acceptée', tente({ numero_facture: null }, ['numero-manquant']), 'acceptée');
verifie('bloquant acquitté quand même : refusée', tente({ date: null }, ['date-manquante']), 'refusée');
verifie('acquittement d\'un autre code : refusée', tente({ numero_facture: null }, ['sans-tva']), 'refusée');


// ═══════════════════════════════════════════════════════════════════════════
//  Référentiel : fournisseurs et ingrédients
//
//  La règle est l'égalité après normalisation, jamais l'inclusion. Chaque cas
//  ci-dessous est une confusion qui s'est produite : « Tomate » qui capte le
//  concentré, « MÃ©tro » qui dédouble Métro, « Métro » qui capterait Eurométro.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Référentiel ──');

verifie('mojibake réparé', repairMojibake('MÃ©tro'), 'Métro');
verifie('libellé sain intact', repairMojibake('Métro'), 'Métro');
verifie('normalisation : accents, casse, espaces', normalizeName('  MÉTRO   Cash '), 'metro cash');
verifie('normalisation : mojibake puis accents', normalizeName('MÃ©tro'), 'metro');

const FOURNISSEURS = [{ id: 'm', name: 'Métro' }, { id: 'e', name: 'Eurométro' }, { id: 'z', name: 'Mozzalat' }];
verifie('« metro » retrouve Métro', findSupplierMatch('metro', FOURNISSEURS)?.id, 'm');
verifie('« MÃ©tro » retrouve Métro (pas de doublon)', findSupplierMatch('MÃ©tro', FOURNISSEURS)?.id, 'm');
verifie('« Métro » ne capte pas Eurométro', findSupplierMatch('Métro', FOURNISSEURS)?.id, 'm');
verifie('« Métro Cash » inconnu → null (pas d\'inclusion)', findSupplierMatch('Métro Cash', FOURNISSEURS), null);
verifie('nom vide → null', findSupplierMatch('  ', FOURNISSEURS), null);

const INGREDIENTS = [{ id: 't', name: 'Tomate' }, { id: 'c', name: 'Concentré de tomate' }, { id: 'f', name: 'Farine' }];
const ALIAS = [{ alias: normalizeName('FARINE CAPUTO NUVOLA 25KG'), ingredient_id: 'f' }];
verifie('nom exact → ingrédient', matchIngredient('tomate', INGREDIENTS, [])?.id, 't');
verifie('« Concentré de tomate » ne va pas à Tomate', matchIngredient('Concentré de tomate', INGREDIENTS, [])?.id, 'c');
verifie('« TOMATE PELEE 4/4 » : inconnue, pas d\'inclusion', matchIngredient('TOMATE PELEE 4/4', INGREDIENTS, []), null);
verifie('alias validé → ingrédient', matchIngredient('Farine Caputo Nuvola 25kg', INGREDIENTS, ALIAS)?.id, 'f');

const LIGNES = [
  { designation: 'Tomate', unit: 'kg', unit_price_ht: 2 },
  { designation: 'TOMATE PELEE 4/4', unit: 'unité', unit_price_ht: 1.2 },
  { designation: 'Tomate pelée 4/4', unit: 'unité', unit_price_ht: 1.3 },
  { designation: 'FARINE CAPUTO NUVOLA 25KG', unit: 'kg', unit_price_ht: 1.1 },
  { designation: 'Basilic frais', unit: 'kg', unit_price_ht: 9 },
];
const orphelines = unmatchedDesignations(LIGNES, INGREDIENTS, ALIAS);
verifie('désignations orphelines : 2 groupes', orphelines.length, 2);
verifie('regroupées sans accents ni casse', orphelines[0].count, 2);
verifie('la plus achetée d\'abord', orphelines[0].designation, 'TOMATE PELEE 4/4');
verifie('dernier prix conservé', orphelines[0].lastPrice, 1.3);

declenche('3 désignations orphelines → à vérifier',
  { unmatchedDesignations: { count: 3, sample: ['TOMATE PELEE 4/4', 'x', 'y'] } }, 'designations-non-rattachees');
silence('2 orphelines : bruit normal, silence',
  { unmatchedDesignations: { count: 2, sample: ['a', 'b'] } }, 'designations-non-rattachees');


// ═══════════════════════════════════════════════════════════════════════════
//  Compte courant d'associé : jamais débiteur
//
//  Miroir du trigger Postgres (db/migration_cca_verrou.sql). Les deux doivent
//  dire la même chose : si une règle change ici, elle change là.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Compte courant d\'associé ──');

const CCA = [
  { id: 'a1', date: '2026-03-01', associe: 'yohan', sens: 'apport', montant: 1000 },
  { id: 'r1', date: '2026-04-10', associe: 'yohan', sens: 'remboursement', montant: 400 },
  { id: 'a2', date: '2026-06-01', associe: 'yohan', sens: 'apport', montant: 500 },
  { id: 'j1', date: '2026-03-01', associe: 'justine', sens: 'apport', montant: 200 },
];
const rembourse = (date, montant, associe = 'yohan') =>
  checkCcaOperation(CCA, { type: 'insert', movement: { date, associe, sens: 'remboursement', montant } });

verifie('compte sain : aucun creux', firstDebitDay(CCA, 'yohan', '2026-01-01'), null);
verifie('remboursement couvert : accepté', rembourse('2026-05-01', 600), null);
verifie('remboursement trop grand : refusé', rembourse('2026-05-01', 601)?.date, '2026-05-01');
verifie('solde signalé au centime', rembourse('2026-05-01', 601)?.solde, -1);
verifie('rembourser en avril avec l\'apport de juin : refusé', rembourse('2026-04-15', 700)?.date, '2026-04-15');
verifie('le même montant en juillet : accepté', rembourse('2026-07-15', 700), null);
verifie('le même jour qu\'un apport : l\'apport compte d\'abord', rembourse('2026-06-01', 1100), null);
verifie('le même jour, un euro de trop : refusé', rembourse('2026-06-01', 1101)?.date, '2026-06-01');
verifie('les comptes ne se compensent pas entre associés', rembourse('2026-05-01', 201, 'justine')?.date, '2026-05-01');

verifie('ajouter un apport : jamais contrôlé',
  checkCcaOperation(CCA, { type: 'insert', movement: { date: '2026-01-01', associe: 'yohan', sens: 'apport', montant: 1 } }), null);
verifie('supprimer un remboursement : jamais contrôlé',
  checkCcaOperation(CCA, { type: 'delete', movement: CCA[1] }), null);
verifie('supprimer l\'apport initial : refusé dès le remboursement',
  checkCcaOperation(CCA, { type: 'delete', movement: CCA[0] })?.date, '2026-04-10');
verifie('supprimer l\'apport de juin : accepté (rien après lui)',
  checkCcaOperation(CCA, { type: 'delete', movement: CCA[2] }), null);

// Un creux historique n'est pas la faute d'une opération postérieure.
const CREUX = [
  { id: 'x1', date: '2026-02-01', associe: 'yohan', sens: 'remboursement', montant: 100 },
  { id: 'x2', date: '2026-03-01', associe: 'yohan', sens: 'apport', montant: 1000 },
];
verifie('creux ancien détecté', firstDebitDay(CREUX, 'yohan', '2026-01-01')?.date, '2026-02-01');
verifie('remboursement postérieur au creux : accepté quand même',
  checkCcaOperation(CREUX, { type: 'insert', movement: { date: '2026-04-01', associe: 'yohan', sens: 'remboursement', montant: 500 } }), null);


console.log('\n── P&L : écritures ex-masquées ──');
declenche('écritures autrefois masquées → à relire', { legacyMaskedItems: 3 }, 'ecritures-ex-masquees');
silence('rien de masqué : silence', { legacyMaskedItems: 0 }, 'ecritures-ex-masquees');


// ═══════════════════════════════════════════════════════════════════════════
//  Coût matières : achats ± variation de stock
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Coût matières ──');

const COMPTAGES = [
  // Inventaire du 31 mai : farine 100 kg à 1 €, mozza 20 kg à 8 €
  { ingredient_id: 'farine', quantity: 100, unit_price: 1, counted_at: '2026-05-31T20:00:00Z' },
  { ingredient_id: 'mozza',  quantity: 20,  unit_price: 8, counted_at: '2026-05-31T20:05:00Z' },
  // Deux saisies le même soir : la dernière l'emporte
  { ingredient_id: 'mozza',  quantity: 25,  unit_price: 8, counted_at: '2026-05-31T20:30:00Z' },
  // Inventaire du 30 juin : farine 60 kg, mozza 25 kg, et un produit nouveau
  { ingredient_id: 'farine', quantity: 60,  unit_price: 1, counted_at: '2026-06-30T21:00:00Z' },
  { ingredient_id: 'mozza',  quantity: 25,  unit_price: 8, counted_at: '2026-06-30T21:02:00Z' },
  { ingredient_id: 'huile',  quantity: 10,  unit_price: 5, counted_at: '2026-06-30T21:04:00Z' },
];
const SESSIONS = inventorySessions(COMPTAGES);
verifie('deux journées d\'inventaire', SESSIONS.length, 2);
verifie('la plus récente d\'abord', SESSIONS[0].day, '2026-06-30');
verifie('la dernière saisie du soir l\'emporte (mozza 25)', SESSIONS[1].items.get('mozza').quantity, 25);
verifie('valorisation du 31 mai : 100 + 200', SESSIONS[1].valorisation, 300);
verifie('valorisation du 30 juin : 60 + 200 + 50', SESSIONS[0].valorisation, 310);

verifie('borne 30/06 → inventaire du 30/06', sessionAtBoundary(SESSIONS, '2026-06-30')?.day, '2026-06-30');
verifie('borne 03/07 (3 jours) → inventaire du 30/06', sessionAtBoundary(SESSIONS, '2026-07-03')?.day, '2026-06-30');
verifie('borne 15/07 (15 jours) → aucun', sessionAtBoundary(SESSIONS, '2026-07-15'), null);

const juin = computeCogs({ purchases: 1000, sessions: SESSIONS, start: '2026-06-01', end: '2026-06-30' });
verifie('juin : méthode inventaire', juin.method, 'inventaire');
verifie('variation sur les produits communs (farine −40, mozza 0) = −40', juin.stockVariation, -40);
verifie('l\'huile, comptée une seule fois, n\'entre pas', juin.commonProducts, 2);
verifie('consommé = achats − variation = 1000 + 40', juin.cogs, 1040);
verifie('stock initial = inventaire du 31/05', juin.opening?.day, '2026-05-31');

const juillet = computeCogs({ purchases: 900, sessions: SESSIONS, start: '2026-07-01', end: '2026-07-31' });
verifie('juillet sans inventaire de fin : repli achats', juillet.method, 'achats');
verifie('repli : cogs = achats', juillet.cogs, 900);
verifie('repli expliqué', typeof juillet.reason, 'string');

const semaine = computeCogs({ purchases: 200, sessions: SESSIONS, start: '2026-06-28', end: '2026-06-30' });
verifie('période courte : un seul inventaire aux deux bornes → repli', semaine.method, 'achats');

verifie('aucun comptage → repli', computeCogs({ purchases: 10, sessions: [], start: '2026-06-01', end: '2026-06-30' }).method, 'achats');

declenche('mois écoulé sans inventaire de fin → à vérifier',
  { inventoryClosing: { found: false, day: null } }, 'inventaire-fin-de-periode');
silence('inventaire présent : silence',
  { inventoryClosing: { found: true, day: '2026-06-30' } }, 'inventaire-fin-de-periode');
silence('mois en cours : on ne réclame pas encore',
  { inventoryClosing: { found: false, day: null }, end: '2026-07-31', today: '2026-07-10' }, 'inventaire-fin-de-periode');
silence('une semaine : pas d\'inventaire hebdomadaire réclamé',
  { inventoryClosing: { found: false, day: null }, start: '2026-06-22', end: '2026-06-28' }, 'inventaire-fin-de-periode');


console.log('\n── Mois ──');
verifie('bornes de février 2028 (bissextile)', monthBounds('2028-02').end, '2028-02-29');
verifie('bornes de septembre', monthBounds('2026-09').start, '2026-09-01');
verifie('mois invalide refusé', (() => { try { monthBounds('2026-13'); return 'accepté'; } catch { return 'refusé'; } })(), 'refusé');
verifie('12 mois récents, le plus récent d\'abord', recentMonths('2026-09-03', 12)[0], '2026-09');
verifie('le douzième remonte à octobre 2025', recentMonths('2026-09-03', 12)[11], '2025-10');
verifie('août 2026 est écoulé le 3 septembre', isMonthOver('2026-08', '2026-09-03'), true);
verifie('septembre 2026 ne l\'est pas', isMonthOver('2026-09', '2026-09-03'), false);
verifie('un mois se termine le dernier jour inclus', isMonthOver('2026-08', '2026-08-31'), false);

console.log(`\n${echecs === 0 ? '✓ Tous les contrôles comptables passent.' : `✗ ${echecs} contrôle(s) en échec.`}\n`);
process.exit(echecs === 0 ? 0 : 1);
