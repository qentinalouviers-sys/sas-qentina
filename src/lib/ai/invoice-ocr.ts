import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { createClaudeMessage, PRIMARY_MODEL } from '@/lib/anthropic';
import { createAnthropicClient, getSetting } from '@/lib/ai/settings';
import { callGemini, getGeminiModel, type GeminiPart } from '@/lib/ai/gemini';
import { extractJson } from '@/lib/ai/json';

/**
 * invoice-ocr.ts — OCR de factures (prompt + appel + règles TVA).
 * Un seul point d'entrée, /api/scanner : le résultat est toujours relu par
 * un humain avant d'être enregistré (/api/scanner/confirm).
 *
 * Deux moteurs possibles, choisis dans Réglages → Moteurs IA (ou, à défaut,
 * par la variable d'environnement OCR_PROVIDER) :
 *  - « gemini » (Google) — nettement moins cher, c'est le moteur retenu ;
 *  - « anthropic » (Claude) — conservé comme repli immédiat, sans redéploiement
 *    de code, si Gemini se révèle moins fiable sur les tickets.
 * Le prompt est rigoureusement le même dans les deux cas : les résultats
 * restent comparables, et seul le moteur change.
 */

export const INVOICE_OCR_PROMPT = `Tu es un assistant OCR expert pour un restaurant.
Analyse ce document (facture fournisseur, ticket de caisse, bon de livraison, reçu CB).
Retourne UNIQUEMENT un JSON valide, sans markdown, sans texte autour.

{
  "fournisseur": "string",
  "date": "YYYY-MM-DD",
  "numero_facture": "string ou null",
  "total_ht": number,
  "total_ttc": number,
  "tva": number,
  "compte_comptable": "601|607|606|6061|61|62|63|64|autre",
  "type_document": "facture|ticket_caisse|bon_livraison|recu",
  "nom_entreprise_present": boolean,
  "lignes": [
    {
      "designation": "string",
      "quantite": number,
      "unite": "kg|L|unité|g|mL",
      "prix_unitaire_ht": number,
      "prix_total_ht": number,
      "categorie": "alimentaire|materiel|emballage|boisson|autre"
    }
  ]
}

Classification comptable :
- 601 : Matières premières alimentaires (farine, viande, fromage, légumes, sauce)
- 607 : Boissons, café, alcool revendus en l'état
- 606 : Fournitures, emballages, nettoyage, petit matériel
- 6061 : Énergie (électricité, gaz, eau)
- 61 : Loyer, assurances, crédit bail
- 62 : Téléphone, internet, SaaS, commissions plateforme
- 63 : Impôts, URSSAF, taxes
- 64 : Salaires, acomptes personnel

Règles impératives :
- L'unité DOIT être standardisée (kg, L, unité, g, mL). Pour un carton de 25kg de farine : quantite 25, unite "kg".
- Le prix unitaire HT correspond à cette unité standard. Si le carton de 25kg coûte 50€, prix_unitaire_ht = 2.
- Si "METRO" dans le nom → retourner "Métro"
- Si "EUROCIBUS" ou "MOZZALAT" → retourner "Mozzalat"
- Si pas de numéro de facture (ticket simple) → retourner null pour numero_facture
- Si une valeur est illisible → 0 pour les nombres, null pour les textes
- Toujours retourner total_ht et total_ttc même si c'est le même montant (pas de TVA)
- Pour nom_entreprise_present, vérifie si l'une des mentions client "TEKOTEK", "QENTINA" ou "TEKO TEK" apparaît explicitement sur le document (comme client ou dans l'en-tête client).`;

export interface OcrFile {
  fileBase64: string;
  mimeType: string;
}

export interface ExtractedInvoiceData {
  fournisseur: string | null;
  date: string | null;
  numero_facture: string | null;
  total_ht: number;
  total_ttc: number;
  tva?: number;
  compte_comptable?: string;
  type_document?: string;
  nom_entreprise_present?: boolean;
  tva_recoverable?: boolean;
  lignes?: {
    designation: string;
    quantite: number;
    unite: string;
    prix_unitaire_ht: number;
    prix_total_ht: number;
    categorie: string;
  }[];
}

