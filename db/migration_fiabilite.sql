-- ═══════════════════════════════════════════════════════════════════
--  Fiabilité des chiffres : la TVA est LUE sur la facture, et l'OCR
--  laisse une trace de ce qu'il a lu et de ce qu'un humain a corrigé.
--  À exécuter UNE FOIS dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Jusqu'ici la TVA déductible d'une facture était TTC − HT. C'est juste
-- neuf fois sur dix, et faux dès que le TTC contient autre chose que de la
-- TVA : consigne de bouteilles, frais hors champ, arrondi de pied de page.
-- La colonne `tva_amount` reçoit le montant imprimé en pied de facture, et
-- `tva_breakdown` la ventilation par taux — celle que la déclaration reprend
-- ligne à ligne. Le code retombe sur TTC − HT quand `tva_amount` est vide
-- (factures enregistrées avant cette migration) : rien ne change pour elles.
--
-- `ocr_meta` conserve, pour chaque facture : le moteur qui l'a lue, le
-- moteur de la lecture de contrôle, les champs que l'OCR jugeait incertains,
-- et ceux que l'humain a corrigés avant d'enregistrer. C'est ce qui permet
-- de savoir, fournisseur par fournisseur, ce que l'OCR rate — et donc quoi
-- relire avec attention.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tva_amount numeric CHECK (tva_amount IS NULL OR tva_amount >= 0);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tva_breakdown jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ocr_meta jsonb;

COMMENT ON COLUMN invoices.tva_amount IS 'TVA totale imprimée en pied de facture. NULL = non lue (TTC − HT fait foi).';
COMMENT ON COLUMN invoices.tva_breakdown IS 'Ventilation par taux [{taux, base_ht, montant_tva}] telle qu''imprimée.';
COMMENT ON COLUMN invoices.ocr_meta IS 'Moteur OCR, lecture de contrôle, champs incertains et champs corrigés par l''humain.';

-- ── Vérification ────────────────────────────────────────────────────
SELECT
  'invoices.tva_amount' AS colonne,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'tva_amount') AS ok
UNION ALL
SELECT 'invoices.tva_breakdown',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'tva_breakdown')
UNION ALL
SELECT 'invoices.ocr_meta',
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'ocr_meta');
