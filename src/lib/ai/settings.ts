import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { decryptSecret, encryptSecret, keyHint, isEncryptionConfigured } from '@/lib/crypto';

/**
 * settings.ts — Réglages des moteurs IA : clés API et préférences.
 *
 * Deux sources, dans cet ordre :
 *  1. la table `ai_settings` (saisie depuis Réglages → Moteurs IA) ;
 *  2. les variables d'environnement Vercel.
 *
 * L'ordre compte : la base l'emporte pour qu'une clé changée à l'écran
 * s'applique sans redéploiement, et les variables d'environnement restent en
 * repli pour ne jamais se retrouver enfermé dehors — base indisponible, table
 * vidée par erreur, ou tout premier démarrage.
 *
 * Rien ici ne doit être importé par un composant client : ce module lit des
 * secrets et n'existe que côté serveur.
 */

export const SECRET_KEYS = ['gemini_api_key', 'anthropic_api_key'] as const;
export const PLAIN_KEYS = ['ocr_provider', 'gemini_model'] as const;

export type SecretKey = typeof SECRET_KEYS[number];
export type PlainKey = typeof PLAIN_KEYS[number];
export type SettingKey = SecretKey | PlainKey;

/** Variable d'environnement servant de repli pour chaque réglage. */
const ENV_FALLBACK: Record<SettingKey, string> = {
  gemini_api_key: 'GEMINI_API_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  ocr_provider: 'OCR_PROVIDER',
  gemini_model: 'GEMINI_MODEL',
};

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

export function isSettingKey(key: string): key is SettingKey {
  return isSecretKey(key) || (PLAIN_KEYS as readonly string[]).includes(key);
}

interface StoredRow {
  key: string;
  value: string | null;
  is_secret: boolean;
  hint: string | null;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Cache mémoire des réglages.
 *
 * Sans lui, chaque OCR ferait un aller-retour supplémentaire vers Supabase.
 * La durée est courte : sur Vercel chaque instance a son propre cache, donc
 * une clé modifiée met au plus ce délai à se propager partout. L'instance qui
 * enregistre, elle, vide son cache immédiatement — le bouton « Tester »
 * juste après l'enregistrement travaille bien sur la nouvelle valeur.
 */
const CACHE_MS = 60 * 1000;
let cache: { rows: Map<string, StoredRow>; timestamp: number } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

async function loadRows(): Promise<Map<string, StoredRow>> {
  if (cache && Date.now() - cache.timestamp < CACHE_MS) return cache.rows;

  const rows = new Map<string, StoredRow>();
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from('ai_settings')
      .select('key, value, is_secret, hint, updated_at, updated_by');

    if (error) throw error;
    for (const row of (data ?? []) as StoredRow[]) rows.set(row.key, row);
  } catch (e) {
    // Table absente (migration pas encore jouée) ou base injoignable : on
    // continue sur les variables d'environnement plutôt que de tomber en
    // panne. C'est précisément le rôle du repli.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[Réglages IA] Lecture impossible, repli sur les variables d'environnement : ${reason}`);
  }

  cache = { rows, timestamp: Date.now() };
  return rows;
}

/** Valeur d'un réglage : base d'abord, variable d'environnement ensuite. */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const rows = await loadRows();
  const row = rows.get(key);

  if (row?.value) {
    if (!row.is_secret) return row.value.trim() || null;
    try {
      const clear = decryptSecret(row.value).trim();
      if (clear) return clear;
    } catch (e) {
      // Clé illisible (SETTINGS_ENCRYPTION_KEY modifiée) : on le dit fort et
      // on retombe sur la variable d'environnement, pour que l'application
      // continue de fonctionner pendant qu'on corrige.
      console.error(`[Réglages IA] ${key} : ${e instanceof Error ? e.message : e}`);
    }
  }

  return process.env[ENV_FALLBACK[key]]?.trim() || null;
}

/** D'où vient la valeur effective d'un réglage — pour l'affichage. */
export async function getSettingSource(key: SettingKey): Promise<'base' | 'environnement' | 'absent'> {
  const rows = await loadRows();
  const row = rows.get(key);
  if (row?.value) {
    if (!row.is_secret) return 'base';
    try {
      decryptSecret(row.value);
      return 'base';
    } catch {
      // Illisible : la valeur qui s'applique réellement est celle de l'env.
    }
  }
  return process.env[ENV_FALLBACK[key]]?.trim() ? 'environnement' : 'absent';
}

/** État de tous les réglages, sans jamais renvoyer une valeur secrète. */
export async function describeSettings() {
  const rows = await loadRows();

  const describe = async (key: SettingKey) => {
    const row = rows.get(key);
    const source = await getSettingSource(key);
    return {
      key,
      source,
      configured: source !== 'absent',
      // Pour un secret : uniquement l'empreinte. Pour une préférence, la
      // valeur elle-même, qui n'a rien de confidentiel.
      hint: isSecretKey(key) ? row?.hint ?? null : await getSetting(key),
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  };

  return {
    encryption_ready: isEncryptionConfigured(),
    settings: await Promise.all([...SECRET_KEYS, ...PLAIN_KEYS].map(describe)),
  };
}

/** Enregistre un réglage. Les secrets sont chiffrés avant écriture. */
export async function saveSetting(key: SettingKey, value: string, updatedBy: string): Promise<void> {
  const secret = isSecretKey(key);
  const clean = value.trim();

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from('ai_settings').upsert({
    key,
    value: secret ? encryptSecret(clean) : clean,
    is_secret: secret,
    hint: secret ? keyHint(clean) : null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  });

  if (error) throw new Error(`Enregistrement impossible : ${error.message}`);
  invalidateSettingsCache();
}

/** Supprime un réglage : la variable d'environnement reprend la main. */
export async function deleteSetting(key: SettingKey): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from('ai_settings').delete().eq('key', key);
  if (error) throw new Error(`Suppression impossible : ${error.message}`);
  invalidateSettingsCache();
}

/**
 * Client Anthropic construit avec la clé effective.
 *
 * Toutes les routes doivent passer par ici : instancier le client au niveau
 * du module figerait la clé au chargement, et une clé saisie dans Réglages ne
 * serait jamais prise en compte.
 */
export async function createAnthropicClient(): Promise<Anthropic> {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) {
    throw new Error(
      'Aucune clé API Anthropic configurée.\n'
      + '  → Renseignez-la dans Réglages → Moteurs IA, ou définissez '
      + "ANTHROPIC_API_KEY dans les variables d'environnement."
    );
  }
  return new Anthropic({ apiKey });
}
