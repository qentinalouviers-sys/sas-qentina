/**
 * interventions.ts — Ce qui empêche les chiffres d'être justes.
 *
 * Un tableau de bord qui affiche un food cost de 12 % ou de 80 % ne se trompe
 * presque jamais dans son calcul : il lui manque des données. Le ratio est
 * faux parce que le chiffre d'affaires est incomplet, parce qu'un achat est
 * compté deux fois, ou parce qu'une facture n'a jamais été rattachée.
 *
 * Ce module ne corrige rien. Il **nomme** chacun de ces manques, chiffre ce
 * qu'il coûte, et dit où aller le réparer. C'est le seul écran qui doit être
 * regardé avant de croire un ratio.
 *
 * ── Deux règles d'écriture ──
 *
 * 1. **Aucune intervention sans preuve arithmétique.** Chaque règle ci-dessous
 *    repose sur une inégalité qu'on peut refaire à la main. Une alerte qui se
 *    déclenche à tort est pire que pas d'alerte : elle apprend à ignorer le
 *    module.
 *
 * 2. **La détection est une fonction pure.** `detectInterventions` ne touche
 *    ni à la base ni à l'horloge : elle reçoit des faits et renvoie des
 *    constats. C'est ce qui la rend vérifiable (voir `npm run verify:compta`).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { foldLabel, isFinancialFlow, round2 } from './accounting';
import { computeTva, TvaResult } from './tva';

/**
 * Gravité, du point de vue du seul critère qui compte : est-ce que les
 * chiffres affichés sont faux ?
 *
 *  - `critique`  : un indicateur est faux aujourd'hui. Ne pas s'y fier.
 *  - `important` : un indicateur est approximatif, ou un risque juridique court.
 *  - `a_verifier`: une anomalie probable, à confirmer.
 */
export type Severity = 'critique' | 'important' | 'a_verifier';

export interface Intervention {
  /** Identifiant stable — sert de clé React et de repère dans le temps. */
  id: string;
  severity: Severity;
  /** Le constat, chiffré. Se lit seul. */
  title: string;
  /** Ce que le chiffre faux fait croire. La raison d'agir. */
  impact: string;
  /** Ce qu'il faut faire, à l'impératif. Une seule action. */
  action: string;
  /** Où aller la faire. */
  href: string;
  hrefLabel: string;
  /** Montant en jeu, s'il y en a un. Affiché, et utile aux tests. */
  amount?: number;
}

/**
 * Les faits, tels que la base les donne. Tout est déjà borné à la période.
 *
 * Les dates sont des chaînes ISO (`YYYY-MM-DD`) : `Date` en JavaScript décale
 * selon le fuseau du serveur, et une facture datée du 1er du mois ne doit pas
 * changer de mois selon l'endroit où tourne le code.
 */
export interface InterventionFacts {
  start: string;
  end: string;
  /** Aujourd'hui, en ISO. Passé en paramètre pour que les tests soient stables. */
  today: string;

  /** Chiffre d'affaires Square enregistré sur la période, TTC. */
  caSquareTtc: number;
  /** Idem en HT — base de tous les ratios du métier. */
  caSquareHt: number;
  /** Nombre de commandes Square sur la période. */
  ordersCount: number;
  /** Jours (ISO) de la période comportant au moins une commande. */
  daysWithSales: string[];
  /** Dernier jour de service Square enregistré en base, toutes périodes. */
  lastSyncedService: string | null;

  /** Versements Square reçus sur le compte pendant la période (crédits). */
  squarePayoutsTtc: number;
  squarePayoutsCount: number;

  /** Dépenses bancaires de la période, hors flux financiers. */
  debitsCount: number;
  /** Dépenses sans catégorie exploitable — elles finissent en « autres ». */
  uncategorizedDebits: { count: number; amount: number };

  /** Résultat TVA de la période (source de vérité unique). */
  tva: TvaResult;

  /** Coût matières en % du CA HT, tel que le P&L le calcule. */
  foodCostPercent: number | null;

  /** Factures dont la date est un 1er janvier — date de repli type de l'OCR. */
  suspectDateInvoices: { count: number; sample: string[] };
  /** Fournisseurs dont le nom porte des caractères d'encodage cassé. */
  mojibakeSuppliers: string[];

  /** Solde du compte courant par associé (positif = la société lui doit). */
  ccaBalances: { associe: string; balance: number }[];

