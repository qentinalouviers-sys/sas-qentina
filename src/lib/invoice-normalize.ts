/**
 * invoice-normalize.ts — Ce que l'OCR renvoie, mis en forme SANS l'IA.
 *
 * Principe : l'IA recopie ce qui est imprimé, le code calcule. Un modèle de
 * langage lit bien un « 25 kg » ou un « 6 × 1 L » ; il divise mal, arrondit
 * au hasard et « corrige » un total qui ne lui plaît pas. On ne lui demande
 * donc plus aucun prix ramené au kilo : il rend la quantité lue, le
 * conditionnement lu et le montant de la ligne, et c'est ici que la quantité
 * standard et le prix unitaire sont dérivés — de façon déterministe, testée,
 * et rejouable si l'humain corrige une valeur.
 *
 * Fonctions pures : aucune base, aucune horloge, aucun secret. Le module est
 * importable côté client (formulaire de relecture) comme côté serveur.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Unités standard dans lesquelles la mercuriale raisonne. */
export type StandardUnit = 'kg' | 'L' | 'unité';

export interface ExtractedLine {
  designation: string;
  /** Quantité dans l'unité standard (25 pour un carton de 25 kg). */
  quantite: number;
  unite: StandardUnit | string;
  /** Prix HT de l'unité standard — calculé : prix_total_ht ÷ quantite. */
  prix_unitaire_ht: number;
  prix_total_ht: number;
  categorie: string;
  // ── Lecture brute, conservée pour l'audit et pour recalculer après correction ──
  /** Quantité telle qu'imprimée (nombre de colis, de pièces…). */
  quantite_lue?: number | null;
  /** Conditionnement tel qu'imprimé : « 25 kg », « 6 x 1 L », « 12x33cl ». */
  conditionnement?: string | null;
  /** Prix unitaire tel qu'imprimé (par colis, par pièce), non retraité. */
  prix_unitaire_lu?: number | null;
}

/** Une ligne de la ventilation de TVA imprimée en pied de facture. */
export interface TvaRateLine {
  /** Taux en pourcentage : 5.5, 10, 20, 2.1 ou 0. */
  taux: number;
  base_ht: number;
  montant_tva: number;
}

/** Seconde lecture, indépendante, des seuls champs qui font la compta. */
export interface OcrControlReading {
  moteur: string;
  fournisseur: string | null;
  date: string | null;
  numero_facture: string | null;
  total_ht: number | null;
  total_tva: number | null;
  total_ttc: number | null;
}

/** Facture déjà en base qui ressemble à celle qu'on s'apprête à enregistrer. */
export interface DuplicateHint {
  id: string;
  accounting_ref: string | null;
  invoice_number: string | null;
  date: string;
  total_ttc: number | null;
  supplier: string | null;
  /** Ce qui a fait conclure au doublon : numéro identique ou même jour/montant. */
  raison: 'numero' | 'date-montant';
}

export interface ExtractedInvoiceData {
  fournisseur: string | null;
  date: string | null;
  numero_facture: string | null;
  total_ht: number;
  total_ttc: number;
  /** TVA totale telle qu'imprimée. Absente : le code retombe sur TTC − HT. */
  tva?: number;
  compte_comptable?: string;
  type_document?: string;
  nom_entreprise_present?: boolean;
  tva_recoverable?: boolean;
  lignes?: ExtractedLine[];
  /** Ventilation par taux, telle qu'imprimée. Vide si le document n'en porte pas. */
  tva_ventilation?: TvaRateLine[];
  /** Champs que l'OCR a déclarés incertains (illisibles, ambigus, devinés). */
  champs_incertains?: string[];
  /** Lecture de contrôle des totaux par un second appel — null si non faite. */
  controle_lecture?: OcrControlReading | null;
  /**
   * Champs pour lesquels l'OCR n'a rien lu (null) et que le code a mis à 0.
   * Distinct de « le document dit 0 » : un total absent n'est pas un total nul.
   */
  champs_non_lus?: string[];
  /** Renseigné par le serveur quand une facture semblable existe déjà. */
  doublon?: DuplicateHint | null;
}

