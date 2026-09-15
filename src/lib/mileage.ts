/**
 * mileage.ts — Frais kilométriques (barème fiscal + péages).
 *
 * Deux subtilités que le calcul « naïf » rate :
 *
 *  1. Le barème est PROGRESSIF PAR TRANCHE ANNUELLE. Le taux dépend du total
 *     de kilomètres parcourus sur l'année, pas de chaque trajet pris isolément.
 *     Ajouter un trajet peut donc changer le taux appliqué à TOUS les autres.
 *     On calcule toujours sur le cumul annuel, jamais trajet par trajet.
 *
 *  2. Les péages ne relèvent pas du barème : ils s'ajoutent au réel, sur
 *     justificatif. Ils sont donc additionnés séparément.
 */

export type CvBracket = '3' | '4' | '5' | '6' | '7+';

export interface BaremeRow {
  /** Jusqu'à 5 000 km : distance × tauxBas */
  low: number;
  /** De 5 001 à 20 000 km : (distance × midRate) + midBonus */
  midRate: number;
  midBonus: number;
  /** Au-delà de 20 000 km : distance × high */
  high: number;
}

/**
 * Barème kilométrique voitures — valeurs de référence (revenus 2024,
 * applicables en 2025). Le barème est révisé chaque année par
 * l'administration fiscale : il est modifiable dans les réglages de l'outil
 * pour éviter de dépendre d'une mise à jour du code.
 */
export const BAREME_DEFAULT: Record<CvBracket, BaremeRow> = {
  '3':  { low: 0.529, midRate: 0.316, midBonus: 1065, high: 0.370 },
  '4':  { low: 0.606, midRate: 0.340, midBonus: 1330, high: 0.407 },
  '5':  { low: 0.636, midRate: 0.357, midBonus: 1395, high: 0.427 },
  '6':  { low: 0.665, midRate: 0.374, midBonus: 1457, high: 0.447 },
  '7+': { low: 0.697, midRate: 0.394, midBonus: 1515, high: 0.470 },
};

/** Majoration pour les véhicules 100 % électriques. */
export const ELECTRIC_BONUS = 0.20;

/**
 * Identification du véhicule, telle qu'elle figure sur la carte grise.
 *
 * Une note de frais qui ne désigne pas le véhicule est faible en cas de
 * contrôle : on reprend donc la marque/modèle, l'immatriculation et le
 * propriétaire, et on les imprime sur le document.
 */
export interface VehicleConfig {
  /** Marque et modèle — cases D.1 et D.3. */
  model: string;
  /** Numéro d'immatriculation — case A. */
  plate: string;
  /** Titulaire de la carte grise — case C.1. */
  owner: 'justine' | 'yohan';
  /**
   * Le conducteur et le titulaire de la carte grise appartiennent au même
   * foyer fiscal. L'indemnité kilométrique se rembourse au propriétaire du
   * véhicule ou à une personne de son foyer : quand c'est le cas, un
   * conducteur différent du titulaire est normal et ne mérite pas d'alerte.
   */
  sameHousehold: boolean;
  /** Genre national — case J.1 (VP, CTTE, VASP…). Purement informatif. */
  registrationType: string;
}

/**
 * D'où la détection tire les trajets.
 *
 * Un achat laisse deux traces : une facture et une ligne bancaire. Ce sont
 * deux vues du MÊME déplacement — les cumuler compterait chaque trajet deux
 * fois. On en choisit donc une, et une seule.
 *
 *  - « banque »   : plus complet, toute dépense laisse une ligne, et ça
 *                   fonctionne sans scanner de facture.
 *  - « factures » : la pièce justificative qu'un contrôleur demandera, mais
 *                   seulement pour les factures effectivement scannées.
 */
export type DetectionSource = 'banque' | 'factures';

export interface MileageConfig {
  cv: CvBracket;
  electric: boolean;
  defaultDriver: 'justine' | 'yohan';
  detectionSource: DetectionSource;
  vehicle: VehicleConfig;
  bareme: Record<CvBracket, BaremeRow>;
  /** Année de référence du barème, affichée sur la note de frais. */
  baremeYear: number;
  destinations: DestinationConfig[];
}

