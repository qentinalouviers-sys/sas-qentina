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

// ── Faux client Supabase, qui applique réellement les filtres utilisés ──────
function fakeSupabase(tables) {
  return {
    from(table) {
      let rows = (tables[table] || []).slice();
      const q = {
        select: () => q,
        order: () => q,
        eq(col, v) { rows = rows.filter(r => r[col] === v); return q; },
        lt(col, v) { rows = rows.filter(r => Number(r[col]) < v); return q; },
        gte(col, v) { rows = rows.filter(r => String(r[col]) >= v); return q; },
        lte(col, v) { rows = rows.filter(r => String(r[col]) <= v); return q; },
        in(col, vs) { rows = rows.filter(r => vs.includes(r[col])); return q; },
        limit(n) { rows = rows.slice(0, n); return q; },
        then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
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
  suspectDateInvoices: { count: 0, sample: [] },
  mojibakeSuppliers: [],
  ccaBalances: [{ associe: 'yohan', balance: 1200 }],
  tripsNotInCca: { count: 0 },
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
}), { start: '2026-06-01', end: '2026-06-30', today: '2026-07-05', foodCostPercent: 41 });

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
verifie('dernier service synchronisé', factsBase.lastSyncedService === '2026-06-10', true);

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

console.log(`\n${echecs === 0 ? '✓ Tous les contrôles comptables passent.' : `✗ ${echecs} contrôle(s) en échec.`}\n`);
process.exit(echecs === 0 ? 0 : 1);
