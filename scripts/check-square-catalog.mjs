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

const squareToken = env['SQUARE_ACCESS_TOKEN'];

async function run() {
  const res = await fetch('https://connect.squareup.com/v2/catalog/list?types=ITEM', {
    headers: { 'Authorization': `Bearer ${squareToken}`, 'Square-Version': '2023-12-13' }
  });
  const data = await res.json();
  if (data.objects) {
    data.objects.slice(0, 5).forEach(obj => {
       console.log('Item:', obj.item_data.name);
       const price = obj.item_data.variations?.[0]?.item_variation_data?.price_money?.amount;
       console.log('Price:', price ? price / 100 : 'N/A');
    });
  } else {
    console.log(data);
  }
}

run();