export interface DestinationConfig {
  key: string;
  /**
   * Termes reconnus dans le nom du fournisseur, séparés par des virgules.
   * Insensible à la casse et aux accents (« Métro » reconnaît « metro »).
   */
  supplierMatch: string;
  label: string;
  /** Distance ALLER-RETOUR en km. */
  km: number;
  /** Péage aller-retour, en euros. */
  toll: number;
}

export const DEFAULT_CONFIG: MileageConfig = {
  // Carte grise du 30/06/2021 : P.6 = 7 → « 7 CV et plus », P.3 = GO → thermique.
  cv: '7+',
  electric: false,
  defaultDriver: 'justine',
  detectionSource: 'banque',
  vehicle: {
    model: 'Pössl Summit 600',
    plate: 'GA-175-LB',
    owner: 'yohan',
    sameHousehold: true,
    // J = M1 (véhicule de tourisme), J.1 = VASP, J.3 = CARAVANE.
    // Ce n'est PAS un utilitaire « CTTE » : le cas qui aurait exclu le barème
    // au profit des frais réels ne s'applique donc pas ici.
    registrationType: 'VASP',
  },
  bareme: BAREME_DEFAULT,
  baremeYear: 2025,
  destinations: [
    {
      key: 'metro',
      supplierMatch: 'metro',
      label: 'Metro — Sotteville-lès-Rouen',
      km: 56,
      toll: 0,
    },
    {
      key: 'mozzalat',
      // « Eurocibus » est l'ancienne raison sociale : les factures d'archive
      // peuvent la porter, la reconnaissance couvre les deux.
      supplierMatch: 'mozzalat, eurocibus',
      label: 'Mozzalat — Évreux',
      km: 60,
      toll: 0,
    },
  ],
};

/** Libellé lisible d'une puissance fiscale (« 7 CV et plus », « 5 CV »…). */
export function cvLabel(cv: CvBracket): string {
  return cv === '7+' ? '7 CV et plus' : `${cv} CV`;
}

/** Prénom affichable d'un associé. */
export function driverLabel(driver: string): string {
  return driver === 'justine' ? 'Justine' : 'Yohan';
}

/**
 * Date du déplacement déduite d'un libellé bancaire.
 *
 * La banque date l'ÉCRITURE, pas l'achat : « CB42METRO FRANCE 04/06/26 » est
 * débité le 05/06. Pire, un règlement à terme peut arriver des mois après —
 * une ligne « Metro 27/03 » a été débitée le 1ᵉʳ juin. Sur une note de frais,
 * c'est le jour où l'on était au magasin qui compte, pas celui du paiement.
 *
 * On récupère donc la date collée au libellé quand il y en a une :
 *  - « … 04/06/26 » → jour/mois/année sur deux chiffres ;
 *  - « … 27/03 »    → jour/mois, l'année venant de l'écriture (et l'année
 *                     précédente si cela placerait l'achat dans le futur).
 *
 * @returns la date ISO du déplacement, et `exact` à false quand on a dû se
 *          rabattre sur la date d'écriture.
 */
export function tripDateFromLabel(
  label: string,
  bankDateIso: string
): { date: string; exact: boolean } {
  const l = (label || '').trim();

  const withYear = l.match(/(\d{2})\/(\d{2})\/(\d{2})(?!\d)/);
  if (withYear) {
    const [, dd, mm, yy] = withYear;
    return { date: `20${yy}-${mm}-${dd}`, exact: true };
  }

  const dayMonth = l.match(/(\d{2})\/(\d{2})(?!\/|\d)/);
  if (dayMonth && /^\d{4}-\d{2}-\d{2}$/.test(bankDateIso)) {
    const [, dd, mm] = dayMonth;
    const year = Number(bankDateIso.slice(0, 4));
    const candidate = `${year}-${mm}-${dd}`;
    // Un achat ne peut pas être postérieur à son propre paiement : si c'est le
    // cas, le libellé référence l'année précédente (paiement à cheval sur
    // le 1ᵉʳ janvier).
    const resolved = candidate > bankDateIso ? `${year - 1}-${mm}-${dd}` : candidate;
    return { date: resolved, exact: true };
  }

  return { date: bankDateIso, exact: false };
}

