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

async function check() {
  const { data } = await supabase.from('ingredients').select('*');
  for (const item of data) {
    if (item.unit === 'pièce' || item.unit === 'unité' || item.unit === 'boite' || item.unit === 'carton') {
      console.log(`${item.name} (${item.last_unit_price} / ${item.unit})`);
    }
  }
}
check();
