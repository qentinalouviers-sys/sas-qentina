import { orderHtAmount, isFinancialFlow, foldLabel } from '@/lib/accounting';
import { orderTaxCentsByRate, type TvaBreakdown } from '@/lib/tva';
import {
  COMPTES, CHARGES_PAR_CLASSE, CHARGES_PAR_CATEGORIE_LIGNE, BANQUE_PAR_CATEGORIE,
  compteVentes, compteAuxiliaireFournisseur, type Compte,
} from '@/lib/plan-comptable';

/**
 * fec.ts — Les écritures comptables d'un mois, au format que le cabinet importe.
 *
 * L'outil savait tout mais ne sortait rien d'exploitable par un expert-
 * comptable : il ressaisissait. Ce module produit les quatre journaux d'une
 * petite restauration — achats (AC), ventes (VT), banque (BQ), opérations
 * diverses (OD) — et les sérialise au format FEC (art. A47 A-1 du LPF), que
 * tous les logiciels de cabinet importent, ainsi qu'en CSV lisible.
 *
 * Règles tenues, les mêmes que dans le reste de l'outil :
 *  - le chiffre d'affaires vient de Square, une écriture par journée de vente,
 *    éclatée par taux de TVA depuis les données Square elles-mêmes ;
 *  - la TVA déductible vient des factures, et d'elles seules. Un paiement sans
 *    facture passe en charge pour son TTC ;
 *  - chaque écriture est équilibrée au centime — c'est testé.
 *
 * Fonctions pures : elles reçoivent les lignes de la base, rendent des lignes
 * d'écriture. La lecture de la base est dans la route.
 */

export interface FecLine {
  journal: 'AC' | 'VT' | 'BQ' | 'OD';
  journalLib: string;
  /** Numéro d'écriture : toutes les lignes d'une même écriture le partagent. */
  num: string;
  /** Date de l'écriture, ISO. */
  date: string;
  compte: string;
  compteLib: string;
  aux?: string;
  auxLib?: string;
  piece: string;
  pieceDate: string;
  lib: string;
  debit: number;
  credit: number;
}

// ── Données d'entrée (telles que la base les donne) ──────────────────────

export interface OrderRow { id: string; service: string; net_amount: number | null; raw_data: unknown }
export interface InvoiceRow {
  id: string; date: string; invoice_number: string | null; accounting_ref: string | null;
  accounting_class: string | null; total_ht: number | null; total_ttc: number | null;
  tva_recoverable: boolean | null; supplier: { name: string | null } | null;
  lines: { category: string | null; total_ht: number | null }[];
}
export interface BankRow {
  id: string; date: string; description: string | null; amount: number | null;
  category: string | null; invoice_id: string | null;
}
export interface CcaRow {
  id: string; date: string; associe: string; sens: 'apport' | 'remboursement';
  sous_type: string; montant: number; note: string | null;
  bank_transaction_id: string | null; invoice_id: string | null;
}

export interface FecInput {
  month: string;
  orders: OrderRow[];
  invoices: InvoiceRow[];
  bank: BankRow[];
  cca: CcaRow[];
}

const JOURNAUX = {
  AC: 'Achats', VT: 'Ventes', BQ: 'Banque', OD: 'Opérations diverses',
} as const;

const c2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

function isSquarePayout(description: string): boolean {
  const l = foldLabel(description);
  return l.replace(/[\s-]/g, '').includes('squareup') || /\bsquare\b/.test(l);
}

/** Fabrique de lignes pour une écriture : même numéro, même date, même pièce. */
function ecriture(journal: FecLine['journal'], num: string, date: string, piece: string, pieceDate: string) {
  const lines: FecLine[] = [];
  const add = (compte: Compte, lib: string, debit: number, credit: number, aux?: { num: string; lib: string }) => {
    if (cents(debit) === 0 && cents(credit) === 0) return;
    lines.push({
      journal, journalLib: JOURNAUX[journal], num, date,
      compte: compte.num, compteLib: compte.lib,
      aux: aux?.num, auxLib: aux?.lib,
      piece, pieceDate, lib,
      debit: c2(debit), credit: c2(credit),
    });
  };
  return { lines, add };
}

// ── Journal des ventes : une écriture par journée ────────────────────────

