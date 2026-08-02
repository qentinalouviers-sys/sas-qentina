-- ========================================================
-- Migration : Module Comptes Courants d'Associés (CCA)
-- ========================================================

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

-- Assurer la présence de la colonne si la table existe déjà
ALTER TABLE mouvements_cca ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE;

-- Activation RLS
ALTER TABLE mouvements_cca ENABLE ROW LEVEL SECURITY;

-- Policy RLS
DROP POLICY IF EXISTS "Authenticated users full access" ON mouvements_cca;
CREATE POLICY "Authenticated users full access" ON mouvements_cca FOR ALL USING (auth.role() = 'authenticated');

