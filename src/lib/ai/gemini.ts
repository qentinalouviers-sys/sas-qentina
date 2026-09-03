/**
 * gemini.ts — Appel de l'API Google Gemini en REST, sans SDK.
 *
 * Pourquoi pas de SDK : l'unique besoin est un POST JSON avec des fichiers en
 * base64. Ajouter `@google/genai` ferait grossir le bundle et introduirait une
 * dépendance à surveiller pour une trentaine de lignes de `fetch`.
 *
 * Le modèle est réglable par variable d'environnement (GEMINI_MODEL) : en
 * changer ne demande alors qu'un redéploiement, pas une modification de code.
 */

import { getSetting } from '@/lib/ai/settings';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Modèle par défaut : le « Flash » de la génération 2.5 — vision correcte sur
 * les tickets et tarif très inférieur aux modèles haut de gamme. C'est le bon
 * compromis pour de l'extraction structurée, qui ne demande aucune déduction.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Nombre de tentatives en cas d'erreur passagère (quota, surcharge). */
const MAX_ATTEMPTS = 3;

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface GeminiOptions {
  /** Consigne système (le prompt OCR). */
  system?: string;
  /** Contenu du message utilisateur : fichiers + instruction. */
  parts: GeminiPart[];
  maxOutputTokens?: number;
  /** Force une sortie JSON stricte côté serveur Google. */
  responseJson?: boolean;
}

export interface GeminiResult {
  text: string;
  /** Vrai si la réponse a été coupée faute de tokens de sortie. */
  truncated: boolean;
  model: string;
  usage: { input: number; output: number } | null;
}

export async function getGeminiModel(): Promise<string> {
  return (await getSetting('gemini_model')) || DEFAULT_GEMINI_MODEL;
}

/** Vrai si l'erreur justifie une nouvelle tentative (quota, surcharge, panne). */
function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Traduit une erreur HTTP de l'API en message exploitable depuis l'interface.
 * Sans cela, l'utilisateur voit « Erreur OCR » sans savoir si c'est la clé,
 * le quota ou le nom du modèle qui est en cause.
 */
function describeError(status: number, body: string, model: string): string {
  const detail = body.slice(0, 300);
  switch (status) {
    case 400:
      return `Requête refusée par Gemini (400). Souvent : fichier trop lourd, format non accepté, `
        + `ou GEMINI_THINKING_BUDGET incompatible avec le modèle « ${model} ». Détail : ${detail}`;
    case 401:
    case 403:
      return `Clé API Google refusée (${status}). Vérifiez GEMINI_API_KEY et que l'API `
        + `« Generative Language » est activée sur le projet Google Cloud. Détail : ${detail}`;
    case 404:
      return `Modèle « ${model} » introuvable (404). Listez les modèles réellement disponibles `
        + `pour votre clé : curl -H "x-goog-api-key: VOTRE_CLE" `
        + `"${GEMINI_ENDPOINT}" — puis ajustez GEMINI_MODEL.`;
    case 429:
      return `Quota Gemini atteint (429). Le palier gratuit est limité par minute et par jour ; `
        + `activez la facturation ou réessayez plus tard. Détail : ${detail}`;
    default:
      return `Erreur Gemini ${status} : ${detail}`;
  }
}

/**
 * Un appel `generateContent`, avec réessais espacés sur les erreurs passagères.
 * Renvoie le texte brut : le découpage JSON reste à la charge de l'appelant.
 */
export async function callGemini(options: GeminiOptions): Promise<GeminiResult> {
  const apiKey = await getSetting('gemini_api_key');
  if (!apiKey) {
    throw new Error(
      'Aucune clé API Google Gemini configurée.\n'
      + "  → Sans elle, l'OCR par Gemini ne peut pas fonctionner.\n"
      + '  → Créez la clé sur https://aistudio.google.com/apikey puis collez-la dans '
      + 'Réglages → Moteurs IA (ou définissez GEMINI_API_KEY dans Vercel). '
      + 'Pour revenir à Claude en attendant, choisissez ce moteur dans le même écran.'
    );
  }

  const model = await getGeminiModel();

  // Le « raisonnement » de Gemini est facturé comme des tokens de sortie. Une
  // extraction de facture n'en a aucun besoin : on le coupe (budget 0), ce qui
  // est précisément le levier d'économie recherché. Certains modèles haut de
  // gamme refusent 0 ; la variable permet alors de remonter le budget.
  const thinkingBudget = Number(process.env.GEMINI_THINKING_BUDGET ?? '0');

  const body = {
    ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
    contents: [{ role: 'user', parts: options.parts }],
    generationConfig: {
      // Température 0 : on veut la même facture lue deux fois de la même façon.
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 32000,
      ...(options.responseJson ? { responseMimeType: 'application/json' } : {}),
      ...(Number.isFinite(thinkingBudget) ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          // La clé passe par un en-tête, jamais dans l'URL : une URL se
          // retrouve dans les journaux de la plateforme, pas un en-tête.
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      lastError = new Error(`Contact impossible avec l'API Gemini : ${reason}`);
      console.error(`[Gemini] Échec réseau (tentative ${attempt}/${MAX_ATTEMPTS}) : ${reason}`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(describeError(response.status, text, model));
      console.error(`[Gemini] ${model} — code ${response.status} (tentative ${attempt}/${MAX_ATTEMPTS})`);

      // Erreur définitive (clé, modèle, requête) : réessayer ne changerait rien.
      if (!isTransient(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }

    const data = await response.json();

    // Réponse bloquée en amont (filtres de sécurité) : aucun candidat renvoyé.
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Document refusé par les filtres de Gemini (${blockReason}).`);
    }

    const candidate = data?.candidates?.[0];
    const finishReason: string | undefined = candidate?.finishReason;

    const text: string = (candidate?.content?.parts ?? [])
      .map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');

    if (!text) {
      throw new Error(
        `Réponse Gemini vide (finishReason: ${finishReason || 'inconnu'}). `
        + (finishReason === 'MAX_TOKENS'
          ? 'Tout le budget de sortie est parti dans le raisonnement : mettez GEMINI_THINKING_BUDGET=0.'
          : 'Le document est peut-être illisible ou vide.')
      );
    }

    const usage = data?.usageMetadata
      ? {
          input: data.usageMetadata.promptTokenCount ?? 0,
          output: data.usageMetadata.candidatesTokenCount ?? 0,
        }
      : null;

    return { text, truncated: finishReason === 'MAX_TOKENS', model, usage };
  }

  throw lastError ?? new Error('Appel Gemini impossible');
}
