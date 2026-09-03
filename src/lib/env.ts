/**
 * env.ts — Résolution et validation des variables d'environnement critiques.
 *
 * Objectif : transformer les pannes silencieuses en messages explicites.
 * Sans cela, un NEXT_PUBLIC_APP_URL manquant faisait calculer la signature
 * du webhook Square sur l'URL « undefined/api/square/webhook » : Square
 * recevait un 401 « Invalid signature », ce qui laissait croire à un problème
 * côté Square alors qu'il s'agissait d'une variable oubliée.
 */

export class MissingEnvError extends Error {
  constructor(variable: string, why: string, how: string) {
    super(`Variable d'environnement manquante : ${variable}\n  → ${why}\n  → ${how}`);
    this.name = 'MissingEnvError';
  }
}

/**
 * URL publique de l'application, sans barre oblique finale.
 *
 * Ordre de résolution :
 *  1. NEXT_PUBLIC_APP_URL — la valeur explicite, à privilégier
 *  2. VERCEL_PROJECT_PRODUCTION_URL — domaine de production stable fourni par
 *     Vercel (filet de sécurité si l'on oublie de définir la variable).
 *     On n'utilise PAS VERCEL_URL : elle change à chaque déploiement, donc la
 *     signature du webhook ne correspondrait plus.
 *  3. http://localhost:3000 — en développement uniquement
 *
 * @throws MissingEnvError en production si aucune source n'est disponible.
 */
export function getAppUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) {
    console.warn(
      '[Config] NEXT_PUBLIC_APP_URL absent — repli sur le domaine de production Vercel ' +
      `(${vercelProd}). Définissez NEXT_PUBLIC_APP_URL pour lever toute ambiguïté.`
    );
    return `https://${vercelProd.replace(/\/+$/, '')}`;
  }

  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';

  throw new MissingEnvError(
    'NEXT_PUBLIC_APP_URL',
    "Elle sert à vérifier la signature des webhooks Square.",
    "Ajoutez-la dans Vercel → Settings → Environment Variables (ex. https://qentina-saas.vercel.app), " +
    "avec exactement la même valeur que dans le Square Developer Dashboard."
  );
}

/** Variante non bloquante : renvoie null au lieu de lever une exception. */
export function tryGetAppUrl(): string | null {
  try {
    return getAppUrl();
  } catch {
    return null;
  }
}

/**
 * Récupère une variable obligatoire, avec un message d'erreur exploitable.
 */
export function requireEnv(variable: string, why: string, how: string): string {
  const value = process.env[variable]?.trim();
  if (!value) throw new MissingEnvError(variable, why, how);
  return value;
}