/** Retire les accents et met en minuscules, pour comparer des noms de fournisseurs. */
export function normalize(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marques diacritiques combinantes
    .toLowerCase()
    .trim();
}

/**
 * Indemnité kilométrique pour un total annuel de kilomètres.
 * Renvoie le montant en euros (hors péages).
 */
export function computeAllowance(totalKm: number, config: MileageConfig): number {
  if (totalKm <= 0) return 0;
  const row = config.bareme[config.cv] ?? BAREME_DEFAULT[config.cv] ?? BAREME_DEFAULT['7+'];

  let amount: number;
  if (totalKm <= 5000) {
    amount = totalKm * row.low;
  } else if (totalKm <= 20000) {
    amount = totalKm * row.midRate + row.midBonus;
  } else {
    amount = totalKm * row.high;
  }

  if (config.electric) amount *= 1 + ELECTRIC_BONUS;
  return Math.round(amount * 100) / 100;
}

/** Tranche du barème effectivement appliquée, pour l'afficher à l'utilisateur. */
export function bracketLabel(totalKm: number): string {
  if (totalKm <= 5000) return 'jusqu\'à 5 000 km';
  if (totalKm <= 20000) return 'de 5 001 à 20 000 km';
  return 'au-delà de 20 000 km';
}

/**
 * Taux moyen au kilomètre réellement obtenu (utile pour vérifier d'un coup
 * d'œil que le barème appliqué est cohérent).
 */
export function effectiveRate(totalKm: number, config: MileageConfig): number {
  if (totalKm <= 0) return 0;
  return computeAllowance(totalKm, config) / totalKm;
}

export interface TripLike {
  distance_km: number | string;
  toll_amount: number | string;
  driver: string;
}

export interface MileageTotals {
  totalKm: number;
  allowance: number;
  tolls: number;
  total: number;
  bracket: string;
  ratePerKm: number;
  tripCount: number;
}

/**
 * Totaux pour un ensemble de trajets (typiquement : une année, un conducteur).
 *
 * Important : passer TOUS les trajets de l'année du conducteur, car la tranche
 * du barème dépend du cumul annuel. Filtrer sur un mois avant d'appeler cette
 * fonction sous-estimerait le taux applicable.
 */
export function computeTotals(trips: TripLike[], config: MileageConfig): MileageTotals {
  const totalKm = trips.reduce((s, t) => s + (Number(t.distance_km) || 0), 0);
  const tolls = trips.reduce((s, t) => s + (Number(t.toll_amount) || 0), 0);
  const allowance = computeAllowance(totalKm, config);

  return {
    totalKm: Math.round(totalKm * 100) / 100,
    allowance,
    tolls: Math.round(tolls * 100) / 100,
    total: Math.round((allowance + tolls) * 100) / 100,
    bracket: bracketLabel(totalKm),
    ratePerKm: effectiveRate(totalKm, config),
    tripCount: trips.length,
  };
}

/**
 * Ventile l'indemnité annuelle sur chaque trajet, au prorata des distances.
 *
 * Sur une note de frais, la somme des lignes DOIT égaler le total au centime
 * près. Un simple arrondi par ligne dérive (≈ 7 centimes sur une centaine de
 * trajets) : on répartit donc les centimes restants sur les plus gros trajets
 * (méthode du plus fort reste), ce qui garantit une somme exacte.
 *
 * @returns un tableau de montants, dans le même ordre que `tripsKm`.
 */
export function allocateShares(tripsKm: number[], totalKm: number, allowance: number): number[] {
  if (totalKm <= 0 || tripsKm.length === 0) return tripsKm.map(() => 0);

  // On travaille en centimes pour éviter toute imprécision en virgule flottante.
  const totalCents = Math.round(allowance * 100);
  const exact = tripsKm.map(km => (totalCents * km) / totalKm);
  const floored = exact.map(Math.floor);

  let remainder = totalCents - floored.reduce((s, c) => s + c, 0);

  // Les centimes restants vont aux lignes dont la partie décimale est la plus
  // forte : c'est la répartition la plus équitable et elle est déterministe.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floored[order[k].i] += 1;
  }

  return floored.map(c => c / 100);
}