/** Champs que l'OCR peut déclarer incertains, dans l'ordre d'affichage. */
export const UNCERTAIN_FIELDS = [
  'fournisseur', 'date', 'numero_facture', 'total_ht', 'total_tva', 'total_ttc', 'tva_ventilation', 'lignes',
] as const;

/** Taux de TVA en vigueur en France métropolitaine, en pourcentage. */
export const TVA_RATES = [0, 2.1, 5.5, 10, 20] as const;

export const DOCUMENT_TYPES = ['facture', 'ticket_caisse', 'bon_livraison', 'recu'] as const;
export const ACCOUNTING_CLASSES = ['601', '607', '606', '6061', '61', '62', '63', '64', 'autre'] as const;
export const LINE_CATEGORIES = ['alimentaire', 'materiel', 'emballage', 'boisson', 'autre'] as const;

// ── Coercions ──────────────────────────────────────────────────────────────

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Nombre lu dans une valeur quelconque, ou null.
 * Accepte « 1 234,56 », « 1.234,56 », « 12.5 », « 12,5 » et les nombres natifs.
 * Un texte sans chiffre, un objet ou un booléen donnent null — jamais 0.
 */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\s €]/g, '').replace(/[^0-9,.\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  // Deux séparateurs : le dernier est la décimale, l'autre un séparateur de milliers.
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // « 1,234 » est ambigu ; en France c'est une décimale. Un seul cas
    // tranché autrement : trois chiffres exactement après la virgule et plus
    // de trois avant est trop rare pour mériter une règle.
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function toIsoDate(v: unknown): string | null {
  const s = toText(v);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // « 28/08/2026 » ou « 28.08.26 » : l'OCR recopie parfois le format imprimé.
  const fr = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (fr) {
    const yyyy = fr[3].length === 2 ? `20${fr[3]}` : fr[3];
    return `${yyyy}-${fr[2].padStart(2, '0')}-${fr[1].padStart(2, '0')}`;
  }
  return s;
}

// ── Conditionnement ────────────────────────────────────────────────────────

const UNIT_FACTORS: Record<string, { unit: StandardUnit; factor: number }> = {
  kg: { unit: 'kg', factor: 1 }, kgs: { unit: 'kg', factor: 1 }, kilo: { unit: 'kg', factor: 1 }, kilos: { unit: 'kg', factor: 1 },
  g: { unit: 'kg', factor: 0.001 }, gr: { unit: 'kg', factor: 0.001 }, grs: { unit: 'kg', factor: 0.001 }, gramme: { unit: 'kg', factor: 0.001 }, grammes: { unit: 'kg', factor: 0.001 },
  l: { unit: 'L', factor: 1 }, lt: { unit: 'L', factor: 1 }, litre: { unit: 'L', factor: 1 }, litres: { unit: 'L', factor: 1 },
  cl: { unit: 'L', factor: 0.01 }, ml: { unit: 'L', factor: 0.001 },
  u: { unit: 'unité', factor: 1 }, un: { unit: 'unité', factor: 1 }, unite: { unit: 'unité', factor: 1 }, unites: { unit: 'unité', factor: 1 },
  pc: { unit: 'unité', factor: 1 }, pcs: { unit: 'unité', factor: 1 }, piece: { unit: 'unité', factor: 1 }, pieces: { unit: 'unité', factor: 1 },
  bt: { unit: 'unité', factor: 1 }, bte: { unit: 'unité', factor: 1 }, btl: { unit: 'unité', factor: 1 }, bouteille: { unit: 'unité', factor: 1 }, bouteilles: { unit: 'unité', factor: 1 },
  pot: { unit: 'unité', factor: 1 }, pots: { unit: 'unité', factor: 1 }, sac: { unit: 'unité', factor: 1 }, sacs: { unit: 'unité', factor: 1 },
  boite: { unit: 'unité', factor: 1 }, boites: { unit: 'unité', factor: 1 }, bte2: { unit: 'unité', factor: 1 },
};

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface Packaging {
  /** Contenance d'un colis, dans l'unité standard (25 pour « 25 kg »). */
  perPack: number;
  unit: StandardUnit;
  /** Nombre d'unités élémentaires par colis (6 pour « 6 x 1 L »), 1 sinon. */
  count: number;
}

/**
 * Lit un conditionnement imprimé : « 25 kg », « 25KG », « 6 x 1 L », « 12x33cl »,
 * « 2,5 kg », « 500 g », « carton de 10 kg », « 1 L ». Null si rien d'exploitable.
 */
export function parsePackaging(raw: string | null | undefined): Packaging | null {
  const s = fold(toText(raw) ?? '').replace(/,/g, '.');
  if (!s) return null;

  // « 6 x 1 l », « 12x33cl », « 6*1.5l »
  const multi = s.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (multi) {
    const f = UNIT_FACTORS[multi[3]];
    if (f) {
      const count = Number(multi[1]);
      const size = Number(multi[2]) * f.factor;
      return { perPack: round6(count * size), unit: f.unit, count };
    }
  }

  // « 25 kg », « carton de 10 kg », « 500g »
  const single = s.match(/(\d+(?:\.\d+)?)\s*([a-z]+)\b/);
  if (single) {
    const f = UNIT_FACTORS[single[2]];
    if (f) return { perPack: round6(Number(single[1]) * f.factor), unit: f.unit, count: 1 };
  }

  // « kg », « unité », « pièce » seuls : une unité de la chose.
  const bare = s.match(/^([a-z]+)$/);
  if (bare) {
    const f = UNIT_FACTORS[bare[1]];
    if (f) return { perPack: f.factor, unit: f.unit, count: 1 };
  }
  return null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Ramène une ligne lue à l'unité standard et calcule son prix unitaire.
 *
 * Trois cas :
 *  - conditionnement lisible (« 25 kg ») : quantité = quantité lue × contenance,
 *    prix unitaire = total ÷ quantité — jamais recopié de l'OCR ;
 *  - conditionnement absent mais unité déjà standard (ligne saisie ou corrigée
 *    à la main, ancien format) : on garde ce qui est là ;
 *  - rien d'exploitable : unité « unité », quantité lue telle quelle.
 *
 * Le prix unitaire n'est jamais calculé si la quantité est nulle : on laisse
 * 0, et la mercuriale ignore les prix nuls.
 */
export function normalizeLine(raw: Partial<ExtractedLine> & Record<string, unknown>): ExtractedLine {
  const designation = toText(raw.designation) ?? '';
  const total = toNumber(raw.prix_total_ht) ?? 0;
  const categorie = (LINE_CATEGORIES as readonly string[]).includes(String(raw.categorie)) ? String(raw.categorie) : 'autre';
  const quantiteLue = toNumber(raw.quantite_lue);
  const conditionnement = toText(raw.conditionnement);
  const prixLu = toNumber(raw.prix_unitaire_lu);
  const pack = parsePackaging(conditionnement);

  let quantite: number;
  let unite: string;

  if (pack) {
    quantite = round6((quantiteLue ?? 1) * pack.perPack);
    unite = pack.unit;
  } else if (raw.quantite !== undefined && raw.unite !== undefined && quantiteLue === null) {
    // Ligne déjà normalisée (saisie manuelle, ancien format) : on la respecte.
    quantite = toNumber(raw.quantite) ?? 0;
    unite = toText(raw.unite) ?? 'unité';
  } else {
    quantite = quantiteLue ?? toNumber(raw.quantite) ?? 0;
    unite = toText(raw.unite) ?? 'unité';
  }

  const prixUnitaire = quantite > 0 ? round6(total / quantite) : (toNumber(raw.prix_unitaire_ht) ?? 0);

  return {
    designation,
    quantite,
    unite,
    prix_unitaire_ht: prixUnitaire,
    prix_total_ht: round2(total),
    categorie,
    quantite_lue: quantiteLue,
    conditionnement,
    prix_unitaire_lu: prixLu,
  };
}

// ── Ventilation de TVA ─────────────────────────────────────────────────────

/** Taux connu le plus proche d'un taux lu (« 5,50 » → 5.5, « 20.0 » → 20), sinon le taux lu. */
export function snapRate(rate: number): number {
  for (const r of TVA_RATES) if (Math.abs(rate - r) <= 0.15) return r;
  return rate;
}

export function normalizeVentilation(raw: unknown): TvaRateLine[] {
  if (!Array.isArray(raw)) return [];
  const out: TvaRateLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const taux = toNumber(o.taux);
    const base = toNumber(o.base_ht);
    const tva = toNumber(o.montant_tva);
    if (taux === null || (base === null && tva === null)) continue;
    out.push({ taux: snapRate(taux), base_ht: round2(base ?? 0), montant_tva: round2(tva ?? 0) });
  }
  return out;
}

// ── Facture entière ────────────────────────────────────────────────────────

/**
 * Règle fiscale : la TVA n'est déductible que sur une facture au nom de
 * l'entreprise (art. 289 et 271 CGI). Tolérance pour les tickets de caisse
 * jusqu'à 150 € HT (art. 242 nonies A, annexe II) : la mention du client n'y
 * est pas exigée. Un reçu de carte bancaire ou un bon de livraison ne sont
 * pas des factures : rien n'est déductible tant que la facture n'est pas là.
 */
export function computeTvaRecoverable(inv: Pick<ExtractedInvoiceData, 'type_document' | 'nom_entreprise_present' | 'total_ht' | 'total_ttc'>): boolean {
  const typeDoc = inv.type_document || 'facture';
  const present = !!inv.nom_entreprise_present;
  const ht = Number(inv.total_ht) || 0;
  if (typeDoc === 'facture') return present;
  if (typeDoc === 'ticket_caisse') return ht <= 150 || present;
  return false;
}

/**
 * Met en forme ce que l'OCR (ou l'écran, après correction) a envoyé.
 *
 * Tout ce qui entre dans la base passe ici : un nombre écrit « 1 234,56 »
 * devient 1234.56, un total absent devient 0 ET est listé dans
 * `champs_non_lus`, les lignes sont ramenées à l'unité standard, la TVA
 * totale est déduite de TTC − HT si le document ne l'imprime pas.
 * Idempotente : normaliser deux fois donne le même résultat.
 */
export function normalizeExtracted(raw: unknown): ExtractedInvoiceData {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nonLus: string[] = [];

  const num = (key: string): number => {
    const n = toNumber(o[key]);
    if (n === null) { nonLus.push(key); return 0; }
    return round2(n);
  };

  const total_ht = num('total_ht');
  const total_ttc = num('total_ttc');
  // L'OCR v1 disait `tva`, la v2 `total_tva` : on accepte les deux.
  const tvaLue = toNumber(o.total_tva) ?? toNumber(o.tva);
  const tva = tvaLue !== null ? round2(tvaLue) : round2(Math.max(0, total_ttc - total_ht));
  if (tvaLue === null) nonLus.push('total_tva');

  const typeDoc = (DOCUMENT_TYPES as readonly string[]).includes(String(o.type_document)) ? String(o.type_document) : 'facture';
  const compte = (ACCOUNTING_CLASSES as readonly string[]).includes(String(o.compte_comptable)) ? String(o.compte_comptable) : '601';

  const lignes = Array.isArray(o.lignes)
    ? (o.lignes as unknown[])
        .filter(l => l && typeof l === 'object')
        .map(l => normalizeLine(l as Partial<ExtractedLine> & Record<string, unknown>))
        .filter(l => l.designation || l.prix_total_ht !== 0)
    : [];

  const incertains = Array.isArray(o.champs_incertains)
    ? (o.champs_incertains as unknown[]).map(String).filter(f => (UNCERTAIN_FIELDS as readonly string[]).includes(f))
    : [];

  const ctrlRaw = o.controle_lecture && typeof o.controle_lecture === 'object' ? o.controle_lecture as Record<string, unknown> : null;
  const controle: OcrControlReading | null = ctrlRaw ? {
    moteur: toText(ctrlRaw.moteur) ?? 'inconnu',
    fournisseur: toText(ctrlRaw.fournisseur),
    date: toIsoDate(ctrlRaw.date),
    numero_facture: toText(ctrlRaw.numero_facture),
    total_ht: toNumber(ctrlRaw.total_ht),
    total_tva: toNumber(ctrlRaw.total_tva),
    total_ttc: toNumber(ctrlRaw.total_ttc),
  } : null;

  const doublonRaw = o.doublon && typeof o.doublon === 'object' ? o.doublon as Record<string, unknown> : null;
  const doublon: DuplicateHint | null = doublonRaw && toText(doublonRaw.id) ? {
    id: String(doublonRaw.id),
    accounting_ref: toText(doublonRaw.accounting_ref),
    invoice_number: toText(doublonRaw.invoice_number),
    date: toText(doublonRaw.date) ?? '',
    total_ttc: toNumber(doublonRaw.total_ttc),
    supplier: toText(doublonRaw.supplier),
    raison: doublonRaw.raison === 'numero' ? 'numero' : 'date-montant',
  } : null;

  const out: ExtractedInvoiceData = {
    fournisseur: toText(o.fournisseur),
    date: toIsoDate(o.date),
    numero_facture: toText(o.numero_facture),
    total_ht,
    total_ttc,
    tva,
    compte_comptable: compte,
    type_document: typeDoc,
    nom_entreprise_present: o.nom_entreprise_present === true,
    lignes,
    tva_ventilation: normalizeVentilation(o.tva_ventilation),
    champs_incertains: incertains,
    // Une normalisation antérieure a pu déjà remplir cette liste (écran →
    // serveur) : on la conserve, sans doublon.
    champs_non_lus: [...new Set([...(Array.isArray(o.champs_non_lus) ? (o.champs_non_lus as unknown[]).map(String) : []), ...nonLus])],
    controle_lecture: controle,
    doublon,
  };
  out.tva_recoverable = computeTvaRecoverable(out);
  return out;
}

/**
 * Champs corrigés par l'humain entre la lecture et l'enregistrement — gardés
 * en base pour savoir ce que l'OCR rate, et sur quels fournisseurs.
 */
export function correctedFields(original: ExtractedInvoiceData, final: ExtractedInvoiceData): string[] {
  const out: string[] = [];
  const cmpText = (k: keyof ExtractedInvoiceData) => (toText(original[k] as unknown) ?? '') !== (toText(final[k] as unknown) ?? '');
  const cmpNum = (k: keyof ExtractedInvoiceData) => Math.abs((Number(original[k]) || 0) - (Number(final[k]) || 0)) > 0.005;
  for (const k of ['fournisseur', 'date', 'numero_facture', 'type_document', 'compte_comptable'] as const) if (cmpText(k)) out.push(k);
  for (const k of ['total_ht', 'total_ttc', 'tva'] as const) if (cmpNum(k)) out.push(k);
  if (!!original.nom_entreprise_present !== !!final.nom_entreprise_present) out.push('nom_entreprise_present');
  if (JSON.stringify(original.tva_ventilation ?? []) !== JSON.stringify(final.tva_ventilation ?? [])) out.push('tva_ventilation');
  if (JSON.stringify(original.lignes ?? []) !== JSON.stringify(final.lignes ?? [])) out.push('lignes');
  return out;
}
