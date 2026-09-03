-- ═══════════════════════════════════════════════════════════════════
--  Réglages des moteurs IA — clés API et préférences
--  À exécuter UNE FOIS dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- Pourquoi une table à part et pas `app_settings` :
-- `app_settings` est ouverte en lecture ET en écriture à tout utilisateur
-- authentifié (la page Réglages y écrit directement depuis le navigateur avec
-- la clé anon). Une clé API n'a rien à y faire — même chiffrée, n'importe quel
-- compte pourrait la lire ou l'écraser.
--
-- Cette table-ci n'a AUCUNE policy : RLS activé sans policy = personne n'y
-- accède. Seule la clé `service_role`, qui contourne le RLS et ne vit que
-- dans les routes API côté serveur, peut la lire ou l'écrire. Une clé API ne
-- transite donc jamais par le navigateur.

CREATE TABLE IF NOT EXISTS ai_settings (
  key         text PRIMARY KEY,
  -- Chiffré en AES-256-GCM quand is_secret vaut true, en clair sinon.
  value       text,
  is_secret   boolean NOT NULL DEFAULT false,
  -- Quatre derniers caractères de la clé, pour la reconnaître à l'écran
  -- sans jamais la révéler.
  hint        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;

-- Filet de sécurité : si une policy permissive avait été créée à la main,
-- on la retire. L'absence de policy est ici le comportement voulu.
DROP POLICY IF EXISTS "Authenticated users full access" ON ai_settings;

-- ── Vérification ────────────────────────────────────────────────────
-- Les deux lignes doivent afficher « true ».
SELECT 'ai_settings (table)' AS controle,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_settings') AS ok
UNION ALL
SELECT 'ai_settings sans policy (verrouillée)',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_settings');
