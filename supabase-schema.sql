-- =============================================
-- QENTINA SaaS — Schéma Supabase complet
-- =============================================

-- Enable extensions
create extension if not exists "uuid-ossp";

-- =============================================
-- Auth: Supabase Auth handles user management
-- =============================================

-- Fournisseurs
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- Reglages App
create table app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
alter table app_settings enable row level security;
create policy "Authenticated users full access" on app_settings for all using (auth.role() = 'authenticated');

-- Factures
create table invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id) on delete set null,
  invoice_number text,
  date date not null,
  total_ht numeric,
  total_ttc numeric,
  pdf_url text,
  created_at timestamptz default now()
);

-- Lignes de factures
create table invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  designation text not null,
  quantity numeric,
  unit text,
  unit_price_ht numeric,
  total_ht numeric,
  category text check (category in ('alimentaire','materiel','emballage','boisson','autre')),
  created_at timestamptz default now()
);

-- Référentiel ingrédients
create table ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text,
  last_unit_price numeric,
  last_updated timestamptz,
  created_at timestamptz default now()
);

-- Fiches techniques
create table recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text check (category in ('pizza','panuozzo','salade','plat','dessert','protocole_pate','base_sauce')),
  portions integer default 1,
  selling_price numeric,
  created_at timestamptz default now()
);

-- Ingrédients par recette
create table recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid references recipes(id) on delete cascade,
  ingredient_id uuid references ingredients(id) on delete cascade,
  sub_recipe_id uuid references recipes(id) on delete cascade,
  quantity numeric,
  unit text,
  check (ingredient_id is not null or sub_recipe_id is not null)
);

-- Inventaires physiques
create table inventory_counts (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid references ingredients(id) on delete cascade,
  quantity numeric,
  unit_price numeric,
  counted_at timestamptz default now()
);

-- Ventes Square
create table square_orders (
  id uuid primary key default gen_random_uuid(),
  square_order_id text unique,
  total_money numeric,
  net_amount numeric,
  discount_amount numeric,
  service date,
  created_at timestamptz default now()
);

-- Détail articles vendus
create table square_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references square_orders(id) on delete cascade,
  name text,
  quantity integer,
  base_price numeric,
  total_price numeric
);

-- Heures équipe
create table labor_timecards (
  id uuid primary key default gen_random_uuid(),
  employee_name text,
  start_at timestamptz,
  end_at timestamptz,
  hours_worked numeric,
  hourly_rate numeric
);

-- =============================================
-- Indexes pour performance
-- =============================================
create index idx_invoices_date on invoices(date);
create index idx_invoices_supplier on invoices(supplier_id);
create index idx_invoice_lines_invoice on invoice_lines(invoice_id);
create index idx_invoice_lines_category on invoice_lines(category);
create index idx_recipe_ingredients_recipe on recipe_ingredients(recipe_id);
create index idx_recipe_ingredients_ingredient on recipe_ingredients(ingredient_id);
create index idx_inventory_counts_ingredient on inventory_counts(ingredient_id);
create index idx_square_orders_service on square_orders(service);
create index idx_square_items_order on square_items(order_id);
create index idx_labor_timecards_start on labor_timecards(start_at);

-- =============================================
-- Row Level Security (RLS)
-- =============================================
alter table suppliers enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table ingredients enable row level security;
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table inventory_counts enable row level security;
alter table square_orders enable row level security;
alter table square_items enable row level security;
alter table labor_timecards enable row level security;

-- Nouveaux champs pour plus de données Square
alter table square_orders add column if not exists raw_data jsonb;
alter table square_items add column if not exists category_name text;

-- Policies: authenticated users can do everything (family access)
create policy "Authenticated users full access" on suppliers for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on invoices for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on invoice_lines for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on ingredients for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on recipes for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on recipe_ingredients for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on inventory_counts for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on square_orders for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on square_items for all using (auth.role() = 'authenticated');
create policy "Authenticated users full access" on labor_timecards for all using (auth.role() = 'authenticated');

-- =============================================
-- Seed data : fournisseurs principaux
-- =============================================
insert into suppliers (name) values ('Métro'), ('Mozzalat');

-- =============================================
-- Transactions Bancaires (Pointage)
-- =============================================
create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  amount numeric not null,
  category text check (category in ('fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'variable_fournisseur', 'variable_salaire', 'impot_taxe', 'recette', 'autre')),
  status text default 'pending_invoice' check (status in ('pending_invoice', 'reconciled', 'ignored')),
  invoice_id uuid references invoices(id) on delete set null,
  created_at timestamptz default now()
);

create index idx_bank_transactions_date on bank_transactions(date);
alter table bank_transactions enable row level security;
create policy "Authenticated users full access" on bank_transactions for all using (auth.role() = 'authenticated');
