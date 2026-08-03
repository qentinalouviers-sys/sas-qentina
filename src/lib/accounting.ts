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
    case FINANCIAL_CATEGORY:     return 0;    // hors champ
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