/** Formats d'image acceptés par l'API Claude. */
const ANTHROPIC_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/**
 * Formats acceptés par Gemini. Le HEIC/HEIF des iPhone y passe directement,
 * là où Claude le refuse : les photos prises sans changer les réglages de
 * l'appareil ne sont plus rejetées.
 */
const GEMINI_IMAGE_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
] as const;

/** `image/jpg` n'est pas un type MIME valide : les deux API attendent `image/jpeg`. */
function normalizeMime(mime: string): string {
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function assertSupportedImage(mime: string, accepted: readonly string[], hint: string): void {
  if (accepted.includes(mime)) return;
  throw new Error(
    `Format d'image non pris en charge (${mime}). Utilisez ${hint}. `
    + `Sur iPhone : Réglages → Appareil photo → Formats → « Le plus compatible ».`
  );
}

function toContentBlock(f: OcrFile): ContentBlockParam {
  if (f.mimeType.includes('pdf')) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: f.fileBase64 },
    };
  }

  const mime = normalizeMime(f.mimeType);
  assertSupportedImage(mime, ANTHROPIC_IMAGE_TYPES, 'un PDF, JPG, PNG, GIF ou WEBP');

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mime as typeof ANTHROPIC_IMAGE_TYPES[number],
      data: f.fileBase64,
    },
  };
}

function toGeminiPart(f: OcrFile): GeminiPart {
  const mime = f.mimeType.includes('pdf') ? 'application/pdf' : normalizeMime(f.mimeType);
  if (mime !== 'application/pdf') {
    assertSupportedImage(mime, GEMINI_IMAGE_TYPES, 'un PDF, JPG, PNG, WEBP ou HEIC');
  }
  return { inlineData: { mimeType: mime, data: f.fileBase64 } };
}

/**
 * Règle fiscale française : la TVA n'est récupérable que si le nom de
 * l'entreprise figure sur le document (obligatoire sur facture ;
 * toléré sur ticket de caisse < 150 € TTC).
 */
export function computeTvaRecoverable(extracted: ExtractedInvoiceData): boolean {
  const typeDoc = extracted.type_document || 'facture';
  const isCompanyPresent = !!extracted.nom_entreprise_present;
  const ttc = extracted.total_ttc || 0;

  if (typeDoc === 'ticket_caisse') return !(ttc > 150 && !isCompanyPresent);
  if (typeDoc === 'facture') return isCompanyPresent;
  return true;
}

/** Instruction utilisateur, identique pour les deux moteurs. */
const USER_INSTRUCTION = 'Extrais les données de ces pages faisant partie du même document.';

/**
 * Budget de sortie. Une facture Metro peut compter plus de cent lignes : à
 * 4 096 tokens (l'ancienne valeur) la réponse était tronquée, et le parseur la
 * « réparait » en coupant les dernières lignes — la facture entrait alors en
 * base incomplète, faussant le stock et la TVA sans aucun signal.
 */
const MAX_OUTPUT_TOKENS = 32000;

const TRUNCATED_MESSAGE =
  'Facture trop longue pour être lue en une fois. Scanne-la en deux parties : '
  + 'mieux vaut deux imports que des lignes manquantes sans avertissement.';

export type OcrProvider = 'gemini' | 'anthropic';

/**
 * Moteur d'OCR retenu pour cet appel.
 *
 * Ordre de résolution :
 *  1. le choix enregistré dans Réglages → Moteurs IA, sinon la variable
 *     OCR_PROVIDER (« gemini » ou « anthropic ») ;
 *  2. à défaut, Gemini dès lors qu'une clé Google est disponible ;
 *  3. sinon Claude, comme avant.
 *
 * Cet ordre permet d'installer le code sans rien casser : tant qu'aucune clé
 * Google n'est posée, l'application continue de tourner sur Claude.
 */