const RATE_VALUE: Record<Exclude<keyof TvaBreakdown, 'nonVentile'>, number> = { '5.5%': 0.055, '10%': 0.10, '20%': 0.20 };

export function buildSalesEntries(orders: readonly OrderRow[], month: string): FecLine[] {
  // Agrégation par jour, en centimes : TTC, HT par taux, TVA par taux.
  const days = new Map<string, { ttc: number; ht: number; tax: Record<keyof TvaBreakdown, number>; count: number }>();
  for (const o of orders) {
    const day = String(o.service).slice(0, 10);
    const d = days.get(day) ?? { ttc: 0, ht: 0, tax: { '5.5%': 0, '10%': 0, '20%': 0, nonVentile: 0 }, count: 0 };
    d.ttc += cents(o.net_amount || 0);
    d.ht += cents(orderHtAmount(o));
    const split = orderTaxCentsByRate(o).cents;
    d.tax['5.5%'] += split['5.5%']; d.tax['10%'] += split['10%']; d.tax['20%'] += split['20%']; d.tax.nonVentile += split.nonVentile;
    d.count++;
    days.set(day, d);
  }

  const out: FecLine[] = [];
  let seq = 0;
  for (const day of [...days.keys()].sort()) {
    const d = days.get(day)!;
    if (d.ttc === 0) continue;
    seq++;
    const e = ecriture('VT', `VT-${month.replace('-', '')}-${String(seq).padStart(3, '0')}`, day, `Z-${day}`, day);
    const lib = `Ventes du ${day.split('-').reverse().join('/')} — ${d.count} commande(s) Square`;

    e.add(COMPTES.clientsSquare, lib, d.ttc / 100, 0);

    // HT par taux, déduit de la taxe lue. Le reste du HT (taux non ventilé,
    // arrondis) va au compte de ventes générique, pour que l'écriture tombe
    // juste au centime sur le TTC de la caisse.
    let htAllocated = 0;
    for (const rate of ['10%', '5.5%', '20%'] as const) {
      const tax = d.tax[rate];
      if (tax <= 0) continue;
      const ht = Math.round(tax / RATE_VALUE[rate]);
      htAllocated += ht;
      e.add(compteVentes(rate), `${lib} — HT ${rate}`, 0, ht / 100);
    }
    const totalTax = d.tax['5.5%'] + d.tax['10%'] + d.tax['20%'] + d.tax.nonVentile;
    const htResidual = d.ttc - totalTax - htAllocated;
    if (htResidual !== 0) e.add(compteVentes('nonVentile'), `${lib} — HT non ventilé`, htResidual < 0 ? -htResidual / 100 : 0, htResidual > 0 ? htResidual / 100 : 0);
    if (totalTax !== 0) e.add(COMPTES.tvaCollectee, `${lib} — TVA collectée`, 0, totalTax / 100);

    out.push(...e.lines);
  }
  return out;
}

// ── Journal des achats : une écriture par facture ────────────────────────

export function buildPurchaseEntries(invoices: readonly InvoiceRow[], month: string): FecLine[] {
  const out: FecLine[] = [];
  let seq = 0;
  for (const inv of [...invoices].sort((a, b) => a.date.localeCompare(b.date))) {
    const ttc = cents(inv.total_ttc || 0);
    const ht = cents(inv.total_ht || 0);
    if (ttc === 0 && ht === 0) continue;
    seq++;
    const piece = inv.accounting_ref || inv.invoice_number || inv.id.slice(0, 8);
    const e = ecriture('AC', `AC-${month.replace('-', '')}-${String(seq).padStart(3, '0')}`, inv.date, piece, inv.date);
    const aux = compteAuxiliaireFournisseur(inv.supplier?.name);
    const lib = `${aux.lib} — facture ${inv.invoice_number || 'sans numéro'}`;

    // Charges : par catégorie de ligne quand la facture est ventilée. L'écart
    // entre la somme des lignes et le total HT (remise globale, ligne non lue)
    // va au compte de la classe de la facture : le total de la facture fait foi.
    const byCat = new Map<string, number>();
    for (const l of inv.lines) {
      const key = l.category && CHARGES_PAR_CATEGORIE_LIGNE[l.category] ? l.category : 'autre';
      byCat.set(key, (byCat.get(key) ?? 0) + cents(l.total_ht || 0));
    }
    const classe = CHARGES_PAR_CLASSE[inv.accounting_class || ''] ?? CHARGES_PAR_CLASSE['601'];
    let allocated = 0;
    for (const [cat, amount] of byCat) {
      if (amount === 0) continue;
      e.add(CHARGES_PAR_CATEGORIE_LIGNE[cat], `${lib} — ${cat}`, amount / 100, 0, undefined);
      allocated += amount;
    }
    const tva = ttc - ht;
    const deductible = inv.tva_recoverable !== false && tva > 0;
    // Une TVA non récupérable (ticket sans nom de société) est un coût :
    // elle rejoint la charge plutôt que le compte de TVA.
    const chargeResidual = (ht - allocated) + (deductible ? 0 : tva);
    if (chargeResidual !== 0) e.add(classe, `${lib} — ${allocated ? 'écart lignes/total' : 'total HT'}${deductible ? '' : ' (TVA non récupérable incluse)'}`, chargeResidual / 100, 0);
    if (deductible) e.add(COMPTES.tvaDeductible, `${lib} — TVA déductible`, tva / 100, 0);
    e.add(COMPTES.fournisseurs, lib, 0, ttc / 100, aux);

    out.push(...e.lines);
  }
  return out;
}

