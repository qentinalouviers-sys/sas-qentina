import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  if (line.includes('=')) {
    const [key, ...valParts] = line.split('=');
    const val = valParts.join('=').trim();
    env[key.trim()] = val.replace(/^["']|["']$/g, '');
  }
}

const supabase = createClient(env['NEXT_PUBLIC_SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY']);

async function findAllDuplicates() {
  console.log("Analyzing all transactions for identical date & amount duplicates...");
  const { data, error } = await supabase
    .from('bank_transactions')
    .select('*')
    .order('date', { ascending: false });

  if (error) {
    console.error("Error:", error);
    return;
  }

  const seen = {};
  const duplicates = [];

  data.forEach(tx => {
    const key = `${tx.date}_${tx.amount}`;
    if (!seen[key]) {
      seen[key] = [];
    }
    seen[key].push(tx);
  });

  console.log("\n=== Duplicate groups (same date & amount) ===");
  let groupCount = 0;
  for (const [key, list] of Object.entries(seen)) {
    if (list.length > 1) {
      groupCount++;
      console.log(`\nGroup ${groupCount} (${key}):`);
      list.forEach(tx => {
        console.log(`  ID: ${tx.id} | Desc: "${tx.description}" | Status: ${tx.status} | InvoiceID: ${tx.invoice_id}`);
      });
    }
  }
}

findAllDuplicates();
