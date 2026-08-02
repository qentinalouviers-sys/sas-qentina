import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
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
const anthropicKey = env['ANTHROPIC_API_KEY'];
const supabase = createClient(supabaseUrl, supabaseKey);
const anthropic = new Anthropic({ apiKey: anthropicKey });

async function fix() {
  const { data } = await supabase.from('ingredients').select('*');
  
  const standardUnits = ['kg', 'l', 'g', 'ml', 'cl'];
  
  // Find all items that are not in standardUnits. 
  // We also include 'unité' if the name has a weight in it, but let's just grab everything that isn't standard weight/vol.
  const badItems = data.filter(i => {
    const u = (i.unit || '').toLowerCase().trim();
    if (standardUnits.includes(u)) return false;
    // We also want to re-process 'unité' if it actually contains a weight in the name (e.g. 1KG)
    if (u === 'unité') {
      const name = i.name.toLowerCase();
      if (name.includes('kg') || name.includes('g') || name.includes('cl') || name.includes('l')) {
        return true;
      }
      return false; // genuine piece
    }
    return true; // anything else like 'pce', 'boite', 'bouteille', 'sac', etc.
  });

  if (badItems.length === 0) {
    console.log('No bad items found.');
    return;
  }

  console.log(`Found ${badItems.length} items to fix.`);

  const prompt = `Voici une liste d'ingrédients de restaurant avec leurs prix par "pce", "carton", "bouteille", "sac", "barquette", etc. 
Corrige-les pour avoir l'unité standard de base (kg ou L) et recalcule le prix unitaire en fonction du poids/volume trouvé dans le nom.
Par exemple:
"SEL FIN ETUI 1KG BALEINE", price: 0.83 -> unit: "kg", price: 0.83
"FARINE 25KG", price: 25 -> unit: "kg", price: 1
"MOZZARELLA 150G", price: 1.5 -> unit: "kg", price: 10
"COCA 33CL", price: 1 -> unit: "L", price: 3.03
"OIGNON ROUGE 4/4" -> If it's a can (4/4 usually means 800g), unit: "kg", price adjusted. If unknown, use "unité" and raw price.
"SUPER BOCK 25CLX24", price 20 -> 24 * 0.25L = 6L. unit: "L", price: 20/6 = 3.33.

Input JSON:
${JSON.stringify(badItems.map(i => ({ id: i.id, name: i.name, current_unit: i.unit, price: i.last_unit_price })), null, 2)}

Retourne UNIQUEMENT un tableau JSON valide avec ce format exact :
[
  { "id": "...", "unit": "kg|L|unité", "new_price": 1.23 }
]`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    const jsonStr = msg.content[0].text;
    const arrayStart = jsonStr.indexOf('[');
    const arrayEnd = jsonStr.lastIndexOf(']') + 1;
    const json = JSON.parse(jsonStr.substring(arrayStart, arrayEnd));
    
    let updated = 0;
    for (const item of json) {
      if (item.unit && item.new_price) {
        await supabase.from('ingredients').update({
          unit: item.unit,
          last_unit_price: item.new_price
        }).eq('id', item.id);
        updated++;
        console.log(`Updated ${item.id} (${badItems.find(i => i.id === item.id)?.name}): ${item.new_price} / ${item.unit}`);
      }
    }
    console.log(`Updated ${updated} items successfully.`);
  } catch(e) {
    console.error('Failed to parse Claude output', e);
  }
}

fix();
