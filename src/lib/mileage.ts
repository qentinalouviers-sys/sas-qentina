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