export async function resolveOcrProvider(): Promise<OcrProvider> {
  const explicit = (await getSetting('ocr_provider'))?.toLowerCase();
  if (explicit === 'gemini' || explicit === 'anthropic') return explicit;
  if (explicit) {
    throw new Error(
      `Le moteur d'OCR vaut « ${explicit} », valeur inconnue. `
      + 'Les seules valeurs acceptées sont « gemini » et « anthropic ».'
    );
  }
  return (await getSetting('gemini_api_key')) ? 'gemini' : 'anthropic';
}

/** OCR par Claude (Anthropic). */
async function ocrWithClaude(files: OcrFile[]): Promise<string> {
  const anthropic = await createAnthropicClient();

  const response = await createClaudeMessage(anthropic, {
    system: INVOICE_OCR_PROMPT,
    messages: [{
      role: 'user',
      content: [...files.map(toContentBlock), { type: 'text', text: USER_INSTRUCTION }],
    }],
    max_tokens: MAX_OUTPUT_TOKENS,
  });

  if (response.stop_reason === 'max_tokens') throw new Error(TRUNCATED_MESSAGE);

  const textContent = response.content.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Réponse Claude invalide');
  }
  return textContent.text;
}

/**
 * Taille maximale des fichiers envoyés d'un bloc à Gemini.
 *
 * L'API plafonne la requête entière à 20 Mo ; au-delà il faut passer par son
 * service de téléversement, complication inutile ici. On refuse donc en amont,
 * avec un message actionnable, plutôt que de laisser tomber un 400 opaque.
 * La valeur est en caractères base64, soit environ 13,5 Mo de fichiers réels.
 */
const GEMINI_INLINE_LIMIT = 18 * 1024 * 1024;

/** OCR par Gemini (Google). */
async function ocrWithGemini(files: OcrFile[]): Promise<string> {
  const totalBase64 = files.reduce((sum, f) => sum + f.fileBase64.length, 0);
  if (totalBase64 > GEMINI_INLINE_LIMIT) {
    throw new Error(
      `Document trop volumineux pour être envoyé en une fois `
      + `(${Math.round(totalBase64 / 1024 / 1024)} Mo, limite 13 Mo). `
      + `Scanne-le en deux fois, ou réduis la résolution des photos.`
    );
  }

  const result = await callGemini({
    system: INVOICE_OCR_PROMPT,
    parts: [...files.map(toGeminiPart), { text: USER_INSTRUCTION }],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Sortie JSON imposée côté Google : plus de markdown parasite autour de
    // l'objet, donc plus de réparation approximative à faire ici.
    responseJson: true,
  });

  if (result.truncated) throw new Error(TRUNCATED_MESSAGE);

  if (result.usage) {
    console.log(
      `[OCR] Gemini ${result.model} — ${result.usage.input} tokens en entrée, `
      + `${result.usage.output} en sortie.`
    );
  }
  return result.text;
}

/**
 * Lance l'OCR sur une ou plusieurs pages du même document, avec le moteur
 * configuré. Le résultat a exactement la même forme quel que soit le moteur.
 */
export async function runInvoiceOcr(files: OcrFile[]): Promise<ExtractedInvoiceData> {
  const provider = await resolveOcrProvider();
  const raw = provider === 'gemini' ? await ocrWithGemini(files) : await ocrWithClaude(files);

  const extracted = extractJson<ExtractedInvoiceData>(raw);
  extracted.tva_recoverable = computeTvaRecoverable(extracted);
  return extracted;
}

/** Moteur et modèle actifs, pour l'affichage et le diagnostic. */
export async function describeOcrEngine(): Promise<{ provider: OcrProvider; model: string }> {
  const provider = await resolveOcrProvider();
  return {
    provider,
    model: provider === 'gemini' ? await getGeminiModel() : PRIMARY_MODEL,
  };
}
