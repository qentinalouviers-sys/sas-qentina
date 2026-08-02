import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

/**
 * anthropic.ts — Appel Claude avec bascule automatique en cas d'indisponibilité.
 *
 * Choix des modèles :
 *  - Sonnet 5 en principal : vision haute résolution (2576 px contre 1568 px
 *    sur Sonnet 4.6) au même tarif — la lecture des petits caractères sur une
 *    photo de ticket y gagne nettement. Le « raisonnement » est désactivé :
 *    l'OCR de facture n'en a pas besoin et il ferait grimper coût et latence.
 *  - Opus 4.8 en secours (le plus capable), puis Haiku 4.5 (le plus rapide).
 */

export const PRIMARY_MODEL = 'claude-sonnet-5';
export const FALLBACK_OPUS = 'claude-opus-4-8';
export const FALLBACK_HAIKU = 'claude-haiku-4-5';

const MODELS = [PRIMARY_MODEL, FALLBACK_OPUS, FALLBACK_HAIKU];

interface ClaudeOptions {
  messages: MessageCreateParams['messages'];
  system?: string;
  max_tokens?: number;
}

/** Vrai si l'erreur justifie d'essayer le modèle suivant (surcharge, quota, panne). */
function isTransient(e: { status?: number; message?: string }): boolean {
  return e.status === 529 || e.status === 429 || e.status === 500
    || !!e.message?.includes('Overloaded');
}

export async function createClaudeMessage(
  anthropic: Anthropic,
  options: ClaudeOptions
) {
  const maxTokens = options.max_tokens ?? 4096;
  let lastError: unknown = null;

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      // On passe par le streaming même si on attend la réponse complète :
      // au-delà d'environ 16 000 tokens de sortie, une requête classique
      // dépasse le délai HTTP du SDK et échoue sans rien renvoyer. Le
      // streaming supprime ce plafond ; `finalMessage()` rend exactement le
      // même objet qu'un appel non streamé.
      return await anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        system: options.system,
        messages: options.messages,
        // Pas de raisonnement étendu : extraction structurée, pas de déduction.
        thinking: { type: 'disabled' },
      }).finalMessage();
    } catch (e: any) {
      lastError = e;
      console.error(`[Claude] Échec du modèle ${model} — code ${e.status} : ${e.message}`);

      // Erreur client (400, clé invalide…) → inutile d'essayer un autre modèle
      if (i === MODELS.length - 1 || !isTransient(e)) throw e;
      console.warn(`[Claude] Bascule vers le modèle de secours : ${MODELS[i + 1]}`);
    }
  }

  throw lastError;
}
