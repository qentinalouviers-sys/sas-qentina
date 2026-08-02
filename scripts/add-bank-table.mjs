import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Variables d'environnement manquantes.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const sql = `
  create table if not exists bank_transactions (
    id uuid primary key default gen_random_uuid(),
    date date not null,
    description text not null,
    amount numeric not null,
    category text check (category in ('fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'variable_fournisseur', 'variable_salaire', 'impot_taxe', 'recette', 'autre')),
    status text default 'pending_invoice' check (status in ('pending_invoice', 'reconciled', 'ignored')),
    invoice_id uuid references invoices(id) on delete set null,
    created_at timestamptz default now()
  );

  create index if not exists idx_bank_transactions_date on bank_transactions(date);
  alter table bank_transactions enable row level security;
  
  do $$ 
  begin
    if not exists (select from pg_policies where policyname = 'Authenticated users full access' and tablename = 'bank_transactions') then
      create policy "Authenticated users full access" on bank_transactions for all using (auth.role() = 'authenticated');
    end if;
  end $$;
`;

async function run() {
  console.log('Running schema update...');
  // Since supabase-js doesn't have a generic SQL execution method without an RPC, 
  // We can't directly run arbitrary SQL via the JS client easily unless there's an RPC or we use the REST endpoint.
  // Actually, since this is a local setup and the user has the Supabase dashboard open, I will just ask them to paste it.
  console.log('Please run the SQL manually in Supabase dashboard.');
}

run();