/**
 * Part d'un trajet isolé, au prorata. Pratique pour un affichage ponctuel,
 * mais préférer `allocateShares` dès qu'on affiche une liste dont le total
 * doit tomber juste.
 */
export function shareForTrip(tripKm: number, totalKm: number, allowance: number): number {
  if (totalKm <= 0) return 0;
  return Math.round((allowance * (tripKm / totalKm)) * 100) / 100;
}

/**
 * La destination correspondant à un nom de fournisseur, ou null.
 * Compare sans accent ni casse, sur chacun des termes configurés.
 */
export function matchDestination(
  supplierName: string,
  destinations: DestinationConfig[]
): DestinationConfig | null {
  const name = normalize(supplierName);
  if (!name) return null;
  // La banque n'écrit pas les raisons sociales comme les factures :
  // « EURO CIBUS » sur un relevé, « Eurocibus » sur une facture. On compare
  // donc aussi en ignorant les espaces, sinon dix prélèvements passent à la
  // trappe sans que rien ne le signale.
  const tight = name.replace(/\s+/g, '');

  for (const dest of destinations) {
    const terms = dest.supplierMatch
      .split(',')
      .map(t => normalize(t))
      .filter(Boolean);
    if (terms.some(term => name.includes(term) || tight.includes(term.replace(/\s+/g, '')))) {
      return dest;
    }
  }
  return null;
}

/** Fusionne une configuration enregistrée avec les valeurs par défaut. */
export function mergeConfig(stored: unknown): MileageConfig {
  if (!stored || typeof stored !== 'object') return DEFAULT_CONFIG;
  const s = stored as Partial<MileageConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...s,
    vehicle: { ...DEFAULT_CONFIG.vehicle, ...(s.vehicle || {}) },
    bareme: { ...BAREME_DEFAULT, ...(s.bareme || {}) },
    destinations: Array.isArray(s.destinations) && s.destinations.length > 0
      ? s.destinations
      : DEFAULT_CONFIG.destinations,
  };
}

/**
 * Un libellé bancaire qui ressemble à un plein de carburant.
 *
 * Le barème kilométrique couvre DÉJÀ le carburant, l'assurance et l'usure du
 * véhicule. Si la société paie en plus un plein sur son compte, la dépense est
 * déduite deux fois : une fois au réel, une fois dans l'indemnité. C'est le
 * genre de doublon qu'un contrôleur cherche en premier sur une note de frais.
 *
 * Heuristique par enseignes et mots-clés ; « TotalEnergies » seul est un
 * fournisseur d'électricité, pas une station : on exige « total » suivi
 * d'autre chose qu'« energies ».
 */
export function isFuelPurchase(description: string): boolean {
  const l = normalize(description);
  if (!l) return false;
  const tight = l.replace(/[\s-]/g, '');
  if (/(^|[^a-z])(esso|shell|avia|agip|dyneff|as24|carbur|station[\s-]?service|relais)([^a-z]|$)/.test(l)) return true;
  if (/(^|[^a-z])bp([^a-z]|$)/.test(l) && !/bpce|bp\s*rives|banque populaire/.test(l)) return true;
  if (/(^|[^a-z])total(?!energies)([^a-z]|$)/.test(l) && !tight.includes('totalenergies')) return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Détection des déplacements et contrôle de couverture
 *
 * Un même achat laisse jusqu'à deux traces : la FACTURE (qui porte la date du
 * passage en magasin) et la LIGNE BANCAIRE (qui porte la date du débit). Les
 * additionner compterait le trajet deux fois ; n'en lire qu'une en perd une
 * partie :
 *
 *   - une facture réglée en espèces ou sur la carte perso n'a AUCUNE ligne
 *     sur le compte de la société — invisible pour la détection bancaire ;
 *   - une course non scannée n'a aucune facture — invisible pour la détection
 *     par factures.
 *
 * On construit donc une liste unique de déplacements candidats, dédupliquée
 * par (date, destination) — exactement la clé d'idempotence de la base. Quand
 * une facture existe à quelques jours d'un débit, c'est ELLE qui date le
 * trajet : c'est la pièce qu'un contrôleur lira, et elle porte le jour réel.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Écart maximal, en jours, entre la date d'un débit et celle de la facture qui
 * le justifie. Un paiement par carte est débité un à trois jours après le
 * passage en caisse ; au-delà, on ne rapproche plus, faute de certitude.
 */