// ── Journal de banque : une écriture par mouvement ───────────────────────

export function buildBankEntries(
  bank: readonly BankRow[],
  invoices: readonly InvoiceRow[],
  cca: readonly CcaRow[],
  month: string,
): FecLine[] {
  const supplierByInvoice = new Map(invoices.map(i => [i.id, i.supplier?.name ?? null]));
  const ccaByBankTx = new Map(cca.filter(m => m.bank_transaction_id).map(m => [m.bank_transaction_id!, m]));

  const out: FecLine[] = [];
  let seq = 0;
  for (const t of [...bank].sort((a, b) => a.date.localeCompare(b.date))) {
    const amount = cents(t.amount || 0);
    if (amount === 0) continue;
    seq++;
    const e = ecriture('BQ', `BQ-${month.replace('-', '')}-${String(seq).padStart(4, '0')}`, t.date, `BQ-${t.date}-${seq}`, t.date);
    const desc = (t.description || '').trim() || 'Mouvement bancaire';
    const abs = Math.abs(amount) / 100;

    // Contrepartie, dans l'ordre de certitude : facture lettrée → compte
    // courant → versement Square → catégorie.
    let counterpart: Compte;
    let aux: { num: string; lib: string } | undefined;
    if (t.invoice_id && supplierByInvoice.has(t.invoice_id)) {
      counterpart = COMPTES.fournisseurs;
      aux = compteAuxiliaireFournisseur(supplierByInvoice.get(t.invoice_id));
    } else if (ccaByBankTx.has(t.id)) {
      counterpart = COMPTES.cca;
    } else if (amount > 0 && isSquarePayout(desc)) {
      counterpart = COMPTES.clientsSquare;
    } else if (isFinancialFlow(desc, t.category)) {
      counterpart = BANQUE_PAR_CATEGORIE.flux_financier;
    } else {
      counterpart = BANQUE_PAR_CATEGORIE[t.category || ''] ?? BANQUE_PAR_CATEGORIE.autre;
    }

    if (amount < 0) {
      e.add(counterpart, desc, abs, 0, aux);
      e.add(COMPTES.banque, desc, 0, abs);
    } else {
      e.add(COMPTES.banque, desc, abs, 0);
      e.add(counterpart, desc, 0, abs, aux);
    }
    out.push(...e.lines);
  }
  return out;
}

// ── Opérations diverses : compte courant hors banque ─────────────────────

