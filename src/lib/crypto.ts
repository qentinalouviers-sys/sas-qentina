import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * crypto.ts — Chiffrement des secrets stockés en base (clés API).
 *
 * Pourquoi chiffrer alors que la table est déjà verrouillée par RLS :
 * ce sont deux protections différentes. Le RLS protège l'accès par l'API
 * Supabase ; le chiffrement protège le contenu si la base elle-même fuite
 * (sauvegarde égarée, accès au tableau de bord Supabase, clé service_role
 * compromise). Sans lui, une seule de ces trois portes suffit à faire
 * facturer nos comptes IA par un tiers.
 *
 * AES-256-GCM : chiffre et authentifie à la fois. Une valeur modifiée en base
 * est rejetée au déchiffrement au lieu de produire des octets faux.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, taille recommandée pour GCM
const PREFIX = 'v1';

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      "Variable d'environnement manquante : SETTINGS_ENCRYPTION_KEY\n"
      + "  → Sans elle, impossible de chiffrer ou de relire les clés API enregistrées.\n"
      + '  → Générez-la une fois avec « openssl rand -hex 32 », ajoutez-la dans '
      + 'Vercel → Settings → Environment Variables, et ne la changez plus : '
      + 'la modifier rend illisibles toutes les clés déjà enregistrées.'
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Clé maître, dérivée de SETTINGS_ENCRYPTION_KEY.
 *
 * Le format attendu est 64 caractères hexadécimaux (32 octets). Toute autre
 * valeur est acceptée mais passée au travers d'un SHA-256 : une phrase de
 * passe trop courte donne alors une clé de bonne longueur plutôt qu'un plantage
 * au premier enregistrement.
 */
function getMasterKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) throw new MissingEncryptionKeyError();

  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

/** Vrai si le chiffrement est utilisable, sans lever d'exception. */
export function isEncryptionConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/** Chiffre une valeur. Résultat : « v1:iv:tag:données », en base64. */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

/** Déchiffre une valeur produite par encryptSecret. */
export function decryptSecret(payload: string): string {
  const key = getMasterKey();
  const parts = payload.split(':');

  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Secret illisible : format inattendu en base.');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Cas de loin le plus fréquent : SETTINGS_ENCRYPTION_KEY a changé.
    throw new Error(
      'Secret illisible : la clé enregistrée ne correspond pas à '
      + 'SETTINGS_ENCRYPTION_KEY. Si cette variable a été modifiée, il faut '
      + 'ressaisir les clés API dans Réglages → Moteurs IA.'
    );
  }
}

/**
 * Empreinte affichable d'une clé : les quatre derniers caractères.
 * Assez pour reconnaître laquelle est en place, trop peu pour la reconstituer.
 */
export function keyHint(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}