export const BANK_INVOICE_TOLERANCE_DAYS = 4;

export interface InvoiceLike {
  id: string;
  date: string;
  invoice_number: string | null;
  supplier_name: string;
  /** 'bank' | 'cash' | 'card_perso' — une facture hors banque n'a pas de débit. */
  payment_method?: string | null;
}

export interface BankLineLike {
  date: string;
  description: string;
}

/** Un déplacement reconstitué, et les pièces qui l'attestent. */
export interface TripCandidate {
  /** Clé d'idempotence, identique à `mileage_trips.dedupe_key` : « 2026-08-02|metro ». */
  key: string;
  date: string;
  dest: DestinationConfig;
  invoiceId: string | null;
  invoiceNumber: string | null;
  bankLabel: string | null;
  /** Vrai quand la date est celle du paiement, faute de mieux : à vérifier. */
  approximate: boolean;
  fromInvoice: boolean;
  fromBank: boolean;
}

/** Décale une date ISO de `n` jours (UTC, donc sans piège d'heure d'été). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Nombre de jours de `a` à `b` (positif si `b` est postérieur). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * La facture la plus proche d'une date de débit, dans la fenêtre autorisée.
 * `back` = jours d'antériorité admis (l'achat précède le débit), `forward` =
 * marge d'avance, pour absorber un décalage de saisie d'un jour.
 */
function nearestInvoice(
  invoices: InvoiceLike[],
  date: string,
  back: number,
  forward: number
): InvoiceLike | null {
  let best: InvoiceLike | null = null;
  let bestGap = Infinity;
  for (const inv of invoices) {
    const gap = daysBetween(inv.date, date); // > 0 : facture antérieure au débit
    if (gap > back || gap < -forward) continue;
    const distance = Math.abs(gap);
    if (distance < bestGap) { best = inv; bestGap = distance; }
  }
  return best;
}

/**
 * Reconstitue tous les déplacements de l'année à partir des factures ET du
 * relevé. Le résultat est dédupliqué par (date, destination) : un trajet par
 * jour et par destination, quel que soit le nombre de pièces.
 *
 * @param invoices  factures de l'année, ET du mois qui la précède (une facture
 *                  de fin décembre est débitée en janvier : elle sert alors à
 *                  dater correctement le débit, et le trajet reste sur son année).
 * @param bankLines débits du relevé (montants négatifs déjà filtrés par l'appelant).
 */