export function buildCcaEntries(cca: readonly CcaRow[], invoices: readonly InvoiceRow[], month: string): FecLine[] {
  const supplierByInvoice = new Map(invoices.map(i => [i.id, i.supplier?.name ?? null]));
  const out: FecLine[] = [];
  let seq = 0;
  for (const m of [...cca].sort((a, b) => a.date.localeCompare(b.date))) {
    // Un mouvement adossé à un mouvement bancaire est déjà dans le journal de banque.
    if (m.bank_transaction_id) continue;
    const amount = c2(m.montant || 0);
    if (amount === 0) continue;
    seq++;
    const e = ecriture('OD', `OD-${month.replace('-', '')}-${String(seq).padStart(3, '0')}`, m.date, `CCA-${m.id.slice(0, 8)}`, m.date);
    const nom = m.associe.charAt(0).toUpperCase() + m.associe.slice(1);
    const lib = m.note?.trim() || `${m.sens === 'apport' ? 'Apport' : 'Remboursement'} ${nom} — ${m.sous_type.replace(/_/g, ' ')}`;

    if (m.sens === 'apport') {
      if (m.sous_type === 'facture_payee_perso') {
        // La facture est déjà passée en charge (journal des achats) : l'associé
        // a payé le fournisseur à la place de la société.
        e.add(COMPTES.fournisseurs, lib, amount, 0, compteAuxiliaireFournisseur(m.invoice_id ? supplierByInvoice.get(m.invoice_id) : null));
      } else if (m.sous_type === 'frais_perso_reverse') {
        e.add(COMPTES.deplacements, lib, amount, 0);
      } else {
        e.add(COMPTES.attente, `${lib} (sans mouvement bancaire)`, amount, 0);
      }
      e.add(COMPTES.cca, `${lib} — ${nom}`, 0, amount);
    } else {
      e.add(COMPTES.cca, `${lib} — ${nom}`, amount, 0);
      e.add(COMPTES.attente, `${lib} (sans mouvement bancaire)`, 0, amount);
    }
    out.push(...e.lines);
  }
  return out;
}

// ── Assemblage et contrôle ────────────────────────────────────────────────

export function buildEntries(input: FecInput): FecLine[] {
  return [
    ...buildPurchaseEntries(input.invoices, input.month),
    ...buildSalesEntries(input.orders, input.month),
    ...buildBankEntries(input.bank, input.invoices, input.cca, input.month),
    ...buildCcaEntries(input.cca, input.invoices, input.month),
  ];
}

/** Écritures dont débit ≠ crédit. Doit être vide : c'est testé. */
export function unbalancedEntries(lines: readonly FecLine[]): { num: string; debit: number; credit: number }[] {
  const byNum = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const e = byNum.get(l.num) ?? { debit: 0, credit: 0 };
    e.debit += cents(l.debit);
    e.credit += cents(l.credit);
    byNum.set(l.num, e);
  }
  return [...byNum].filter(([, e]) => e.debit !== e.credit).map(([num, e]) => ({ num, debit: e.debit / 100, credit: e.credit / 100 }));
}

// ── Sérialisation ─────────────────────────────────────────────────────────

const fecDate = (iso: string) => iso.replace(/-/g, '');
const fecAmount = (n: number) => n.toFixed(2).replace('.', ',');
const clean = (s: string | undefined) => (s ?? '').replace(/[\t\r\n|]/g, ' ').trim();

/**
 * Fichier des écritures comptables : 18 colonnes tabulées, une ligne par
 * mouvement, dates AAAAMMJJ, décimales à la virgule. `validDate` est la date
 * de validation (clôture) ; vide si le mois n'est pas clôturé.
 */
export function toFec(lines: readonly FecLine[], validDate: string | null): string {
  const header = [
    'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib',
    'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
    'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
  ];
  const rows = lines.map(l => [
    l.journal, JOURNAUX[l.journal], l.num, fecDate(l.date), l.compte, clean(l.compteLib),
    clean(l.aux), clean(l.auxLib), clean(l.piece), fecDate(l.pieceDate), clean(l.lib),
    fecAmount(l.debit), fecAmount(l.credit),
    '', '', validDate ? fecDate(validDate) : '', '', '',
  ].join('\t'));
  return [header.join('\t'), ...rows].join('\r\n') + '\r\n';
}

/** CSV lisible (séparateur point-virgule, décimales à la virgule), pour un tableur. */
export function toCsv(lines: readonly FecLine[]): string {
  const q = (s: string | undefined) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = ['Journal', 'Écriture', 'Date', 'Compte', 'Libellé compte', 'Auxiliaire', 'Pièce', 'Libellé', 'Débit', 'Crédit'];
  const rows = lines.map(l => [
    l.journal, l.num, l.date, l.compte, q(l.compteLib), q(l.auxLib ? `${l.aux} ${l.auxLib}` : ''),
    q(l.piece), q(l.lib), fecAmount(l.debit), fecAmount(l.credit),
  ].join(';'));
  return '﻿' + [header.join(';'), ...rows].join('\r\n') + '\r\n';
}
