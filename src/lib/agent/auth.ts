/**
 * auth.ts — Authentifier un agent, et garder la trace de ce qu'il fait.
 *
 * Un agent n'a pas de cookie de session : il porte une clé dans l'en-tête
 * `Authorization: Bearer qk_live_…`. Deux décisions structurent ce fichier :
 *
 *  - **La clé n'est jamais stockée en clair.** On enregistre son SHA-256 et
 *    on cherche par empreinte. Une sauvegarde de base égarée ne livre donc
 *    aucune clé utilisable. Corollaire assumé : l'application ne peut pas la
 *    réafficher. Perdue = révoquée puis recréée.
 *  - **La portée est portée par la clé, pas par la requête.** Un agent peut
 *    demander ce qu'il veut : sans « write » sur SA clé, aucun outil d'écriture
 *    ne s'exécute. C'est le seul endroit où cette décision se prend.
 *
 * Le cookie de session reste accepté : c'est ce qui permet d'essayer un outil
 * depuis l'application, connecté, sans fabriquer de clé.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase/server';

export type Scope = 'read' | 'write';

export interface AgentIdentity {
  kind: 'key' | 'session';
  /** Identifiant de la clé, ou null pour une session humaine. */
  keyId: string | null;
  name: string;
  scopes: Scope[];
}

const KEY_PREFIX = 'qk_live_';

/** Empreinte d'une clé. SHA-256 suffit : une clé aléatoire de 256 bits ne se devine pas. */
export function hashAgentKey(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex');
}

/** Fabrique une clé. La valeur brute n'est montrée qu'une fois, à la création. */
export function generateAgentKey(): { raw: string; hash: string; hint: string } {
  const raw = KEY_PREFIX + randomBytes(32).toString('hex');
  return { raw, hash: hashAgentKey(raw), hint: `${KEY_PREFIX}…${raw.slice(-4)}` };
}

/** La clé portée par la requête, ou null. Accepte « Bearer xxx » et « xxx ». */
export function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('x-api-key');
  if (!header) return null;
  const value = header.replace(/^Bearer\s+/i, '').trim();
  return value.startsWith(KEY_PREFIX) ? value : null;
}

/**
 * Comparaison à temps constant de deux empreintes.
 *
 * La recherche se fait déjà par index sur l'empreinte ; ce contrôle final évite
 * qu'une future implémentation (comparaison en mémoire sur une liste de clés)
 * réintroduise une fuite par le temps de réponse sans que personne ne le voie.
 */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface AuthFailure {
  status: 401 | 403;
  code: string;
  message: string;
}

/**
 * Identifie l'appelant : clé d'agent, à défaut session utilisateur.
 *
 * Les messages d'échec disent quoi faire — un agent bloqué sur « Unauthorized »
 * réessaie en boucle ; sur « crée une clé dans Réglages → Agents IA », il
 * s'arrête et le dit à son utilisateur.
 */
export async function authenticateAgent(
  request: Request
): Promise<{ identity: AgentIdentity; error: null } | { identity: null; error: AuthFailure }> {
  const raw = extractKey(request);

  if (raw) {
    const supabase = createServiceRoleClient();
    const hash = hashAgentKey(raw);
    const { data, error } = await supabase
      .from('agent_keys')
      .select('id, name, key_hash, scopes, revoked_at')
      .eq('key_hash', hash)
      .maybeSingle();

    if (error) {
      return { identity: null, error: { status: 401, code: 'auth_unavailable', message:
        `Vérification de la clé impossible : ${error.message}. Si la table agent_keys n'existe pas, `
        + `exécute db/migration_agent_api.sql dans Supabase.` } };
    }
    if (!data || !sameHash(data.key_hash, hash)) {
      return { identity: null, error: { status: 401, code: 'invalid_key', message:
        "Clé inconnue. Vérifie l'en-tête Authorization, ou crée une clé depuis Réglages → Agents IA." } };
    }
    if (data.revoked_at) {
      return { identity: null, error: { status: 401, code: 'revoked_key', message:
        `Cette clé a été révoquée le ${String(data.revoked_at).slice(0, 10)}. Fais-en créer une nouvelle.` } };
    }

    // Trace d'usage, sans bloquer l'appel si elle échoue.
    void supabase.from('agent_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);

    const scopes = (Array.isArray(data.scopes) ? data.scopes : ['read']).filter(
      (s): s is Scope => s === 'read' || s === 'write'
    );
    return { identity: { kind: 'key', keyId: data.id, name: data.name, scopes }, error: null };
  }

  // Pas de clé : une session humaine fait l'affaire, avec tous les droits —
  // c'est déjà le cas sur chaque écran de l'application.
  try {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      return {
        identity: { kind: 'session', keyId: null, name: data.user.email ?? 'session', scopes: ['read', 'write'] },
        error: null,
      };
    }
  } catch {
    // Pas de contexte de cookies (appel hors navigateur) : on tombe sur le 401.
  }

  return { identity: null, error: { status: 401, code: 'missing_key', message:
    "Authentification requise. Ajoute l'en-tête « Authorization: Bearer qk_live_… » ; "
    + "la clé se crée depuis Réglages → Agents IA." } };
}

/** Vérifie qu'une identité porte la portée nécessaire à un outil. */
export function checkScope(identity: AgentIdentity, needed: Scope): AuthFailure | null {
  if (identity.scopes.includes(needed)) return null;
  return {
    status: 403,
    code: 'insufficient_scope',
    message:
      `Cette clé est en lecture seule : l'outil demandé écrit dans la comptabilité. `
      + `Demande une clé avec la portée « write » depuis Réglages → Agents IA, ou utilise un outil de lecture.`,
  };
}

/**
 * Journalise un appel. N'échoue jamais bruyamment : perdre une ligne de
 * journal ne doit pas faire échouer un appel par ailleurs valide — mais la
 * perte est tracée dans les logs serveur.
 */
export async function logAgentCall(entry: {
  identity: AgentIdentity | null;
  tool: string;
  args: unknown;
  ok: boolean;
  errorCode?: string | null;
  durationMs: number;
  scope?: string | null;
}): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    await supabase.from('agent_calls').insert({
      key_id: entry.identity?.keyId ?? null,
      key_name: entry.identity?.name ?? null,
      tool: entry.tool,
      arguments: (entry.args && typeof entry.args === 'object' ? entry.args : {}) as Record<string, unknown>,
      ok: entry.ok,
      error_code: entry.errorCode ?? null,
      duration_ms: Math.round(entry.durationMs),
      scope: entry.scope ?? null,
    });
  } catch (e) {
    console.error('[Agent] Journal indisponible :', e);
  }
}
