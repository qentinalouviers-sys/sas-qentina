-- ================================================================
-- QENTINA — Frais kilométriques (indemnités + péages)
-- À exécuter dans Supabase → SQL Editor. Idempotent.
-- ================================================================

CREATE TABLE IF NOT EXISTS mileage_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  destination_key text NOT NULL,                    -- 'metro' | 'mozzalat' | 'autre'
  label text NOT NULL,                              -- libellé affiché sur la note de frais
  distance_km numeric NOT NULL CHECK (distance_km > 0),   -- aller-retour
  toll_amount numeric NOT NULL DEFAULT 0 CHECK (toll_amount >= 0),
  driver text NOT NULL CHECK (driver IN ('justine', 'yohan')),
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,  -- facture justificative
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manuel')),
  note text,
  -- Clé d'idempotence : « 2026-08-02|metro ». Garantit UN trajet par jour et
  -- par destination, même si la détection automatique est relancée ou si
  -- plusieurs factures du même fournisseur existent le même jour.
  dedupe_key text,
  -- Mouvement de compte courant d'associé qui a comptabilisé ce trajet.
  -- NULL = pas encore porté au compte courant.
  cca_movement_id uuid REFERENCES mouvements_cca(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Si la table existait déjà sans cette colonne (première version du module)
ALTER TABLE mileage_trips ADD COLUMN IF NOT EXISTS cca_movement_id uuid
  REFERENCES mouvements_cca(id) ON DELETE SET NULL;

-- L'index anti-doublon doit être SIMPLE, surtout pas partiel.
-- La détection insère avec « ON CONFLICT (dedupe_key) DO NOTHING », et
-- PostgreSQL ne sait pas rattacher cette clause à un index partiel : il répond
-- « there is no unique or exclusion constraint matching the ON CONFLICT
-- specification » et la détection échoue en entier.
-- Un index simple convient : les NULL étant distincts entre eux par défaut,
-- les saisies manuelles (dedupe_key à NULL) ne se gênent pas.
DROP INDEX IF EXISTS idx_mileage_trips_dedupe;
CREATE UNIQUE INDEX idx_mileage_trips_dedupe ON mileage_trips(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_mileage_trips_date ON mileage_trips(date);
CREATE INDEX IF NOT EXISTS idx_mileage_trips_driver ON mileage_trips(driver);
CREATE INDEX IF NOT EXISTS idx_mileage_trips_cca ON mileage_trips(cca_movement_id);

ALTER TABLE mileage_trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users full access" ON mileage_trips;
CREATE POLICY "Authenticated users full access" ON mileage_trips
  FOR ALL USING (auth.role() = 'authenticated');

-- ── Vérification ────────────────────────────────────────────────
SELECT
  'mileage_trips (table)' AS objet,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mileage_trips') AS ok
UNION ALL
-- indpred IS NULL vérifie que l'index n'est PAS partiel : c'est la condition
-- pour que la détection automatique fonctionne.
SELECT 'index anti-doublon (non partiel)',
  EXISTS (SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_mileage_trips_dedupe' AND i.indpred IS NULL)
UNION ALL
SELECT 'lien compte courant associé',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mileage_trips' AND column_name = 'cca_movement_id');
