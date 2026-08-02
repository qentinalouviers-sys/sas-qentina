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
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mileage_trips_dedupe
  ON mileage_trips(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mileage_trips_date ON mileage_trips(date);
CREATE INDEX IF NOT EXISTS idx_mileage_trips_driver ON mileage_trips(driver);

ALTER TABLE mileage_trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users full access" ON mileage_trips;
CREATE POLICY "Authenticated users full access" ON mileage_trips
  FOR ALL USING (auth.role() = 'authenticated');

-- ── Vérification ────────────────────────────────────────────────
SELECT
  'mileage_trips (table)' AS objet,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mileage_trips') AS ok
UNION ALL
SELECT 'index anti-doublon',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_mileage_trips_dedupe');
