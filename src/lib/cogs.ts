/**
 * cogs.ts — Coût matières consommé : achats ± variation de stock.
 *
 * Le food cost se calculait comme « achats de la période ÷ chiffre d'affaires ».
 * C'est un proxy, pas une mesure : une grosse commande Metro le 30 fait
 * exploser le ratio du mois et flatte celui du suivant. La formule juste :
 *
 *     coût matières = stock initial + achats − stock final
 *
 * Le stock, on le connaît par les inventaires physiques. Ce module relie les
 * deux, avec des règles strictes pour ne jamais produire un chiffre qu'on ne
 * sait pas défendre :
 *
 *  - un inventaire n'est pris en compte à une borne que s'il a été fait à
 *    moins de INVENTORY_TOLERANCE_DAYS de cette borne ;
 *  - la variation ne se calcule que sur les produits comptés AUX DEUX bornes.
 *    Un produit compté une seule fois n'apporte rien : sinon un inventaire
 *    partiel fabriquerait une variation de stock fictive ;
 *  - s'il manque un inventaire à l'une des bornes, on retombe sur les achats,
 *    et on le dit (`method: 'achats'`).
 *
 * Fonctions pures, testées dans verify:compta.
 */

export interface InventoryCountRow {
  ingredient_id: string;
  quantity: number | null;
  unit_price: number | null;
  counted_at: string;
}

/** Une journée d'inventaire : tous les comptages saisis le même jour. */
export interface InventorySession {
  /** Jour ISO (AAAA-MM-JJ). */
  day: string;
  /** Dernière quantité saisie ce jour-là pour chaque ingrédient, et sa valeur. */
  items: Map<string, { quantity: number; value: number }>;
  products: number;
  valorisation: number;
}

/** Nombre de jours d'écart tolérés entre un inventaire et la borne qu'il sert. */
export const INVENTORY_TOLERANCE_DAYS = 7;

const round2 = (n: number) => Math.round(n * 100) / 100;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/** Regroupe les comptages par journée. Les journées sont triées, la plus récente d'abord. */
export function inventorySessions(counts: readonly InventoryCountRow[]): InventorySession[] {
  const byDay = new Map<string, InventorySession>();
  // Du plus ancien au plus récent : la dernière saisie du jour l'emporte.
  const ordered = [...counts].sort((a, b) => String(a.counted_at).localeCompare(String(b.counted_at)));
  for (const c of ordered) {
    const day = String(c.counted_at).slice(0, 10);
    if (!day || day.length !== 10) continue;
    const session = byDay.get(day) ?? { day, items: new Map(), products: 0, valorisation: 0 };
    const quantity = Number(c.quantity) || 0;
    session.items.set(c.ingredient_id, { quantity, value: quantity * (Number(c.unit_price) || 0) });
    byDay.set(day, session);
  }
  for (const s of byDay.values()) {
    s.products = s.items.size;
    let v = 0;
    for (const it of s.items.values()) v += it.value;
    s.valorisation = round2(v);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * L'inventaire qui sert de borne à une date : le plus proche, à moins de
 * `tolerance` jours. À égalité, le plus ancien (celui d'avant la borne : un
 * inventaire du 31 au soir décrit le stock de fin de mois).
 */
export function sessionAtBoundary(
  sessions: readonly InventorySession[],
  boundary: string,
  tolerance = INVENTORY_TOLERANCE_DAYS,
): InventorySession | null {
  let best: InventorySession | null = null;
  let bestDist = Infinity;
  for (const s of sessions) {
    const d = daysBetween(s.day, boundary);
    if (d > tolerance) continue;
    if (d < bestDist || (d === bestDist && best && s.day < best.day)) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

export type CogsMethod = 'inventaire' | 'achats';

export interface CogsResult {
  /** Coût matières retenu pour le ratio. */
  cogs: number;
  method: CogsMethod;
  /** Achats HT de la période (factures ventilées + paiements sans facture). */
  purchases: number;
  /** Variation de stock retenue (stock final − stock initial, sur les produits communs). Positive = on a stocké. */
  stockVariation: number;
  opening: { day: string; value: number } | null;
  closing: { day: string; value: number } | null;
  /** Produits comptés aux deux bornes — les seuls qui entrent dans la variation. */
  commonProducts: number;
  /** Pourquoi on est en repli sur les achats, s'il y a lieu. */
  reason: string | null;
}

/**
 * Coût matières de [start, end].
 *
 * Le stock initial est celui de la veille du premier jour ; le stock final
 * celui du dernier jour. Les deux inventaires doivent exister à moins de
 * `tolerance` jours de leur borne, sinon la mesure n'est pas possible et on
 * retombe sur les achats — en le disant.
 */
export function computeCogs(input: {
  purchases: number;
  sessions: readonly InventorySession[];
  start: string;
  end: string;
  tolerance?: number;
}): CogsResult {
  const purchases = round2(input.purchases);
  const tolerance = input.tolerance ?? INVENTORY_TOLERANCE_DAYS;
  const base = {
    purchases, cogs: purchases, method: 'achats' as CogsMethod,
    stockVariation: 0, opening: null, closing: null, commonProducts: 0,
  };

  if (input.sessions.length === 0) {
    return { ...base, reason: 'Aucun inventaire enregistré.' };
  }

  const opening = sessionAtBoundary(input.sessions, addDays(input.start, -1), tolerance);
  const closing = sessionAtBoundary(input.sessions, input.end, tolerance);

  if (!opening && !closing) {
    return { ...base, reason: `Aucun inventaire à moins de ${tolerance} jours du début ni de la fin de la période.` };
  }
  if (!opening) {
    return { ...base, closing: { day: closing!.day, value: closing!.valorisation },
      reason: `Pas d'inventaire de début de période (à moins de ${tolerance} jours du ${input.start}).` };
  }
  if (!closing) {
    return { ...base, opening: { day: opening.day, value: opening.valorisation },
      reason: `Pas d'inventaire de fin de période (à moins de ${tolerance} jours du ${input.end}).` };
  }
  if (opening.day === closing.day) {
    return { ...base, opening: { day: opening.day, value: opening.valorisation },
      closing: { day: closing.day, value: closing.valorisation },
      reason: 'Le même inventaire sert aux deux bornes : période trop courte pour mesurer une variation.' };
  }

  // Variation sur les produits comptés aux deux bornes, et seulement eux.
  let variation = 0;
  let common = 0;
  for (const [id, fin] of closing.items) {
    const debut = opening.items.get(id);
    if (!debut) continue;
    common++;
    variation += fin.value - debut.value;
  }
  variation = round2(variation);

  if (common === 0) {
    return { ...base, opening: { day: opening.day, value: opening.valorisation },
      closing: { day: closing.day, value: closing.valorisation },
      reason: 'Aucun produit compté aux deux inventaires : la variation ne peut pas se mesurer.' };
  }

  return {
    purchases,
    // On a stocké (variation > 0) → une partie des achats n'a pas été consommée.
    cogs: round2(purchases - variation),
    method: 'inventaire',
    stockVariation: variation,
    opening: { day: opening.day, value: opening.valorisation },
    closing: { day: closing.day, value: closing.valorisation },
    commonProducts: common,
    reason: null,
  };
}
