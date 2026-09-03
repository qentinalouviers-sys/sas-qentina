-- ═══════════════════════════════════════════════════════════════════
--  Compte courant d'associé : refus d'un solde débiteur, au niveau de la base
--  À exécuter UNE FOIS dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Un compte courant d'associé débiteur signifie que la société a prêté de
-- l'argent à son dirigeant : l'article L.225-43 du code de commerce l'interdit
-- et le fait est qualifiable d'abus de biens sociaux. Jusqu'ici la règle
-- n'était tenue que par une boîte de dialogue « enregistrer quand même ? » dans
-- le navigateur — un verrou qu'un clic défait, et que l'API Supabase ignore.
--
-- Le contrôle descend donc dans la base : quel que soit le chemin (écran,
-- route API, éditeur SQL), une opération qui rend un solde débiteur est
-- refusée. La règle est précise :
--
--  - on recalcule le solde courant de l'associé, dans l'ordre chronologique
--    (le même jour, les apports passent avant les remboursements : une journée
--    comptable n'a pas de chronologie interne) ;
--  - on ne regarde que les jours À PARTIR de la date de l'opération. Un creux
--    plus ancien n'est pas la faute de cette opération : elle n'est pas
--    bloquée, et l'historique reste à corriger par ailleurs ;
--  - un apport ajouté ou un remboursement supprimé ne peuvent qu'améliorer le
--    solde : ils passent sans contrôle. Ce sont les gestes de correction.
--
-- Pour une réparation d'historique en bloc dans l'éditeur SQL :
--   BEGIN; SET CONSTRAINTS trg_cca_verrou DEFERRED; ...; COMMIT;

CREATE OR REPLACE FUNCTION cca_verifier_solde(p_associe text, p_depuis date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  solde numeric := 0;
BEGIN
  FOR r IN
    SELECT date, sens, montant
    FROM mouvements_cca
    WHERE associe = p_associe
    ORDER BY date, CASE WHEN sens = 'apport' THEN 0 ELSE 1 END, created_at
  LOOP
    solde := solde + CASE WHEN r.sens = 'apport' THEN r.montant ELSE -r.montant END;
    IF r.date >= p_depuis AND solde < -0.005 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format(
          'Compte courant de %s débiteur de %s € au %s : opération refusée. '
          'Un compte courant débiteur est interdit au dirigeant (art. L.225-43 du code de commerce). '
          'Enregistre d''abord l''apport qui couvre ce montant, ou choisis une date postérieure.',
          initcap(p_associe), round(-solde, 2), to_char(r.date, 'DD/MM/YYYY'));
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION cca_trigger_verrou()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sens = 'remboursement' THEN
      PERFORM cca_verifier_solde(NEW.associe, NEW.date);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.sens = 'apport' THEN
      PERFORM cca_verifier_solde(OLD.associe, OLD.date);
    END IF;
    RETURN OLD;
  ELSE
    PERFORM cca_verifier_solde(NEW.associe, LEAST(OLD.date, NEW.date));
    IF NEW.associe <> OLD.associe THEN
      PERFORM cca_verifier_solde(OLD.associe, OLD.date);
    END IF;
    RETURN NEW;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_cca_verrou ON mouvements_cca;
CREATE CONSTRAINT TRIGGER trg_cca_verrou
  AFTER INSERT OR UPDATE OR DELETE ON mouvements_cca
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION cca_trigger_verrou();

-- ── Vérification ────────────────────────────────────────────────────
-- 1. Le verrou est en place.
SELECT 'trg_cca_verrou (trigger)' AS controle,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cca_verrou') AS ok;

-- 2. État de l'existant : le point le plus bas de chaque compte. Une valeur
--    négative est un creux historique à régulariser (le verrou n'empêche
--    que d'en créer de nouveaux).
WITH courant AS (
  SELECT associe, date,
    SUM(CASE WHEN sens = 'apport' THEN montant ELSE -montant END)
      OVER (PARTITION BY associe
            ORDER BY date, CASE WHEN sens = 'apport' THEN 0 ELSE 1 END, created_at) AS solde
  FROM mouvements_cca
)
SELECT associe, round(min(solde), 2) AS solde_le_plus_bas,
  CASE WHEN min(solde) < 0 THEN 'creux historique à régulariser' ELSE 'jamais débiteur' END AS etat
FROM courant GROUP BY associe;
