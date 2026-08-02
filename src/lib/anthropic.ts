import Anthropic from '@anthropic-ai/sdk';

export const PRIMARY_MODEL = 'claude-sonnet-4-6';
export const FALLBACK_OPUS = 'claude-opus-4-6';
export const FALLBACK_HAIKU = 'claude-haiku-4-5-20251001';

interface ClaudeOptions {
  messages: any[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
}

export async function createClaudeMessage(
  anthropic: Anthropic,
  options: ClaudeOptions
) {
  const maxTokens = options.max_tokens ?? 4096;
  const modelsToTry = [PRIMARY_MODEL, FALLBACK_OPUS, FALLBACK_HAIKU];
  let lastError: any = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    try {
      console.log(`[Claude API] Tentative avec le modèle : ${currentModel}`);
      const response = await anthropic.messages.create({
        ...options,
        model: currentModel,
        max_tokens: maxTokens,
      });
      return response;
    } catch (e: any) {
      lastError = e;
      const isOverloaded = e.status === 529 || (e.message && e.message.includes('Overloaded'));
      const isRateLimit = e.status === 429;
      const isInternalError = e.status === 500;

      console.error(`[Claude API] Échec du modèle ${currentModel}. Code : ${e.status}, Erreur : ${e.message}`);

      if (i < modelsToTry.length - 1 && (isOverloaded || isRateLimit || isInternalError)) {
        console.warn(`[Claude API] Modèle ${currentModel} indisponible. Bascule vers le modèle de secours : ${modelsToTry[i + 1]}`);
        continue;
      }
      throw e; // Lancer l'erreur s'il s'agit d'une erreur client (ex. 400 Bad Request) ou s'il n'y a plus de modèle de secours
    }
  }
  throw lastError;
}
