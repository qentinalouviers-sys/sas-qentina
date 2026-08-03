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
import { isFinancialFlow, estimatedVatRate } from '../src/lib/accounting.ts';

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
        then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
      };
      return q;
    },
  };
}

let echecs = 0;
const cents = v => Math.round(v * 100);

function verifie(nom, reel, attendu) {
  const ok = Math.abs(reel - attendu) < 0.005;
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

console.log(`\n${echecs === 0 ? '✓ Tous les contrôles comptables passent.' : `✗ ${echecs} contrôle(s) en échec.`}\n`);
process.exit(echecs === 0 ? 0 : 1);
