/**
 * bank-csv.ts — Lecture déterministe d'un export CSV de relevé bancaire.
 *
 * Pourquoi ne pas laisser l'IA lire le CSV : un export bancaire est déjà
 * structuré. Lui faire retranscrire chaque ligne, c'est accepter un risque
 * d'erreur sur des montants — et se heurter à la limite de tokens dès qu'un
 * relevé dépasse quelques dizaines d'opérations. Ici les dates et les montants
 * sont lus caractère par caractère : ils sont exacts par construction.
 *
 * L'IA reste utile pour ce qu'elle fait mieux qu'une règle : deviner la
 * catégorie comptable d'un libellé. On ne lui envoie donc que les libellés
 * DISTINCTS (65 pour 177 lignes sur un relevé réel), pas les lignes.
 */

export interface ParsedBankRow {
  /** Format ISO YYYY-MM-DD. */
  date: string;
  /** Libellé tel qu'il sera enregistré (espaces normalisés). */
  description: string;
  /** Négatif pour une dépense. */
  amount: number;
  /** Libellé normalisé servant de clé de catégorisation. */
  categoryKey: string;
}

export interface BankCsvResult {
  rows: ParsedBankRow[];
  /** Lignes écartées : soldes d'ouverture/clôture, en-têtes, lignes vides. */
  skipped: number;
}

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const AMOUNT_RE = /^-?\d+(?:[.,]\d+)?$/;

/** Espaces multiples réduits à un seul, bords coupés. */
function squash(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Clé de regroupement d'un libellé pour la catégorisation.
 * « CB42METRO FRANCE     04/06/26 » et « CB42METRO FRANCE  19/06/26 » sont le
 * même commerçant : on retire le préfixe du terminal carte et la date de
 * transaction collée en fin de libellé.
 */
export function categoryKeyOf(label: string): string {
  return squash(label)
    .replace(/\s*\d{2}\/\d{2}\/\d{2,4}$/, '')
    .replace(/^CB\d+/i, '')
    .trim()
    .toUpperCase();
}

/**
 * Lit un export CSV de relevé bancaire.
 *
 * Renvoie un tableau vide si le format n'est pas reconnu — l'appelant peut
 * alors basculer sur l'extraction par IA plutôt que d'échouer.
 */
export function parseBankCsv(text: string): BankCsvResult {
  // Les exports bancaires sont souvent en UTF-8 avec BOM : sans ça, la
  // première date devient « ﻿01/06/2026 » et la ligne est rejetée.
  const clean = (text || '').replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter(l => l.trim());

  const rows: ParsedBankRow[] = [];
  let skipped = 0;

  for (const line of lines) {
    const f = line.split(';');

    // Les lignes de solde d'ouverture et de clôture portent une date et un
    // montant valides mais seulement quatre colonnes. Sans ce filtre, elles
    // entreraient en base comme deux opérations fantômes.
    if (f.length < 6) { skipped++; continue; }

    const dateMatch = f[0]?.trim().match(DATE_RE);
    const rawAmount = f[1]?.trim() ?? '';
    if (!dateMatch || !AMOUNT_RE.test(rawAmount)) { skipped++; continue; }

    const amount = parseFloat(rawAmount.replace(',', '.'));
    if (!Number.isFinite(amount)) { skipped++; continue; }

    // Selon le type d'opération, la banque écrit le libellé en 5ᵉ colonne
    // (carte, prélèvement) ou en 6ᵉ (virement SEPA).
    const description = squash(f[4]) || squash(f[5]) || squash(f[2]) || 'Opération';

    const [, dd, mm, yyyy] = dateMatch;
    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      description,
      amount: Math.round(amount * 100) / 100,
      categoryKey: categoryKeyOf(description),
    });
  }

  return { rows, skipped };
}

/**
 * Catégorisation par règles, sans appel à l'IA.
 *
 * Les libellés bancaires sont très répétitifs : sur un relevé réel, une
 * poignée de motifs couvre la grande majorité des lignes. Les traiter ici rend
 * l'import instantané, gratuit, déterministe — et surtout **fonctionnel même
 * quand l'API Claude est indisponible ou à court de crédit**. L'IA n'est
 * sollicitée que pour ce que les règles ne reconnaissent pas.
 *
 * L'ordre compte : le premier motif trouvé gagne, du plus spécifique au plus
 * général.
 */
interface Rule {
  category: string;
  terms: string[];
  /**
   * Montant attendu, à 1 € près. Réserve la règle aux libellés dont le sens
   * dépend du montant.
   *
   * Le cas qui l'a rendue nécessaire : « VIREMENT PERMANENT » est le loyer chez
   * ce restaurant, mais le libellé ne dit rien de sa destination. Un futur
   * virement permanent — remboursement d'emprunt, épargne — serait rangé en
   * loyer sans que rien ne le signale. En exigeant le montant, une évolution
   * (révision de loyer) fait retomber la ligne en « non classée » : elle
   * réapparaît dans le bandeau de la page Banque au lieu d'être silencieusement
   * fausse. Un échec visible vaut mieux qu'un succès douteux.
   */
  amountAbout?: number;
}

