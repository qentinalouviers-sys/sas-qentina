import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read environment variables from .env.local
const envContent = fs.readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  if (line.includes('=')) {
    const [key, val] = line.split('=');
    env[key.trim()] = val.trim();
  }
});

const SUPABASE_URL = env['NEXT_PUBLIC_SUPABASE_URL'];
const SERVICE_ROLE_KEY = env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sql = `
  ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
  ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check CHECK (status IN ('pending_invoice', 'reconciled', 'ignored', 'facture_ok'));
`;

async function main() {
  console.log("⚡ Updating bank_transactions status constraint via RPC...");
  
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  console.log(`Response Status: ${res.status}`);
  console.log(`Response Body: ${text}`);

  if (res.ok) {
    console.log("✅ Constraint updated successfully!");
  } else {
    console.error("❌ Failed to update constraint.");
  }
}

main().catch(console.error);
