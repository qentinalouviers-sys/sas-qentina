/**
 * accounting.ts — Règles comptables partagées. Source de vérité UNIQUE.
 *
 * Ce fichier existe pour une raison précise : la TVA, le P&L et le tableau de
 * bord doivent répondre le même chiffre. Chaque fois qu'un de ces écrans a
 * recalculé les choses à sa façon, les montants ont divergé.
 *
 * Deux notions y sont définies :
 *
 *  1. Le FLUX FINANCIER — un prêt, un apport, un mouvement de compte courant,
 *     un virement de trésorerie entre sociétés, un retrait d'espèces. Ce n'est
 *     ni un achat, ni une vente : c'est de l'argent qui se déplace. Il n'ouvre
 *     aucun droit à déduction de TVA (art. 271 CGI : pas de livraison, pas de
 *     prestation, pas de facture) et n'a rien à faire dans un compte de
 *     résultat d'exploitation.
 *
 *  2. Le TAUX DE TVA INDICATIF — utilisé uniquement pour estimer ce qui
 *     *pourrait* être récupéré si la facture était rattachée. Jamais pour un
 *     chiffre déclarable.
 */

/** Retire les accents et met en minuscules, pour comparer des libellés. */
export function foldLabel(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marques diacritiques combinantes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Catégorie explicite pour les flux financiers.
 *
 * Elle n'est pas indispensable : la reconnaissance par libellé ci-dessous
 * fonctionne sur les écritures déjà en base, sans migration. La catégorie
 * permet en plus de corriger un cas à la main quand la règle se trompe.
 */
export const FINANCIAL_CATEGORY = 'flux_financier';

/**
 * Motifs de flux financiers.
 *
 * Écrits en expressions régulières et non en simples fragments : « pret »
 * cherché tel quel se retrouverait dans « interprete » ou « pretre ». Les
 * bornes de mot évitent ce genre de faux positif, qui écarterait par erreur
 * une charge réelle du compte de résultat.
 */
const FINANCIAL_PATTERNS: RegExp[] = [
  // Sociétés du groupe et mouvements de holding
  /\bholding\b/,
  /pizza\s*milano/,
  /\bde\s+faria\b/,
  /\btekotek\b/,

  // Prêts, apports, trésorerie
  /\bpret(s|e)?\b/,
  /\bemprunt/,
  /\btreso/,          // treso, tresorerie
  /\bapport/,

  // Compte courant d'associé. Le libellé s'écrit « associé » ou, faute de
  // frappe fréquente dans les virements, « assosié » : la classe [cs] couvre
  // les deux. Un motif qui n'aurait reconnu que la faute aurait laissé passer
  // l'orthographe correcte — c'était le cas au premier essai.
  /c(?:om)?pte\s+asso[cs]/,
  /\bc\/c\b/,
  /compte\s+courant/,

  // Espèces et mouvements internes
  /\bretrait\b/,
  /\bvirement\s+interne\b/,
  /\bvir\s+interne\b/,
];

/**
 * Vrai si l'écriture est un flux financier, donc hors exploitation et hors
 * champ de la TVA.
 *
 * @param description libellé bancaire
 * @param category    catégorie enregistrée, si elle existe (prévaut sur la règle)
 */
export function isFinancialFlow(description: string, category?: string | null): boolean {
  if (category === FINANCIAL_CATEGORY) return true;
  const l = foldLabel(description);
  if (!l) return false;
  return FINANCIAL_PATTERNS.some(re => re.test(l));
}

/**
 * Taux de TVA **indicatif** d'une catégorie de dépense.
 *
 * Sert uniquement à estimer la TVA récupérable *si* une facture était
 * rattachée. Ne jamais s'en servir pour un montant déclaré.
 *
 * Le principe retenu est la prudence : une catégorie inconnue renvoie 0.
 * L'ancienne version renvoyait 20 % pour « autre », ce qui fabriquait de la
 * TVA déductible sur tout ce que l'outil n'avait pas su classer — soit
 * 2 557 € sur deux mois de relevé réel.
 */
export function estimatedVatRate(category: string | null | undefined): number {
  switch (category) {
    case 'variable_fournisseur': return 0.10; // alimentaire, taux dominant
    case 'fixe_loyer':           return 0.20;
    case 'fixe_abonnement':      return 0.20;
    case 'fixe_assurance':       return 0;    // primes exonérées de TVA
    case 'variable_salaire':     return 0;
    case 'impot_taxe':           return 0;
    case 'recette':              return 0;    // ce n'est pas un achat
    case FINANCIAL_CATEGORY:     return 0;
    // Un équipement d'occasion acheté à un particulier ne porte aucune TVA,
    // des travaux en portent 20 % ou 10 %. Rien à supposer : on garde le TTC,
    // ce qui ne minore jamais la dépense.
    case 'investissement':       return 0;    // hors champ
    default:                     return 0;    // inconnu → aucune hypothèse
  }
}

/** TVA d'une facture — 0 si elle est marquée non récupérable. */
export function invoiceVat(inv: {
  total_ht: number | null;
  total_ttc: number | null;
  tva_recoverable?: boolean | null;
}): number {
  if (inv.tva_recoverable === false) return 0;
  const ttc = inv.total_ttc || 0;
  const ht = inv.total_ht || 0;
  return Math.max(0, Math.round((ttc - ht) * 100) / 100);
}

/** Arrondi comptable au centime. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Bases de calcul : tout ramener en HT ────────────────────────────────────
//
// Les trois fonctions suivantes existent parce que le P&L et le tableau de bord
// affichaient deux food cost différents pour le même mois. La cause n'était pas
// une erreur de calcul mais un mélange de bases : les lignes de facture sont en
// HT, les mouvements bancaires en TTC, et le chiffre d'affaires Square en TTC.
// Un ratio qui divise des HT par des TTC ne vaut rien — et ne peut surtout pas
// être comparé aux références du métier (28-32 % de food cost, calculés HT
// sur HT).

/**
 * Chiffre d'affaires HT d'une commande Square telle qu'elle est stockée.
 *
 * `net_amount` est le TTC net de remboursements. La taxe se lit dans les
 * données brutes de Square, jamais reconstituée par un taux supposé.
 */
export function orderHtAmount(o: {
  net_amount?: number | null;
  raw_data?: any;
}): number {
  const raw = o.raw_data || {};
  const taxCents =
    raw.total_tax_money?.amount ?? raw.net_amounts?.tax_money?.amount ?? 0;
  return (o.net_amount || 0) - taxCents / 100;
}

/**
 * Montant HT d'un mouvement bancaire, au taux **indicatif** de sa catégorie.
 *
 * Approximation assumée, et bornée : elle ne sert qu'à rendre un ratio de
 * gestion comparable. Elle ne produit aucune TVA déductible — celle-ci vient
 * exclusivement des factures (art. 271 CGI, cf. `lib/tva.ts`). Une catégorie
 * inconnue renvoie le TTC tel quel : mieux vaut un ratio légèrement majoré
 * qu'une déduction inventée.
 */
export function bankAmountHt(
  t: { amount?: number | null; category?: string | null },
  fallbackCategory?: string,
): number {
  const ttc = Math.abs(t.amount || 0);
  const rate = estimatedVatRate(t.category ?? fallbackCategory);
  return rate > 0 ? ttc / (1 + rate) : ttc;
}

/**
 * Apparieur souple facture ↔ paiement bancaire.
 *
 * Le rapprochement bancaire n'est pas fait : `invoice_id` est vide sur la
 * plupart des mouvements. Compter à la fois les lignes d'une facture scannée
 * ET son paiement bancaire compte l'achat deux fois — c'est ce qui gonflait le
 * coût matières sans que rien ne le signale.
 *
 * L'appariement se fait sur l'égalité **au centime** entre le montant payé et
 * le TTC d'une facture de la période. La règle est volontairement stricte :
 * elle n'écarte que des doublons évidents, et chaque facture ne peut servir
 * qu'une fois — sans quoi dix paiements identiques seraient tous absorbés par
 * une seule facture.
 *
 * Ce n'est pas un substitut au rapprochement : c'est un garde-fou en attendant
 * qu'il soit fait. `count()` sert à le dire à l'utilisateur.
 */
export function makeInvoiceMatcher(
  invoices: { total_ttc?: number | null }[],
): { alreadyInvoiced(t: { amount?: number | null }): boolean; count(): number } {
  const pool = new Map<number, number>();
  for (const inv of invoices) {
    const c = Math.round((inv.total_ttc || 0) * 100);
    if (c > 0) pool.set(c, (pool.get(c) || 0) + 1);
  }
  let matched = 0;
  return {
    alreadyInvoiced(t) {
      const c = Math.round(Math.abs(t.amount || 0) * 100);
      const n = pool.get(c);
      if (n && n > 0) {
        pool.set(c, n - 1);
        matched++;
        return true;
      }
      return false;
    },
    count: () => matched,
  };
}
