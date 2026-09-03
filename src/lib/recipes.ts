/**
 * recipes.ts — Calcul du coût des recettes (source de vérité unique).
 * Avant : convertQuantity/calcRecipeCost existaient en 5 exemplaires
 * (fiches-techniques ×4, ancien menu engineering ×1), sans protection anti-cycle.
 */

/** Unités proposées dans toute l'application (une seule liste). */
export const UNITS = ['kg', 'g', 'L', 'cL', 'mL', 'unité', 'pièce', 'portion'] as const;

/** Unités de comptage : équivalentes entre elles (1 pièce = 1 unité = 1 portion). */
const COUNT = new Set(['unité', 'unite', 'pièce', 'piece', 'portion', 'barquette', 'sachet', 'boîte', 'boite']);

/**
 * Convertit une quantité entre unités compatibles.
 * - masses : g/gr ↔ kg
 * - volumes : mL/cL ↔ L (densité 1:1 assumée pour la cuisine)
 * - unités de comptage : équivalentes entre elles (1 pièce = 1 unité)
 * - familles incompatibles : renvoie la quantité telle quelle (pas de
 *   conversion possible sans densité — comportement historique conservé)
 */
export function convertQuantity(quantity: number, fromUnit: string, toUnit: string): number {
  const from = (fromUnit || '').toLowerCase().trim();
  const to = (toUnit || '').toLowerCase().trim();
  if (from === to) return quantity;

  // Comptage ↔ comptage : 1:1
  if (COUNT.has(from) && COUNT.has(to)) return quantity;

  // Masses (base : kg) — mL/L traités comme g/kg (densité 1:1)
  const isFromSmall = from === 'g' || from === 'gr' || from === 'ml';
  const isFromMid = from === 'cl';
  const isFromBase = from === 'kg' || from === 'l';
  if (!isFromSmall && !isFromMid && !isFromBase) return quantity;

  let valInBase = quantity;
  if (isFromSmall) valInBase = quantity / 1000;
  else if (isFromMid) valInBase = quantity / 100;

  if (to === 'kg' || to === 'l') return valInBase;
  if (to === 'g' || to === 'gr' || to === 'ml') return valInBase * 1000;
  if (to === 'cl') return valInBase * 100;
  return quantity;
}

interface RecipeIngredientLike {
  ingredient_id?: string | null;
  sub_recipe_id?: string | null;
  quantity?: number | null;
  unit?: string | null;
  ingredient?: { unit?: string | null; last_unit_price?: number | null } | null;
}

interface RecipeLike {
  id: string;
  portions?: number | null;
  recipe_ingredients?: RecipeIngredientLike[];
}

/**
 * Coût matière total d'une recette (sous-recettes comprises).
 * Protégé contre les cycles A→B→A (avant : récursion infinie → page figée).
 */
export function calcRecipeCost(
  ingredients: RecipeIngredientLike[] | undefined | null,
  allRecipes: RecipeLike[],
  visited: Set<string> = new Set()
): number {
  if (!ingredients) return 0;

  return ingredients.reduce((sum, r) => {
    if (r.ingredient_id && r.ingredient) {
      const qtyInIngredientUnit = convertQuantity(r.quantity || 0, r.unit || '', r.ingredient.unit || '');
      return sum + qtyInIngredientUnit * (r.ingredient.last_unit_price || 0);
    }
    if (r.sub_recipe_id) {
      if (visited.has(r.sub_recipe_id)) return sum; // cycle détecté → on ignore
      const subRec = allRecipes.find(rec => rec.id === r.sub_recipe_id);
      if (!subRec) return sum;
      const nextVisited = new Set(visited);
      nextVisited.add(r.sub_recipe_id);
      const subCost = calcRecipeCost(subRec.recipe_ingredients, allRecipes, nextVisited);
      const costPerPortion = (subRec.portions || 0) > 0 ? subCost / (subRec.portions as number) : subCost;
      // La quantité d'une sous-recette est toujours un nombre de portions
      return sum + (r.quantity || 0) * costPerPortion;
    }
    return sum;
  }, 0);
}