export function buildTripCandidates(
  invoices: InvoiceLike[],
  bankLines: BankLineLike[],
  config: MileageConfig,
  year: number
): TripCandidate[] {
  const byKey = new Map<string, TripCandidate>();
  const invoicesByDest = new Map<string, InvoiceLike[]>();

  const put = (c: TripCandidate) => {
    const existing = byKey.get(c.key);
    if (!existing) { byKey.set(c.key, c); return; }
    // Deux pièces pour le même déplacement : on les fusionne, sans jamais
    // créer une seconde ligne.
    existing.fromInvoice = existing.fromInvoice || c.fromInvoice;
    existing.fromBank = existing.fromBank || c.fromBank;
    existing.invoiceId = existing.invoiceId ?? c.invoiceId;
    existing.invoiceNumber = existing.invoiceNumber ?? c.invoiceNumber;
    existing.bankLabel = existing.bankLabel ?? c.bankLabel;
    // Une pièce datée avec certitude lève le doute sur la date.
    existing.approximate = existing.approximate && c.approximate;
  };

  // ── 1. Les factures : la date du passage en magasin, sans ambiguïté ──────
  for (const inv of invoices) {
    if (!inv?.date) continue;
    const dest = matchDestination(inv.supplier_name || '', config.destinations);
    if (!dest) continue;

    const list = invoicesByDest.get(dest.key) ?? [];
    list.push(inv);
    invoicesByDest.set(dest.key, list);

    if (inv.date.slice(0, 4) !== String(year)) continue;
    put({
      key: `${inv.date}|${dest.key}`,
      date: inv.date,
      dest,
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number ?? null,
      bankLabel: null,
      approximate: false,
      fromInvoice: true,
      fromBank: false,
    });
  }

  // ── 2. Le relevé : plus complet, mais daté du débit ──────────────────────
  for (const tx of bankLines) {
    if (!tx?.date) continue;
    const dest = matchDestination(tx.description || '', config.destinations);
    if (!dest) continue;

    const { date, exact } = tripDateFromLabel(tx.description || '', tx.date);

    // La facture fait foi sur la date : quand il en existe une dans la fenêtre,
    // le trajet prend SA date — ce qui évite au passage de créer un doublon à
    // un jour d'écart de la ligne issue de la facture.
    const snapped = nearestInvoice(
      invoicesByDest.get(dest.key) ?? [],
      date,
      exact ? 1 : BANK_INVOICE_TOLERANCE_DAYS,
      1
    );
    const tripDate = snapped ? snapped.date : date;
    if (tripDate.slice(0, 4) !== String(year)) continue;

    put({
      key: `${tripDate}|${dest.key}`,
      date: tripDate,
      dest,
      invoiceId: snapped?.id ?? null,
      invoiceNumber: snapped?.invoice_number ?? null,
      bankLabel: tx.description || null,
      approximate: snapped ? false : !exact,
      fromInvoice: Boolean(snapped),
      fromBank: true,
    });
  }

  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Libellé du justificatif porté sur la note de frais. */
export function candidateNote(c: TripCandidate): string {
  const parts: string[] = [];
  if (c.invoiceNumber) parts.push(`Facture n° ${c.invoiceNumber}`);
  else if (c.fromInvoice) parts.push('Facture scannée');
  if (c.bankLabel) parts.push(c.bankLabel);
  if (c.approximate) parts.push('date de paiement');
  return parts.join(' — ');
}

/** D'où vient un candidat, en clair. */
export function candidateOrigin(c: TripCandidate): string {
  if (c.fromInvoice && c.fromBank) return 'Facture + banque';
  if (c.fromInvoice) return 'Facture seule';
  return 'Banque seule';
}

export interface CoverageTrip {
  id: string;
  date: string;
  destination_key: string;
  label: string;
  driver: string;
  source: string;
}

export interface CoverageReport {
  /** Tous les déplacements reconstitués sur l'année. */
  candidates: TripCandidate[];
  /** Ceux qui n'ont pas de trajet enregistré : ce sont les oublis. */
  missing: TripCandidate[];
  /** Trajets automatiques qu'aucune pièce ne justifie (date corrigée, faux positif…). */
  unsupported: CoverageTrip[];
  /** Factures dont le fournisseur n'a pas pu être identifié : non rattachables. */
  unidentifiedInvoices: number;
  counts: { both: number; invoiceOnly: number; bankOnly: number; covered: number };
}

/**
 * Compare ce que les pièces racontent à ce qui est enregistré.
 *
 * Volontairement indépendant du conducteur sélectionné : la clé d'unicité en
 * base ne l'est pas non plus. Un trajet saisi au nom de Justine couvre bien la
 * facture, même si l'écran affiche Yohan.
 */
export function analyseCoverage(
  candidates: TripCandidate[],
  trips: CoverageTrip[],
  year: number,
  unidentifiedInvoices = 0
): CoverageReport {
  const yearTrips = trips.filter(t => t.date?.startsWith(String(year)));
  const tripKeys = new Set(yearTrips.map(t => `${t.date}|${t.destination_key}`));
  const candidateKeys = new Set(candidates.map(c => c.key));

  const missing = candidates.filter(c => !tripKeys.has(c.key));
  const unsupported = yearTrips.filter(
    t => t.source !== 'manuel' && !candidateKeys.has(`${t.date}|${t.destination_key}`)
  );

  return {
    candidates,
    missing,
    unsupported,
    unidentifiedInvoices,
    counts: {
      both: candidates.filter(c => c.fromInvoice && c.fromBank).length,
      invoiceOnly: candidates.filter(c => c.fromInvoice && !c.fromBank).length,
      bankOnly: candidates.filter(c => !c.fromInvoice && c.fromBank).length,
      covered: candidates.length - missing.length,
    },
  };
}
