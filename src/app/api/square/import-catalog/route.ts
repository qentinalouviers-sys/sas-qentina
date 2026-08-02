import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { squareFetch } from '@/lib/square';

/**
 * Import du catalogue Square → table recipes.
 * Crée les recettes manquantes (avec catégorie devinée) et
 * met à jour le prix de vente de celles qui existent déjà.
 */
export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const data = await squareFetch('/catalog/list?types=ITEM');
    if (data.errors) throw new Error(data.errors[0].detail);

    const items: any[] = data.objects || [];
    const supabase = createServiceRoleClient();

    // Une seule requête pour toutes les recettes existantes (au lieu d'une par article)
    const { data: existingRecipes } = await supabase.from('recipes').select('id, name');
    const existingByName = new Map(
      (existingRecipes || []).map((r: { id: string; name: string }) => [r.name, r.id])
    );

    let importedCount = 0;

    for (const obj of items) {
      const name = obj.item_data?.name;
      if (!name) continue;
      const priceCents = obj.item_data.variations?.[0]?.item_variation_data?.price_money?.amount;
      const price = priceCents ? priceCents / 100 : 0;

      const existingId = existingByName.get(name);
      if (existingId) {
        await supabase.from('recipes').update({ selling_price: price }).eq('id', existingId);
      } else {
        const nameLower = name.toLowerCase();
        let category = 'pizza';
        if (nameLower.includes('panuozzo')) category = 'panuozzo';
        else if (nameLower.includes('salade')) category = 'salade';
        else if (nameLower.includes('dessert') || nameLower.includes('tiramisu')) category = 'dessert';

        await supabase.from('recipes').insert({ name, category, portions: 1, selling_price: price });
        importedCount++;
      }
    }

    return NextResponse.json({ success: true, count: importedCount, total: items.length });
  } catch (error: any) {
    console.error('Square Catalog Import Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
