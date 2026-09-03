-- ═══════════════════════════════════════════════════════════════════
--  Clôture mensuelle : un mois clôturé devient lecture seule
--  À exécuter UNE FOIS dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Un outil comptable verrouille le passé. Jusqu'ici rien n'empêchait de
-- recatégoriser une écriture de mars en septembre : le P&L de mars changeait
-- en silence, et le chiffre transmis au cabinet n'était plus celui affiché.
--
-- Une fois un mois clôturé (depuis le P&L, après contrôle des interventions
-- critiques), toute écriture datée de ce mois est refusée sur les tables qui
-- font le résultat : factures et leurs lignes, mouvements bancaires, compte
-- courant d'associé, trajets. Quel que soit le chemin : écran, route API,
-- éditeur SQL. La correction passe par une réouverture explicite et motivée,
-- journalisée — ou par une écriture datée du mois courant.
--
-- Les ventes Square ne sont PAS verrouillées : elles arrivent par synchro et
-- webhook, et refuser une commande tardive la perdrait en silence. Le
-- snapshot pris à la clôture permet de détecter qu'un mois clôturé a bougé.

CREATE TABLE IF NOT EXISTS closures (
  -- Premier jour du mois clôturé.
  month          date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  closed_at      timestamptz NOT NULL DEFAULT now(),
  closed_by      text,
  -- Chiffres du mois au moment de la clôture (CA, achats, coût matières, TVA…).
  snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Renseignés à la réouverture ; le mois redevient modifiable.
  reopened_at    timestamptz,
  reopened_by    text,
  reopen_reason  text
);

-- Journal : chaque clôture et chaque réouverture, avec qui, quand, pourquoi.
CREATE TABLE IF NOT EXISTS closure_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month     date NOT NULL,
  action    text NOT NULL CHECK (action IN ('close', 'reopen')),
  at        timestamptz NOT NULL DEFAULT now(),
  by        text,
  reason    text,
  snapshot  jsonb
);

-- Lecture ouverte aux utilisateurs connectés (les écrans affichent l'état) ;
-- aucune policy d'écriture : seule la route API (service_role) clôture ou
-- rouvre, après contrôles.
ALTER TABLE closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users read" ON closures;
CREATE POLICY "Authenticated users read" ON closures FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE closure_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users read" ON closure_log;
CREATE POLICY "Authenticated users read" ON closure_log FOR SELECT USING (auth.role() = 'authenticated');

-- ── Le verrou ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mois_est_clos(p_date date)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM closures
    WHERE month = date_trunc('month', p_date)::date
      AND reopened_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION refuser_si_mois_clos(p_date date, p_table text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_date IS NOT NULL AND mois_est_clos(p_date) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'Le mois de %s est clôturé : aucune écriture ne peut y être ajoutée, modifiée ou supprimée (%s). '
        'Pour corriger, rouvre le mois depuis le P&L en indiquant le motif, ou date l''écriture du mois courant.',
        to_char(p_date, 'TMMonth YYYY'), p_table);
  END IF;
END
$$;

-- Tables datées directement.
CREATE OR REPLACE FUNCTION trg_cloture_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM refuser_si_mois_clos(NEW.date, TG_TABLE_NAME); END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM refuser_si_mois_clos(OLD.date, TG_TABLE_NAME); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- Lignes de facture : datées par leur facture.
CREATE OR REPLACE FUNCTION trg_cloture_invoice_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d date;
BEGIN
  SELECT date INTO d FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  PERFORM refuser_si_mois_clos(d, 'invoice_lines');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_cloture ON invoices;
CREATE TRIGGER trg_cloture BEFORE INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION trg_cloture_date();

DROP TRIGGER IF EXISTS trg_cloture ON bank_transactions;
CREATE TRIGGER trg_cloture BEFORE INSERT OR UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_cloture_date();

DROP TRIGGER IF EXISTS trg_cloture ON mouvements_cca;
CREATE TRIGGER trg_cloture BEFORE INSERT OR UPDATE OR DELETE ON mouvements_cca
  FOR EACH ROW EXECUTE FUNCTION trg_cloture_date();

DROP TRIGGER IF EXISTS trg_cloture ON mileage_trips;
CREATE TRIGGER trg_cloture BEFORE INSERT OR UPDATE OR DELETE ON mileage_trips
  FOR EACH ROW EXECUTE FUNCTION trg_cloture_date();

DROP TRIGGER IF EXISTS trg_cloture ON invoice_lines;
CREATE TRIGGER trg_cloture BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION trg_cloture_invoice_line();

-- ── Vérification ────────────────────────────────────────────────────
SELECT 'closures (table)' AS controle,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'closures') AS ok
UNION ALL
SELECT 'verrou sur invoices', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cloture' AND tgrelid = 'invoices'::regclass)
UNION ALL
SELECT 'verrou sur bank_transactions', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cloture' AND tgrelid = 'bank_transactions'::regclass)
UNION ALL
SELECT 'verrou sur mouvements_cca', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cloture' AND tgrelid = 'mouvements_cca'::regclass)
UNION ALL
SELECT 'verrou sur invoice_lines', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cloture' AND tgrelid = 'invoice_lines'::regclass);
