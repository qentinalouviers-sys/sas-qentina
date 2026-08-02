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
  const { data, error } = await supabase
    .from('square_orders')
    .select('*')
    .gte('service', '2026-01-01');
    
  if (error) {
    console.error(error);
    return;
  }
  
  console.log(`Total orders in 2026: ${data.length}`);
  
  const totalMoneySum = data.reduce((sum, o) => sum + Number(o.total_money), 0);
  const netAmountSum = data.reduce((sum, o) => sum + Number(o.net_amount), 0);
  
  console.log(`Sum of total_money: ${totalMoneySum}`);
  console.log(`Sum of net_amount: ${netAmountSum}`);
}

check();
