-- ═══════════════════════════════════════════════════════════════════
--  API agents IA : clés d'accès et journal des appels
--  À exécuter dans Supabase → SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════
--
-- L'application n'était utilisable que par un humain muni d'un cookie de
-- session. Un agent (Hermes Agent, Claude, un script) n'a pas de cookie : il
-- lui faut une clé qu'il porte dans l'en-tête Authorization.
--
-- Deux principes :
--
--  1. La clé N'EST PAS stockée. Seule son empreinte SHA-256 l'est. Une fuite
--     de la base ne donne donc aucune clé utilisable, et c'est pour ça que
--     l'application ne peut pas la réafficher après création : perdue, elle
--     se révoque et se recrée.
--  2. Tout appel est journalisé. Un agent qui touche à la comptabilité doit
--     laisser une trace lisible : quel outil, quels arguments, quel résultat.
--     Sans ce journal, « l'agent a fait quelque chose » n'est pas vérifiable.

CREATE TABLE IF NOT EXISTS agent_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- À quoi sert cette clé : « Hermes Agent — poste cuisine ».
  name        text NOT NULL,
  -- SHA-256 hexadécimal de la clé. Jamais la clé elle-même.
  key_hash    text NOT NULL UNIQUE,
  -- « qk_live_…a3f9 » : assez pour reconnaître laquelle, trop peu pour s'en servir.
  key_hint    text NOT NULL,
  -- 'read' seul, ou 'read' + 'write'. Une clé sans 'write' ne peut appeler
  -- aucun outil d'écriture, quelle que soit la demande de l'agent.
  scopes      text[] NOT NULL DEFAULT ARRAY['read'],
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  last_used_at timestamptz,
  -- Révocation : on ne supprime pas, pour que le journal reste lisible.
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(key_hash);

CREATE TABLE IF NOT EXISTS agent_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  key_id      uuid REFERENCES agent_keys(id) ON DELETE SET NULL,
  key_name    text,
  tool        text NOT NULL,
  -- Les arguments tels que reçus. Ils ne contiennent ni secret ni pièce
  -- jointe : des dates, des identifiants, des montants.
  arguments   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok          boolean NOT NULL,
  error_code  text,
  duration_ms integer,
  -- 'read' ou 'write' : retrouver d'un coup d'œil ce qui a modifié la base.
  scope       text
);

CREATE INDEX IF NOT EXISTS idx_agent_calls_at ON agent_calls(at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_calls_tool ON agent_calls(tool);
CREATE INDEX IF NOT EXISTS idx_agent_calls_scope ON agent_calls(scope);

ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_calls ENABLE ROW LEVEL SECURITY;

-- Les écrans (utilisateur connecté) gèrent les clés et lisent le journal.
-- Les routes d'API, elles, passent par la clé service_role qui ignore le RLS :
-- c'est volontaire, la vérification de la clé d'agent doit fonctionner sans
-- session utilisateur.
DROP POLICY IF EXISTS "Authenticated users full access" ON agent_keys;
CREATE POLICY "Authenticated users full access" ON agent_keys
  FOR ALL USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users full access" ON agent_calls;
CREATE POLICY "Authenticated users full access" ON agent_calls
  FOR ALL USING (auth.role() = 'authenticated');

-- ── Vérification ────────────────────────────────────────────────────
SELECT 'agent_keys (table)' AS controle,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_keys') AS ok
UNION ALL
SELECT 'agent_calls (journal)',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_calls')
UNION ALL
SELECT 'aucune clé en clair en base',
  NOT EXISTS (SELECT 1 FROM agent_keys WHERE key_hash LIKE 'qk_%');

-- ── Les 20 derniers appels d'agent ──────────────────────────────────
SELECT at, key_name, tool, scope, ok, error_code, duration_ms
FROM agent_calls ORDER BY at DESC LIMIT 20;
