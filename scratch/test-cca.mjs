import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Parse .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const parts = line.split('=');
  if (parts.length >= 2) {
    const key = parts[0].trim();
    const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
});

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'] || env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];

console.log("Supabase URL:", supabaseUrl);
console.log("Supabase Key defined:", !!supabaseKey);

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing keys in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log("Checking movements...");
  const { data: movements, error: movementsErr } = await supabase
    .from('mouvements_cca')
    .select('*');
    
  if (movementsErr) {
    console.error("Error reading mouvements_cca:", movementsErr);
  } else {
    console.log("mouvements_cca table exists. Found rows:", movements.length);
    console.log(movements);
  }

  console.log("Checking bank transactions...");
  const { data: transactions, error: transactionsErr } = await supabase
    .from('bank_transactions')
    .select('*')
    .limit(5);
    
  if (transactionsErr) {
    console.error("Error reading bank_transactions:", transactionsErr);
  } else {
    console.log("bank_transactions table exists. Sample rows:", transactions.length);
  }
}

run();
