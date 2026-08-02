import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  try {
    const squareToken = process.env.SQUARE_ACCESS_TOKEN;
    if (!squareToken) throw new Error('No Square token configured');

    const res = await fetch('https://connect.squareup.com/v2/catalog/list?types=ITEM', {
      headers: {
        'Authorization': `Bearer ${squareToken}`,
        'Square-Version': '2023-12-13',
      },
    });

    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].detail);

    const items = data.objects || [];
    const supabase = createServiceRoleClient();

    let importedCount = 0;

    for (const obj of items) {
      const name = obj.item_data.name;
      const priceCents = obj.item_data.variations?.[0]?.item_variation_data?.price_money?.amount;
      const price = priceCents ? priceCents / 100 : 0;

      // Check if recipe already exists
      const { data: existing } = await supabase
        .from('recipes')
        .select('id')
        .eq('name', name)
        .maybeSingle();

      if (!existing) {
        // Simple heuristic for category
        let category = 'pizza';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('panuozzo')) category = 'panuozzo';
        else if (nameLower.includes('salade')) category = 'salade';
        else if (nameLower.includes('dessert') || nameLower.includes('tiramisu')) category = 'dessert';

        await supabase.from('recipes').insert({
          name,
          category,
          portions: 1,
          selling_price: price
        });
        importedCount++;
      } else {
        // Optionally update the price if it changed, but let's just leave it for now
        await supabase.from('recipes').update({ selling_price: price }).eq('id', existing.id);
      }
    }

    return NextResponse.json({ success: true, count: importedCount, total: items.length });
  } catch (error: any) {
    console.error('Square Catalog Import Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
