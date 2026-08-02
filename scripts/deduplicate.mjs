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

async function runDeduplication(dryRun = true) {
  console.log(`=== DEDUPLICATION OF BANK TRANSACTIONS (DRY_RUN = ${dryRun}) ===`);
  const { data: allTx, error } = await supabase
    .from('bank_transactions')
    .select('*')
    .order('date', { ascending: false });

  if (error) {
    console.error("Error fetching transactions:", error);
    return;
  }

  const seen = {};
  allTx.forEach(tx => {
    const key = `${tx.date}_${tx.amount}`;
    if (!seen[key]) {
      seen[key] = [];
    }
    seen[key].push(tx);
  });

  let toDeleteIds = [];
  let totalSaved = 0;

  for (const [key, list] of Object.entries(seen)) {
    if (list.length > 1) {
      // We have duplicates. Let's decide which one to KEEP.
      // Rule 1: Keep the one that is linked to an invoice (has invoice_id)
      let keep = list.find(tx => tx.invoice_id !== null);

      if (!keep) {
        // Rule 2: Keep the one with the longest description (more detailed reference)
        keep = list.reduce((longest, current) => {
          return (current.description || '').length > (longest.description || '').length ? current : longest;
        }, list[0]);
      }

      // Mark the others for deletion
      list.forEach(tx => {
        if (tx.id !== keep.id) {
          toDeleteIds.push({
            id: tx.id,
            date: tx.date,
            amount: tx.amount,
            description: tx.description,
            keepDesc: keep.description
          });
        }
      });
    }
  }

  console.log(`\nFound ${toDeleteIds.length} duplicate transactions to delete.`);
  toDeleteIds.forEach((item, index) => {
    console.log(`[${index + 1}] DELETE: "${item.description}" | KEEP: "${item.keepDesc}" (Date: ${item.date}, Amount: ${item.amount})`);
  });

  if (!dryRun && toDeleteIds.length > 0) {
    console.log(`\nDeleting duplicates in database...`);
    const ids = toDeleteIds.map(item => item.id);
    const { error: delErr } = await supabase
      .from('bank_transactions')
      .delete()
      .in('id', ids);

    if (delErr) {
      console.error("Error during deletion:", delErr);
    } else {
      console.log(`✅ Successfully deleted ${ids.length} duplicate transactions from database!`);
    }
  }
}

// Default to dry-run
const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');
runDeduplication(dryRun);
