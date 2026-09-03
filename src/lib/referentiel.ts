import { foldLabel } from '@/lib/accounting';

/**
 * referentiel.ts — Rapprocher un libellé lu sur une facture d'une fiche.
 *
 * Deux référentiels vivent ici : les fournisseurs et les ingrédients. Dans les
 * deux cas la règle est la même, et volontairement stricte : une
 * correspondance est une ÉGALITÉ après normalisation, jamais une inclusion.
 * « Tomate » ne doit pas capter « Concentré de tomate », et « Métro » ne doit
 * pas capter « Eurométro ». Ce qui ne correspond à rien attend qu'un humain le
 * rattache — c'est le prix d'une mercuriale qui reste juste.
 *
 * Fonctions pures, testées dans verify:compta.
 */

/**
 * Répare un libellé dont l'UTF-8 a été relu comme du latin-1 (« MÃ©tro »).
 * Sans effet sur un libellé sain. En cas de doute, renvoie l'original.
 */
export function repairMojibake(s: string): string {
  if (!/[ÃÂ]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(Array.from(s, ch => ch.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return repaired.includes('�') ? s : repaired;
  } catch {
    return s;
  }
}

/** Forme canonique d'un libellé : réparé, sans accents, minuscules, espaces réduits. */
export function normalizeName(s: string | null | undefined): string {
  return foldLabel(repairMojibake(String(s ?? '')));
}

/** Nom tel qu'on veut le stocker : réparé et débarrassé des espaces parasites. */
export function cleanName(s: string): string {
  return repairMojibake(s).replace(/\s+/g, ' ').trim();
}

export interface NamedRow { id: string; name: string }
export interface AliasRow { alias: string; ingredient_id: string }

/** Fournisseur dont le nom, normalisé, est exactement celui cherché. */
export function findSupplierMatch<T extends NamedRow>(name: string, suppliers: readonly T[]): T | null {
  const key = normalizeName(name);
  if (!key) return null;
  return suppliers.find(s => normalizeName(s.name) === key) ?? null;
}

/**
 * Ingrédient correspondant à une désignation : par son nom, ou par un alias
 * que l'humain a validé. Rien d'autre.
 */
export function matchIngredient<T extends NamedRow>(
  designation: string,
  ingredients: readonly T[],
  aliases: readonly AliasRow[],
): T | null {
  const key = normalizeName(designation);
  if (!key) return null;
  const byName = ingredients.find(i => normalizeName(i.name) === key);
  if (byName) return byName;
  const alias = aliases.find(a => a.alias === key);
  return alias ? ingredients.find(i => i.id === alias.ingredient_id) ?? null : null;
}

export interface UnmatchedDesignation {
  /** Désignation telle qu'elle apparaît le plus souvent sur les factures. */
  designation: string;
  /** Sa forme normalisée — c'est elle qu'on enregistre comme alias. */
  key: string;
  /** Nombre de lignes de facture qui la portent. */
  count: number;
  unit: string | null;
  lastPrice: number | null;
}

/**
 * Désignations alimentaires qui ne mettent à jour aucun prix, regroupées et
 * classées par fréquence : les plus achetées d'abord, ce sont elles qui
 * pèsent sur le coût matières.
 */
export function unmatchedDesignations(
  lines: readonly { designation: string | null; unit?: string | null; unit_price_ht?: number | null }[],
  ingredients: readonly NamedRow[],
  aliases: readonly AliasRow[],
): UnmatchedDesignation[] {
  const groups = new Map<string, UnmatchedDesignation>();
  for (const l of lines) {
    const raw = cleanName(l.designation ?? '');
    const key = normalizeName(raw);
    if (!key) continue;
    if (matchIngredient(raw, ingredients, aliases)) continue;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (l.unit_price_ht != null) g.lastPrice = l.unit_price_ht;
    } else {
      groups.set(key, {
        designation: raw, key, count: 1,
        unit: l.unit ?? null,
        lastPrice: l.unit_price_ht ?? null,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.designation.localeCompare(b.designation));
}