const RULES: Rule[] = [
  { category: 'recette', terms: [
    'squareup', 'square', 'stripe', 'ubereats', 'uber eats', 'deliveroo',
    'just eat', 'remise cheque', 'remise de cheque', 'rem chq', 'remise chq',
  ]},
  { category: 'impot_taxe', terms: [
    'urssaf', 'dgfip', 'impot', 'impots', 'tresor public', 'tva', 'rsi', 'cotisation',
  ]},
  { category: 'fixe_assurance', terms: [
    'assurance', 'axa', 'maaf', 'macif', 'allianz', 'generali', 'groupama', 'mma', 'swisslife',
    // IARD = incendie, accidents et risques divers : terme du métier de l'assurance.
    'abeille', 'iard',
  ]},
  { category: 'fixe_abonnement', terms: [
    'verisure', 'abon', 'orange', 'sfr', 'bouygues', 'free ', 'edf', 'engie', 'totalenergies',
    'electricite', 'veolia', 'suez', 'internet', 'telecom', 'spotify', 'adobe',
    'google', 'microsoft',
    // Droits musicaux : obligatoires dès qu'une salle diffuse de la musique.
    // Deux organismes distincts prélèvent séparément, d'où deux lignes.
    'sacem', 'spre',
    // Abonnements logiciels de l'établissement.
    'apple', 'anthropic', 'ia claude', 'openai', 'canva', 'shopify', 'wix', 'squarespace',
  ]},
  // Le loyer réglé par virement permanent : le montant fait partie de la règle
  // (voir `amountAbout`). Placé avant la règle générale pour être évalué en
  // premier, l'ordre de la table étant significatif.
  { category: 'fixe_loyer', terms: ['virement permanent'], amountAbout: 1332.65 },
  { category: 'fixe_loyer', terms: [
    'loyer', 'sci ', 'bail',
    // Administrateurs de biens : le libellé ne contient jamais le mot « loyer ».
    'objectif pierre', 'foncia', 'nexity', 'citya', 'orpi', 'gestion immo',
  ]},
  { category: 'variable_salaire', terms: ['salaire', 'paie', 'acompte', 'remuneration'] },
  { category: 'variable_fournisseur', terms: [
    'metro', 'euro cibus', 'eurocibus', 'mozzalat', 'promocash', 'transgourmet',
    'carrefour', 'intermarche', 'leclerc', 'auchan', 'lidl', 'aldi', 'grand frais',
    'butcher', 'boucherie', 'primeur', 'entrepots', 'brake', 'pomona', 'davigel',
    // Grossistes en boissons : ce sont des achats revendus, pas des charges.
    'boiss', 'brasseur', 'cave', 'vin ', 'vins',
    // Traiteurs, épiceries fines et producteurs : mêmes achats revendus.
    'delices', 'ferme du', 'ferme de', 'fromager', 'poissonnerie', 'charcuterie',
    'maraicher', 'moulin', 'coffee', 'torrefact',
    // Le bois de four est une matière première dans une pizzeria napolitaine :
    // sans lui, pas de cuisson. Il n'a rien à faire dans les charges fixes.
    'bois de chauffage', 'buche', 'gruchy bois',
  ]},
];

/** Retire les accents et met en minuscules, pour comparer des libellés. */
function fold(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marques diacritiques combinantes
    .toLowerCase();
}

/**
 * Catégorie déduite d'un libellé, ou `null` si aucune règle ne s'applique.
 * Ce sont des valeurs par défaut : elles se corrigent dans l'écran Banque.
 *
 * @param amount montant du mouvement. Facultatif, mais les règles portant un
 *   `amountAbout` ne peuvent pas s'appliquer sans lui — elles sont alors
 *   ignorées, ce qui laisse la ligne non classée plutôt que mal classée.
 */
export function categoryFromRules(label: string, amount?: number | null): string | null {
  const l = fold(label);
  if (!l) return null;
  for (const rule of RULES) {
    if (!rule.terms.some(t => l.includes(t))) continue;
    if (rule.amountAbout !== undefined) {
      if (amount === undefined || amount === null) continue;
      if (Math.abs(Math.abs(amount) - rule.amountAbout) > 1) continue;
    }
    return rule.category;
  }
  return null;
}

/** Libellés distincts à soumettre à la catégorisation, dans l'ordre d'apparition. */
export function distinctCategoryKeys(rows: ParsedBankRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r.categoryKey && !seen.has(r.categoryKey)) {
      seen.add(r.categoryKey);
      out.push(r.categoryKey);
    }
  }
  return out;
}
