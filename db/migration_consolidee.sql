-- ================================================================
-- QENTINA — Migration consolidée (idempotente, ré-exécutable sans risque)
-- À exécuter UNE FOIS dans Supabase → SQL Editor.
--
-- Elle regroupe les anciennes migrations (migration.sql, migration_cca.sql,
-- migration_dedup.sql, migration_tva.sql) et ajoute les colonnes que le
-- code utilisait jusqu'ici avec des « fallbacks » (payment_method, etc.).
-- Après son exécution, le code n'a plus besoin d'aucun plan B.
-- ================================================================

-- ── 1. Factures : colonnes comptables & TVA ─────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_ref text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accounting_class text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS type_document text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_name_present boolean DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tva_recoverable boolean DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'bank';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_notes text;

-- ── 2. Transactions bancaires ───────────────────────────────────
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS accounting_class text;

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check
  CHECK (status IN ('pending_invoice', 'facture_ok', 'reconciled', 'ignored'));

-- Index anti-doublons (date + libellé normalisé + montant)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_unique
ON bank_transactions (
  date,
  lower(trim(regexp_replace(description, '\s+', ' ', 'g'))),
  amount
);

-- ── 3. Données Square enrichies ─────────────────────────────────
ALTER TABLE square_orders ADD COLUMN IF NOT EXISTS raw_data jsonb;
ALTER TABLE square_items ADD COLUMN IF NOT EXISTS category_name text;

-- ── 4. Comptes Courants d'Associés (CCA) ────────────────────────
CREATE TABLE IF NOT EXISTS mouvements_cca (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  associe text NOT NULL CHECK (associe IN ('justine', 'yohan')),
  sens text NOT NULL CHECK (sens IN ('apport', 'remboursement')),
  sous_type text NOT NULL CHECK (sous_type IN ('facture_payee_perso', 'avance_tresorerie', 'frais_perso_reverse')),
  montant numeric NOT NULL CHECK (montant > 0),
  piece_justif text,
  rapproche_banque boolean DEFAULT false,
  date_virement_banque date,
  note text,
  bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE mouvements_cca ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE;

ALTER TABLE mouvements_cca ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users full access" ON mouvements_cca;
CREATE POLICY "Authenticated users full access" ON mouvements_cca
  FOR ALL USING (auth.role() = 'authenticated');

-- ── 5. Réglages applicatifs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users full access" ON app_settings;
CREATE POLICY "Authenticated users full access" ON app_settings
  FOR ALL USING (auth.role() = 'authenticated');

-- ── 5 bis. Deux catégories manquantes ───────────────────────────
--
-- `investissement` : achats d'équipement, travaux d'aménagement, réparations.
-- Ils n'ont leur place ni dans le coût matières (ce ne sont pas des achats
-- revendus) ni dans les charges fixes : un four à 1 400 € rangé en charge fixe
-- gonfle le coût de structure du mois et le fait paraître meilleur les mois
-- suivants. Sans ce poste, ces dépenses restaient en « autre » — indistinctes
-- de celles qui ne sont simplement pas encore classées.
--
-- `flux_financier` : le code la gérait déjà (`FINANCIAL_CATEGORY` dans
-- `lib/accounting.ts`, requête de la page TVA) mais la contrainte la refusait :
-- impossible de marquer une écriture hors exploitation à la main, l'écriture
-- échouait sans que l'interface l'explique. Elle sert aux prélèvements erronés
-- en attente de remboursement, dont le débit **et** le remboursement doivent
-- rester hors du résultat — sinon la dépense gonfle les charges ce mois-ci et
-- le remboursement gonfle le chiffre d'affaires le mois suivant.
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_category_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_category_check
  CHECK (category IN (
    'fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'variable_fournisseur',
    'variable_salaire', 'impot_taxe', 'recette',
    'investissement', 'flux_financier', 'autre'
  ));

-- ── 6. Index utiles ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_category ON bank_transactions(category);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions(status);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_mouvements_cca_date ON mouvements_cca(date);

-- ── 7. Vérification ─────────────────────────────────────────────
SELECT
  'invoices.payment_method'  AS colonne,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'payment_method') AS ok
UNION ALL
SELECT 'bank_transactions.accounting_class',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'bank_transactions' AND column_name = 'accounting_class')
UNION ALL
SELECT 'mouvements_cca (table)',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mouvements_cca')
UNION ALL
-- La contrainte doit accepter « investissement », sinon la catégorisation
-- échoue silencieusement à l'import et la dépense retombe en « autre ».
SELECT 'bank_transactions accepte « investissement »',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'bank_transactions_category_check'
            AND pg_get_constraintdef(oid) LIKE '%investissement%')
UNION ALL
SELECT 'bank_transactions accepte « flux_financier »',
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'bank_transactions_category_check'
            AND pg_get_constraintdef(oid) LIKE '%flux_financier%');
