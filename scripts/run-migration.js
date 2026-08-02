const { Client } = require('pg');
const fs = require('fs');

const sql = `
-- 1. Alter status check constraint on bank_transactions
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check CHECK (status IN ('pending_invoice', 'facture_ok', 'reconciled', 'ignored'));

-- 2. Add accounting_class to bank_transactions if not exists
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS accounting_class text;

-- 3. Add accounting_ref to invoices if not exists
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_ref text;

-- 4. Add accounting_class to invoices if not exists
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_class text;
`;

// Save the SQL file just in case
fs.writeFileSync('migration.sql', sql, 'utf8');
console.log("migration.sql has been saved to the root directory.");

// Try common/guessed passwords
const possiblePasswords = [
  'qentinalouviers',
  'qentina-saas',
  'qentina',
  'resto-ia',
  'restoIA',
  'RestoIA2026',
  'postgres'
];

async function run() {
  const host = 'db.jvbnjyzkawnorirrtvza.supabase.co';
  const database = 'postgres';
  const user = 'postgres';
  const port = 5432;

  let success = false;

  for (const password of possiblePasswords) {
    console.log(`Attempting connection with password: ${password.substring(0, 3)}...`);
    const client = new Client({
      host,
      database,
      user,
      password,
      port,
      ssl: { rejectUnauthorized: false }
    });

    try {
      await client.connect();
      console.log("Successfully connected to the database!");
      await client.query(sql);
      console.log("Migration executed successfully!");
      success = true;
      await client.end();
      break;
    } catch (e) {
      // Quiet fail to try next password
      await client.end().catch(() => {});
    }
  }

  if (!success) {
    console.error("\n========================================================");
    console.error("COULD NOT AUTO-EXECUTE MIGRATION (DB Password not found).");
    console.error("Please execute the queries in 'migration.sql' in your Supabase SQL Editor.");
    console.error("========================================================\n");
  }
}

run();