  /** Trajets non portés au compte courant d'associé. */
  tripsNotInCca: { count: number };
}

const SEVERITY_RANK: Record<Severity, number> = {
  critique: 0, important: 1, a_verifier: 2,
};

/** Formate un euro pour un libellé d'alerte (pas d'espace insécable ici). */
function eur(n: number): string {
  return `${Math.round(n).toLocaleString('fr-FR')} €`;
}

/** `2026-07-24` → `24/07/2026`. Découpage de chaîne, sans passer par `Date`. */
function jour(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Pourcentage à une décimale, virgule française. */
function pct(n: number): string {
  return `${n.toFixed(1).replace('.', ',')} %`;
}

/** Nombre de jours entre deux dates ISO, bornes incluses. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Ajoute n jours à une date ISO, en UTC pour ne pas dériver. */
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Plus longue série de jours consécutifs sans aucune vente.
 *
 * La fenêtre examinée s'arrête deux jours avant **le plus proche** de la fin de
 * période et d'aujourd'hui. Les deux bornes comptent, et pour deux raisons
 * différentes :
 *
 *  - la fin de période, parce que la synchro nocturne n'a pas encore tourné
 *    pour les tout derniers jours ;
 *  - **aujourd'hui**, parce que la période sélectionnée est le plus souvent le
 *    mois en cours : sa fin est dans le futur. Sans cette borne, l'outil
 *    annonçait « 28 jours consécutifs sans aucune vente » le 3 du mois — en
 *    comptant des jours qui n'ont pas encore eu lieu.
 */
function longestSalesGap(
  start: string, end: string, daysWithSales: string[], today: string,
): { length: number; from: string; to: string } | null {
  const sold = new Set(daysWithSales);
  const horizon = end < today ? end : today;
  const lastMeaningful = addDays(horizon, -2);
  const span = daysBetween(start, lastMeaningful);
  if (span < 0) return null;

  let best: { length: number; from: string; to: string } | null = null;
  let runStart: string | null = null;
  let runLength = 0;

  for (let i = 0; i <= span; i++) {
    const day = addDays(start, i);
    if (sold.has(day)) {
      runStart = null;
      runLength = 0;
      continue;
    }
    if (runStart === null) runStart = day;
    runLength++;
    if (!best || runLength > best.length) {
      best = { length: runLength, from: runStart, to: day };
    }
  }
  return best;
}

/**
 * Établit la liste des interventions. Fonction pure.
 *
 * L'ordre de sortie est celui dans lequel il faut travailler : par gravité,
 * et à gravité égale dans l'ordre causal. Une intervention en tête de liste
 * rend souvent fausses celles qui la suivent — corriger le chiffre d'affaires
 * avant de s'inquiéter d'un ratio évite de courir après une conséquence.
 */
export function detectInterventions(f: InterventionFacts): Intervention[] {
  const out: Intervention[] = [];

  // ── 1. La caisse ne se synchronise plus ──────────────────────────────────
  // Sans synchro, tout le reste est faux : le CA est la base de chaque ratio.
  if (f.lastSyncedService) {
    const staleDays = daysBetween(f.lastSyncedService, f.today);
    if (staleDays >= 3) {
      out.push({
        id: 'square-desynchronise',
        severity: 'critique',
        title: `Caisse Square muette depuis ${staleDays} jours`,
        impact:
          `La dernière vente enregistrée date du ${jour(f.lastSyncedService)}. Tant que la ` +
          `caisse ne remonte pas, le chiffre d'affaires, la TVA collectée et le ` +
          `food cost sont sous-évalués — le food cost paraît énorme parce qu'il ` +
          `est divisé par un CA amputé.`,
        action:
          `Vérifie que la variable CRON_SECRET existe bien dans Vercel (Production) : ` +
          `sans elle la synchro nocturne refuse de tourner. Puis lance un rattrapage.`,
        href: '/reglages',
        hrefLabel: 'Réglages → Historique Square',
      });
    }
  } else if (f.ordersCount === 0) {
    out.push({
      id: 'square-jamais-synchronise',
      severity: 'critique',
      title: 'Aucune vente Square en base',
      impact:
        `Sans ventes, il n'y a pas de chiffre d'affaires : tous les ratios ` +
        `(food cost, masse salariale, marge) sont sans objet, et la TVA ` +
        `collectée est à zéro.`,
      action: 'Lance une reprise de l\'historique Square sur 12 mois.',
      href: '/reglages',
      hrefLabel: 'Réglages → Historique Square',
    });
  }

  // ── 2. Les versements Square dépassent le CA enregistré ──────────────────
  // Preuve arithmétique, sans hypothèse : un versement Square est la part
  // CARTE des ventes, DÉDUITE de la commission. Le CA TTC est donc forcément
  // supérieur au total versé. S'il est inférieur, il manque des ventes — et
  // l'écart réel est encore plus grand que celui affiché, puisque ni les
  // espèces ni la commission ne sont comptées ici.
  if (f.squarePayoutsTtc > 0) {
    const gap = f.squarePayoutsTtc - f.caSquareTtc;
    const relative = gap / f.squarePayoutsTtc;
    if (gap > 500 && relative > 0.05) {
      out.push({
        id: 'ca-square-incomplet',
        severity: 'critique',
        title: `Au moins ${eur(gap)} de ventes manquantes`,
        impact:
          `La banque a reçu ${eur(f.squarePayoutsTtc)} de versements Square ` +
          `(${f.squarePayoutsCount} virements) alors que seulement ` +
          `${eur(f.caSquareTtc)} de ventes sont enregistrés. Un versement Square ` +
          `ne contient que les paiements par carte, commission déjà déduite : le ` +
          `CA devrait donc être PLUS élevé que les versements, jamais moins. ` +
          `L'écart réel est supérieur à ce montant. Un CA amputé gonfle ` +
          `mécaniquement le food cost et minore la TVA collectée.`,
        action:
          'Lance une reprise de l\'historique Square sur 12 mois, puis reviens ' +
          'vérifier que cette alerte a disparu.',
        href: '/reglages',
        hrefLabel: 'Réglages → Historique Square',
        amount: gap,
      });
    }
  }

  // ── 3. Trous dans l'historique des ventes ────────────────────────────────
  const gap = longestSalesGap(f.start, f.end, f.daysWithSales, f.today);
  if (gap && gap.length >= 3) {
    out.push({
      id: 'trou-historique-ventes',
      severity: f.ordersCount > 0 ? 'important' : 'critique',
      title: `${gap.length} jours consécutifs sans aucune vente`,
      impact:
        `Du ${jour(gap.from)} au ${jour(gap.to)}, aucune commande n'est enregistrée. Soit la ` +
        `pizzeria était fermée — et c'est normal —, soit la caisse n'a pas été ` +
        `synchronisée sur cette période et le CA du mois est incomplet.`,
      action:
        'Compare avec ton planning d\'ouverture. Si tu étais ouvert, relance une ' +
        'reprise Square couvrant ces dates.',
      href: '/ventes',
      hrefLabel: 'Ventes → vérifier ces dates',
    });
  }

  // ── 4. TVA collectée non ventilée par taux ───────────────────────────────
  const nonVentile = Math.abs(f.tva.collectedTvaBreakdown.nonVentile);
  if (nonVentile > 20 && f.tva.collectedTva > 0 && nonVentile / f.tva.collectedTva > 0.02) {
    out.push({
      id: 'tva-non-ventilee',
      severity: 'important',
      title: `${eur(nonVentile)} de TVA collectée sans taux identifié`,
      impact:
        `Une déclaration de TVA se remplit taux par taux. Ce montant n'a pas pu ` +
        `être rattaché à 5,5 %, 10 % ou 20 % : soit la commande Square n'a pas de ` +
        `détail de lignes, soit une remise a été appliquée au niveau de la ` +
        `commande. Le total collecté reste juste, mais sa répartition est ` +
        `incomplète.`,
      action:
        'Ouvre la page TVA et regarde la ligne « non ventilé » : elle liste les ' +
        'commandes concernées. Vérifie que tes taxes sont bien paramétrées dans Square.',
      href: '/tva',
      hrefLabel: 'TVA → ventilation par taux',
      amount: nonVentile,
    });
  }

  // ── 5. Dépenses sans facture ─────────────────────────────────────────────
  // L'article 271 du CGI subordonne la déduction à une facture. Ce n'est pas
  // une approximation qu'on peut lever par un calcul : il faut la pièce.
  if (f.tva.recoverableIfInvoiced > 200) {
    out.push({
      id: 'depenses-sans-facture',
      severity: f.tva.recoverableIfInvoiced > 1000 ? 'critique' : 'important',
      title: `${eur(f.tva.recoverableIfInvoiced)} de TVA perdue faute de factures`,
      impact:
        `${f.tva.unInvoicedCount} dépenses (${eur(f.tva.unInvoicedAmount)} TTC) n'ont ` +
        `aucune facture rattachée. L'article 271 du CGI interdit de déduire cette ` +
        `TVA sans la pièce : ce montant est de l'argent que tu paies sans le ` +
        `récupérer. Et sans facture, le détail de l'achat est inconnu, donc le ` +
        `coût matières est approximatif.`,
      action:
        'Scanne les factures manquantes, puis rattache chaque paiement bancaire à ' +
        'sa facture depuis la page Banque.',
      href: '/banque',
      hrefLabel: 'Banque → rapprochement',
      amount: f.tva.recoverableIfInvoiced,
    });
  }

  // ── 6. Dépenses non catégorisées ─────────────────────────────────────────
  if (f.uncategorizedDebits.count > 0 && f.uncategorizedDebits.amount > 300) {
    out.push({
      id: 'depenses-non-categorisees',
      severity: 'important',
      title: `${eur(f.uncategorizedDebits.amount)} de dépenses non classées`,
      impact:
        `${f.uncategorizedDebits.count} mouvements n'ont pas de catégorie et ` +
        `atterrissent dans « autres charges ». Ils ne sont donc ni dans le coût ` +
        `matières, ni dans les charges fixes : les deux ratios sont faussés, et ` +
        `l'outil ne fait aucune hypothèse de TVA sur eux (par prudence).`,
      action: 'Ouvre la page Banque et attribue une catégorie à chaque mouvement gris.',
      href: '/banque',
      hrefLabel: 'Banque → catégoriser',
      amount: f.uncategorizedDebits.amount,
    });
  }

  // ── 7. Food cost hors de tout intervalle plausible ───────────────────────
  // Ne se déclenche qu'une fois qu'il y a du CA ET des achats : sinon c'est
  // une conséquence des alertes précédentes, pas un problème en soi.
  if (f.foodCostPercent !== null && f.caSquareHt > 0) {
    const fc = f.foodCostPercent;
    if (fc > 45) {
      out.push({
        id: 'food-cost-trop-haut',
        severity: 'important',
        title: `Food cost à ${pct(fc)} — hors norme`,
        impact:
          `Une pizzeria napolitaine tourne entre 28 et 32 %. Au-delà de 45 %, ` +
          `deux causes seulement : il manque du chiffre d'affaires, ou un achat ` +
          `est compté deux fois (une facture scannée ET son paiement bancaire non ` +
          `rapproché).`,
        action:
          'Traite d\'abord les alertes de chiffre d\'affaires ci-dessus. Puis ouvre ' +
          'le détail du coût matières dans le P&L pour repérer un doublon.',
        href: '/pnl',
        hrefLabel: 'P&L → détail coût matières',
        amount: fc,
      });
    } else if (fc > 0 && fc < 15) {
      out.push({
        id: 'food-cost-trop-bas',
        severity: 'important',
        title: `Food cost à ${pct(fc)} — trop beau`,
        impact:
          `Aucune pizzeria n'achète sa matière première à moins de 15 % de son ` +
          `chiffre d'affaires. Ce ratio veut dire qu'il manque des achats : ` +
          `factures non scannées, ou mouvements bancaires non catégorisés en ` +
          `fournisseur.`,
        action: 'Scanne les factures fournisseurs manquantes du mois.',
        href: '/scanner',
        hrefLabel: 'Scanner → importer les factures',
        amount: fc,
      });
    }
  }

  // ── 8. Compte courant d'associé débiteur ─────────────────────────────────
  // Un solde négatif signifie que la société a avancé de l'argent à l'associé.
  // Pour un gérant de SAS, l'article L.225-43 du code de commerce l'interdit,
  // et le risque est qualifié d'abus de biens sociaux.
  for (const { associe, balance } of f.ccaBalances) {
    if (balance < -100) {
      out.push({
        id: `cca-debiteur-${associe}`,
        severity: 'critique',
        title: `Compte courant de ${associe} débiteur de ${eur(Math.abs(balance))}`,
        impact:
          `La société a avancé cet argent à l'associé. Pour un dirigeant, c'est ` +
          `interdit (art. L.225-43 du code de commerce) et qualifiable d'abus de ` +
          `biens sociaux. Un contrôle le relève immédiatement.`,
        action:
          'Rembourse la société, ou reclasse le mouvement s\'il s\'agit en réalité ' +
          'd\'une dépense professionnelle payée par la société.',
        href: '/cca',
        hrefLabel: 'Comptes Associés',
        amount: Math.abs(balance),
      });
    }
  }

  // ── 9. Factures à date de repli (01/01) ──────────────────────────────────
  if (f.suspectDateInvoices.count > 0) {
    out.push({
      id: 'factures-date-suspecte',
      severity: 'a_verifier',
      title: `${f.suspectDateInvoices.count} facture(s) datée(s) d'un 1er janvier`,
      impact:
        `Le 1er janvier est la date que l'OCR écrit quand il n'a pas su lire ` +
        `celle de la facture. Une facture mal datée tombe dans le mauvais mois : ` +
        `elle fausse le food cost de deux mois à la fois, et la TVA du trimestre.`,
      action: 'Ouvre ces factures et corrige la date à la main.',
      href: '/factures',
      hrefLabel: 'Factures → corriger les dates',
    });
  }

  // ── 10. Fournisseurs dupliqués par un encodage cassé ─────────────────────
  if (f.mojibakeSuppliers.length > 0) {
    out.push({
      id: 'fournisseurs-mojibake',
      severity: 'a_verifier',
      title: `${f.mojibakeSuppliers.length} fournisseur(s) au nom mal encodé`,
      impact:
        `« ${f.mojibakeSuppliers[0]} » contient des caractères d'encodage cassé. ` +
        `Le même fournisseur existe donc deux fois sous deux orthographes, et ses ` +
        `achats sont répartis entre les deux fiches : aucun des deux totaux n'est ` +
        `exploitable.`,
      action: 'Renomme la fiche fautive, puis fusionne-la avec la fiche correcte.',
      href: '/factures',
      hrefLabel: 'Factures → fournisseurs',
    });
  }

  // ── 11. Trajets non portés au compte courant ─────────────────────────────
  if (f.tripsNotInCca.count > 0) {
    out.push({
      id: 'trajets-hors-cca',
      severity: 'a_verifier',
      title: `${f.tripsNotInCca.count} trajet(s) non comptabilisé(s)`,
      impact:
        `Ces trajets sont détectés mais pas portés au compte courant d'associé : ` +
        `l'indemnité kilométrique n'est donc pas une charge de la société, et le ` +
        `résultat est surévalué d'autant.`,
      action: 'Ouvre la note de frais et porte les trajets au compte courant.',
      href: '/trajets',
      hrefLabel: 'Frais kilométriques',
    });
  }

  // Tri par gravité uniquement. `sort` étant stable, l'ordre de déclaration
  // ci-dessus est conservé à l'intérieur d'une gravité — et cet ordre est
  // délibéré : c'est l'ordre CAUSAL. La caisse d'abord, puis le chiffre
  // d'affaires, puis ce qui en découle. Trier par montant remonterait des
  // conséquences avant leur cause.
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Reconnaît un versement Square sur le relevé.
 *
 * Le libellé réel du relevé est de la forme « VIR SEPA SQUAREUP … ». On teste
 * la forme sans espaces en plus de la forme normale : les relevés écrivent
 * indifféremment « SQUAREUP », « SQUARE UP » ou « SQUARE-UP », et un unique
 * test sur « square » attraperait aussi un « SQUARE MARKETING ».
 */
function isSquarePayout(description: string): boolean {
  const l = foldLabel(description);
  const tight = l.replace(/[\s-]/g, '');
  return tight.includes('squareup') || /\bsquare\b/.test(l);
}

/** Rassemble les faits depuis la base. Aucune décision ici. */
export async function collectInterventionFacts(
  supabase: SupabaseClient,
  opts: { start: string; end: string; today: string; foodCostPercent?: number | null },
): Promise<InterventionFacts> {
  const { start, end, today } = opts;

  const [ordersRes, lastRes, bankRes, invoicesRes, suppliersRes, ccaRes, tripsRes, tva] =
    await Promise.all([
      supabase.from('square_orders')
        .select('service, net_amount, raw_data')
        .gte('service', start).lte('service', end),
      supabase.from('square_orders')
        .select('service')
        .order('service', { ascending: false })
        .limit(1),
      supabase.from('bank_transactions')
        .select('date, description, amount, category, invoice_id')
        .gte('date', start).lte('date', end),
      supabase.from('invoices').select('id, date'),
      supabase.from('suppliers').select('name'),
      supabase.from('mouvements_cca').select('associe, sens, montant'),
      supabase.from('mileage_trips').select('id, cca_movement_id'),
      computeTva(supabase, start, end),
    ]);

  // ── Ventes Square ────────────────────────────────────────────────────────
  const orders = (ordersRes.data || []) as any[];
  let caSquareTtc = 0;
  let caSquareHt = 0;
  const daysWithSales = new Set<string>();

  for (const o of orders) {
    const ttc = o.net_amount || 0;
    const raw = o.raw_data || {};
    const tax =
      (raw.total_tax_money?.amount || raw.net_amounts?.tax_money?.amount || 0) / 100;
    caSquareTtc += ttc;
    caSquareHt += ttc - tax;
    if (o.service) daysWithSales.add(String(o.service).slice(0, 10));
  }

  // ── Banque ───────────────────────────────────────────────────────────────
  const bank = (bankRes.data || []) as any[];
  let squarePayoutsTtc = 0;
  let squarePayoutsCount = 0;
  let debitsCount = 0;
  let uncatCount = 0;
  let uncatAmount = 0;

  for (const t of bank) {
    const amount = t.amount || 0;
    const description: string = t.description || '';
    if (isFinancialFlow(description, t.category)) continue;

    if (amount > 0) {
      if (isSquarePayout(description)) {
        squarePayoutsTtc += amount;
        squarePayoutsCount++;
      }
      continue;
    }

    debitsCount++;
    // « autre » et l'absence de catégorie ont le même effet comptable : la
    // dépense n'est rattachée à aucun poste et l'outil ne suppose aucune TVA.
    if (!t.category || t.category === 'autre') {
      uncatCount++;
      uncatAmount += Math.abs(amount);
    }
  }

  // ── Factures : dates de repli ────────────────────────────────────────────
  const invoices = (invoicesRes.data || []) as any[];
  const suspect = invoices.filter(i => /^\d{4}-01-01$/.test(String(i.date || '')));

  // ── Fournisseurs : encodage cassé ────────────────────────────────────────
  // « Ã » et « Â » ne peuvent pas apparaître dans un nom français correct : ce
  // sont les octets d'un caractère UTF-8 relu comme du latin-1 (« MÃ©tro »).
  const mojibake = ((suppliersRes.data || []) as any[])
    .map(s => String(s.name || ''))
    .filter(n => /[ÃÂ]/.test(n) || n.includes('�'));

  // ── Comptes courants d'associés ──────────────────────────────────────────
  const balances = new Map<string, number>();
  for (const m of (ccaRes.data || []) as any[]) {
    const signed = m.sens === 'apport' ? (m.montant || 0) : -(m.montant || 0);
    balances.set(m.associe, round2((balances.get(m.associe) || 0) + signed));
  }

  const tripsNotInCca = ((tripsRes.data || []) as any[])
    .filter(t => !t.cca_movement_id).length;

  return {
    start, end, today,
    caSquareTtc: round2(caSquareTtc),
    caSquareHt: round2(caSquareHt),
    ordersCount: orders.length,
    daysWithSales: [...daysWithSales].sort(),
    lastSyncedService: lastRes.data?.[0]?.service
      ? String(lastRes.data[0].service).slice(0, 10)
      : null,
    squarePayoutsTtc: round2(squarePayoutsTtc),
    squarePayoutsCount,
    debitsCount,
    uncategorizedDebits: { count: uncatCount, amount: round2(uncatAmount) },
    tva,
    foodCostPercent: opts.foodCostPercent ?? null,
    suspectDateInvoices: {
      count: suspect.length,
      sample: suspect.slice(0, 5).map(i => String(i.date)),
    },
    mojibakeSuppliers: mojibake,
    ccaBalances: [...balances].map(([associe, balance]) => ({ associe, balance })),
    tripsNotInCca: { count: tripsNotInCca },
  };
}
