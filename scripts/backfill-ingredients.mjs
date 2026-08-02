import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const envLines = envContent.split('\n');
const env = {};
for (const line of envLines) {
  if (line.includes('=')) {
    const [key, val] = line.split('=');
    env[key.trim()] = val.trim();
  }
}

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);

async function backfill() {
  console.log('Fetching invoice lines...');
  const { data: lines, error } = await supabase
    .from('invoice_lines')
    .select('designation, unit, unit_price_ht, category')
    .in('category', ['alimentaire', 'boisson']);

  if (error) {
    console.error(error);
    return;
  }

  console.log(`Found ${lines.length} food/drink invoice lines.`);

  // Find unique ingredients (keeping the latest/highest price or just the first encountered)
  const uniqueIngMap = new Map();
  for (const line of lines) {
    if (line.designation) {
      const key = line.designation.toUpperCase().trim();
      if (!uniqueIngMap.has(key)) {
        uniqueIngMap.set(key, {
          name: line.designation,
          unit: line.unit || 'kg',
          last_unit_price: line.unit_price_ht || 0,
        });
      }
    }
  }

  console.log(`Found ${uniqueIngMap.size} unique ingredients.`);

  let inserted = 0;
  for (const ing of uniqueIngMap.values()) {
    // Check if exists
    const { data: existing } = await supabase
      .from('ingredients')
      .select('id')
      .ilike('name', ing.name)
      .limit(1)
      .single();

    if (!existing) {
      await supabase.from('ingredients').insert({
        name: ing.name,
        unit: ing.unit,
        last_unit_price: ing.last_unit_price,
        last_updated: new Date().toISOString()
      });
      inserted++;
    }
  }

  console.log(`Inserted ${inserted} new ingredients into the database.`);
}

backfill();
