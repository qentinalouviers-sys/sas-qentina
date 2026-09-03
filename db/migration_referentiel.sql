-- ═══════════════════════════════════════════════════════════════════
--  Référentiel : correspondances désignation de facture → ingrédient
--  À exécuter UNE FOIS dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Jusqu'ici, chaque ligne de facture non reconnue créait un ingrédient à
-- son nom (« TOMATE PELEE 4/4 x6 CIRIO »), et les prix se mettaient à jour
-- par « le nom contient » — « Tomate » captait « Concentré de tomate ». La
-- mercuriale se polluait toute seule et les coûts des fiches techniques
-- héritaient de prix qui n'étaient pas les leurs.
--
-- Désormais une désignation ne met à jour un prix que si elle correspond
-- EXACTEMENT (accents et casse ignorés) au nom d'un ingrédient, ou à un alias
-- que l'humain a rattaché ici. Tout le reste attend dans Réglages →
-- Ingrédients → « Désignations à rattacher ».

CREATE TABLE IF NOT EXISTS ingredient_aliases (
  -- Désignation normalisée (minuscules, sans accents, espaces réduits).
  alias          text PRIMARY KEY,
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingredient_aliases_ingredient
  ON ingredient_aliases(ingredient_id);

ALTER TABLE ingredient_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users full access" ON ingredient_aliases;
CREATE POLICY "Authenticated users full access" ON ingredient_aliases
  FOR ALL USING (auth.role() = 'authenticated');

-- ── Vérification ────────────────────────────────────────────────────
SELECT 'ingredient_aliases (table)' AS controle,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ingredient_aliases') AS ok;
