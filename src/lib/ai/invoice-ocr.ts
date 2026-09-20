import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { createClaudeMessage, PRIMARY_MODEL } from '@/lib/anthropic';
import { createAnthropicClient, getSetting } from '@/lib/ai/settings';
import { callGemini, getGeminiModel, type GeminiPart } from '@/lib/ai/gemini';
import { extractJson } from '@/lib/ai/json';
import {
  normalizeExtracted, computeTvaRecoverable, toNumber, toText,
  type ExtractedInvoiceData, type OcrControlReading,
} from '@/lib/invoice-normalize';

export type { ExtractedInvoiceData } from '@/lib/invoice-normalize';
export { computeTvaRecoverable } from '@/lib/invoice-normalize';

/**
 * invoice-ocr.ts — OCR de factures (prompt + appel + lecture de contrôle).
 * Un seul point d'entrée, /api/scanner : le résultat est toujours relu — et
 * corrigeable — par un humain avant d'être enregistré (/api/scanner/confirm).
 *
 * Deux moteurs possibles, choisis dans Réglages → Moteurs IA (ou, à défaut,
 * par la variable d'environnement OCR_PROVIDER) :
 *  - « gemini » (Google) — nettement moins cher, c'est le moteur retenu ;
 *  - « anthropic » (Claude) — conservé comme repli immédiat, sans redéploiement
 *    de code, si Gemini se révèle moins fiable sur les tickets.
 * Le prompt est rigoureusement le même dans les deux cas : les résultats
 * restent comparables, et seul le moteur change.
 *
 * ── Ce que l'IA fait, et ce qu'elle ne fait plus ──
 *
 * Elle RECOPIE ce qui est imprimé : totaux, ventilation de TVA par taux,
 * quantité et conditionnement de chaque ligne. Elle ne calcule plus rien :
 * les prix au kilo, les unités standard, la TVA déduite du TTC sont dérivés
 * par `lib/invoice-normalize.ts`, en code, de façon rejouable. Un modèle de
 * langage qui divise 50 € par 25 kg se trompe une fois sur vingt ; un code
 * qui le fait ne se trompe jamais.
 *
 * Elle DIT ce qu'elle n'a pas lu : `null` pour un champ illisible (jamais 0,
 * qui est une valeur), et une liste de champs incertains. L'écran surligne
 * ces champs et exige qu'on les vérifie.
 *
 * ── La lecture de contrôle ──
 *
 * Les cinq champs qui font la comptabilité (fournisseur, date, numéro, HT,
 * TVA, TTC) sont relus par un second appel, court, avec une consigne
 * différente et, quand une clé existe pour l'autre moteur, par l'AUTRE
 * moteur. Deux lectures indépendantes qui s'accordent valent une
 * vérification ; deux lectures qui divergent sont signalées à l'humain avec
 * les deux valeurs. C'est le même principe que la double saisie en compta.
 * Coût : une image relue, une vingtaine de tokens en sortie.
 */

export const INVOICE_OCR_PROMPT = `Tu es un assistant OCR expert pour un restaurant (pizzeria napolitaine, société TEKOTEK / enseigne QENTINA).
Analyse ce document (facture fournisseur, ticket de caisse, bon de livraison, reçu CB).
Retourne UNIQUEMENT un JSON valide, sans markdown, sans texte autour.

RÈGLE ABSOLUE : tu RECOPIES ce qui est imprimé, tu ne CALCULES rien. Pas de division, pas de conversion d'unité, pas de « correction » d'un total qui te semble faux. Si une valeur est illisible ou absente, mets null — jamais 0 (0 est une valeur, null est une absence).

{
  "fournisseur": "string ou null",
  "date": "YYYY-MM-DD ou null",
  "numero_facture": "string ou null",
  "type_document": "facture|ticket_caisse|bon_livraison|recu",
  "nom_entreprise_present": boolean,
  "total_ht": number ou null,
  "total_tva": number ou null,
  "total_ttc": number ou null,
  "tva_ventilation": [
    { "taux": number, "base_ht": number ou null, "montant_tva": number ou null }
  ],
  "compte_comptable": "601|607|606|6061|61|62|63|64|autre",
  "lignes": [
    {
      "designation": "string",
      "quantite_lue": number ou null,
      "conditionnement": "string ou null",
      "prix_unitaire_lu": number ou null,
      "prix_total_ht": number ou null,
      "categorie": "alimentaire|materiel|emballage|boisson|autre"
    }
  ],
  "champs_incertains": ["fournisseur"|"date"|"numero_facture"|"total_ht"|"total_tva"|"total_ttc"|"tva_ventilation"|"lignes"]
}

Totaux :
- total_ht, total_tva, total_ttc : les montants DÉFINITIFS imprimés en pied de document (après remises), pas un sous-total de page.
- tva_ventilation : le tableau de TVA par taux tel qu'imprimé (« Base HT / Taux / Montant TVA »). Taux en pourcentage : 5.5, 10, 20, 2.1 ou 0. Tableau vide [] si le document n'en imprime pas.
- Un ticket ou reçu sans TVA détaillée : total_tva null, tva_ventilation [].

Lignes (une par article, dans l'ordre du document) :
- quantite_lue : le nombre imprimé dans la colonne quantité (colis, pièces, kg…), tel quel.
- conditionnement : ce que contient UNE unité de la colonne quantité, tel qu'imprimé : « 25 kg », « 6 x 1 L », « 12x33cl », « 500 g », « 1 kg ». Si la quantité est déjà en kg ou en litres (vrac), écris « kg » ou « L ». Null si rien n'est indiqué.
- prix_unitaire_lu : le prix unitaire imprimé (par colis, par pièce, par kg… selon la colonne), sans le retraiter.
- prix_total_ht : le montant HT de la ligne, tel qu'imprimé.
- Sur une facture longue, lis TOUTES les lignes : une facture Metro peut en compter plus de cent.

Classification comptable (compte_comptable) :
- 601 : matières premières alimentaires (farine, viande, fromage, légumes, sauce)
- 607 : boissons, café, alcool revendus en l'état
- 606 : fournitures, emballages, nettoyage, petit matériel
- 6061 : énergie (électricité, gaz, eau)
- 61 : loyer, assurances, crédit-bail
- 62 : téléphone, internet, logiciels, commissions de plateforme
- 63 : impôts, URSSAF, taxes
- 64 : salaires, acomptes du personnel

Autres règles :
- Si « METRO » dans le nom → "Métro". Si « EUROCIBUS » ou « MOZZALAT » → "Mozzalat".
- Pas de numéro (ticket simple) → numero_facture null.
- nom_entreprise_present : vrai seulement si « TEKOTEK », « TEKO TEK » ou « QENTINA » figure explicitement comme client (adresse de facturation ou en-tête client).
- champs_incertains : liste chaque champ que tu as lu avec doute (flou, rayé, coupé, plusieurs candidats). Liste vide si tout est net.`;

/**
 * Schéma imposé à Gemini. C'est la traduction stricte du prompt : Google
 * garantit alors le type de chaque champ, la présence des clés et les
 * valeurs des énumérations — on ne « répare » plus un JSON approximatif.
 */
const INVOICE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fournisseur: { type: 'string', nullable: true },
    date: { type: 'string', nullable: true },
    numero_facture: { type: 'string', nullable: true },
    type_document: { type: 'string', enum: ['facture', 'ticket_caisse', 'bon_livraison', 'recu'] },
    nom_entreprise_present: { type: 'boolean' },
    total_ht: { type: 'number', nullable: true },
    total_tva: { type: 'number', nullable: true },
    total_ttc: { type: 'number', nullable: true },
    tva_ventilation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taux: { type: 'number' },
          base_ht: { type: 'number', nullable: true },
          montant_tva: { type: 'number', nullable: true },
        },
        required: ['taux'],
      },
    },
    compte_comptable: { type: 'string', enum: ['601', '607', '606', '6061', '61', '62', '63', '64', 'autre'] },
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          designation: { type: 'string' },
          quantite_lue: { type: 'number', nullable: true },
          conditionnement: { type: 'string', nullable: true },
          prix_unitaire_lu: { type: 'number', nullable: true },
          prix_total_ht: { type: 'number', nullable: true },
          categorie: { type: 'string', enum: ['alimentaire', 'materiel', 'emballage', 'boisson', 'autre'] },
        },
        required: ['designation', 'categorie'],
      },
    },
    champs_incertains: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'fournisseur', 'date', 'numero_facture', 'type_document', 'nom_entreprise_present',
    'total_ht', 'total_tva', 'total_ttc', 'tva_ventilation', 'compte_comptable', 'lignes', 'champs_incertains',
  ],
} as const;

/**
 * Consigne de la lecture de contrôle. Volontairement différente de la
 * consigne principale (autre angle, autre ordre) : deux prompts identiques
 * sur le même modèle reproduisent la même erreur.
 */
const CONTROL_PROMPT = `Tu vérifies la saisie d'une facture. Ne lis QUE l'en-tête et le pied du document.
Retourne UNIQUEMENT ce JSON, sans autre texte :
{ "fournisseur": "string ou null", "date": "YYYY-MM-DD ou null", "numero_facture": "string ou null",
  "total_ht": number ou null, "total_tva": number ou null, "total_ttc": number ou null }
- Recopie les montants DÉFINITIFS (après remises), exactement comme imprimés, sans calcul.
- Une valeur illisible ou absente → null, jamais 0.
- Pour Metro écris "Métro" ; pour Eurocibus ou Mozzalat écris "Mozzalat".`;

const CONTROL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fournisseur: { type: 'string', nullable: true },
    date: { type: 'string', nullable: true },
    numero_facture: { type: 'string', nullable: true },
    total_ht: { type: 'number', nullable: true },
    total_tva: { type: 'number', nullable: true },
    total_ttc: { type: 'number', nullable: true },
  },
  required: ['fournisseur', 'date', 'numero_facture', 'total_ht', 'total_tva', 'total_ttc'],
} as const;

export interface OcrFile {
  fileBase64: string;
  mimeType: string;
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

/** Instruction utilisateur, identique pour les deux moteurs. */
const USER_INSTRUCTION = 'Extrais les données de ces pages faisant partie du même document.';
const CONTROL_INSTRUCTION = 'Relis uniquement l\'en-tête et les totaux de ce document.';

/**
 * Budget de sortie. Une facture Metro peut compter plus de cent lignes : à
 * 4 096 tokens (l'ancienne valeur) la réponse était tronquée, et le parseur la
 * « réparait » en coupant les dernières lignes — la facture entrait alors en
 * base incomplète, faussant le stock et la TVA sans aucun signal.
 */
const MAX_OUTPUT_TOKENS = 32000;
const CONTROL_MAX_TOKENS = 600;

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

async function hasKeyFor(provider: OcrProvider): Promise<boolean> {
  return !!(await getSetting(provider === 'gemini' ? 'gemini_api_key' : 'anthropic_api_key'));
}

/**
 * Moteur de la lecture de contrôle : l'autre moteur si sa clé existe (deux
 * modèles ne font pas les mêmes erreurs), sinon le même avec l'autre consigne.
 * `OCR_CONTROL=off` désactive la seconde lecture — à réserver au cas où le
 * coût ou le quota pose problème ; la divergence de lecture n'est alors plus
 * détectée, et l'écran le dit.
 */
export async function resolveControlProvider(primary: OcrProvider): Promise<OcrProvider | null> {
  if ((process.env.OCR_CONTROL ?? '').trim().toLowerCase() === 'off') return null;
  const other: OcrProvider = primary === 'gemini' ? 'anthropic' : 'gemini';
  return (await hasKeyFor(other)) ? other : primary;
}

interface Call {
  system: string;
  instruction: string;
  maxTokens: number;
  schema: Record<string, unknown>;
}

/** Un appel à Claude, texte brut en retour. */
async function ocrWithClaude(files: OcrFile[], call: Call): Promise<string> {
  const anthropic = await createAnthropicClient();

  const response = await createClaudeMessage(anthropic, {
    system: call.system,
    messages: [{
      role: 'user',
      content: [...files.map(toContentBlock), { type: 'text', text: call.instruction }],
    }],
    max_tokens: call.maxTokens,
  });

  if (response.stop_reason === 'max_tokens') throw new Error(TRUNCATED_MESSAGE);

  const textContent = response.content.find((c) => c.type === 'text');
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

/** Un appel à Gemini, texte brut (JSON garanti par le schéma) en retour. */
async function ocrWithGemini(files: OcrFile[], call: Call): Promise<string> {
  const totalBase64 = files.reduce((sum, f) => sum + f.fileBase64.length, 0);
  if (totalBase64 > GEMINI_INLINE_LIMIT) {
    throw new Error(
      `Document trop volumineux pour être envoyé en une fois `
      + `(${Math.round(totalBase64 / 1024 / 1024)} Mo, limite 13 Mo). `
      + `Scanne-le en deux fois, ou réduis la résolution des photos.`
    );
  }

  const result = await callGemini({
    system: call.system,
    parts: [...files.map(toGeminiPart), { text: call.instruction }],
    maxOutputTokens: call.maxTokens,
    responseJson: true,
    responseSchema: call.schema,
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

async function callProvider(provider: OcrProvider, files: OcrFile[], call: Call): Promise<string> {
  return provider === 'gemini' ? ocrWithGemini(files, call) : ocrWithClaude(files, call);
}

const MAIN_CALL: Call = {
  system: INVOICE_OCR_PROMPT, instruction: USER_INSTRUCTION,
  maxTokens: MAX_OUTPUT_TOKENS, schema: INVOICE_RESPONSE_SCHEMA,
};
const CONTROL_CALL: Call = {
  system: CONTROL_PROMPT, instruction: CONTROL_INSTRUCTION,
  maxTokens: CONTROL_MAX_TOKENS, schema: CONTROL_RESPONSE_SCHEMA,
};

/**
 * Lecture de contrôle. Ne fait jamais échouer le scan : si elle plante
 * (quota, panne), le résultat est null et l'écran signale que la facture n'a
 * été lue qu'une fois.
 */
async function runControlReading(files: OcrFile[], provider: OcrProvider): Promise<OcrControlReading | null> {
  try {
    const raw = extractJson<Record<string, unknown>>(await callProvider(provider, files, CONTROL_CALL));
    return {
      moteur: provider === 'gemini' ? `Gemini (${await getGeminiModel()})` : `Claude (${PRIMARY_MODEL})`,
      fournisseur: toText(raw.fournisseur),
      date: toText(raw.date),
      numero_facture: toText(raw.numero_facture),
      total_ht: toNumber(raw.total_ht),
      total_tva: toNumber(raw.total_tva),
      total_ttc: toNumber(raw.total_ttc),
    };
  } catch (e) {
    console.warn(`[OCR] Lecture de contrôle impossible (${provider}) : ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export interface OcrOutcome {
  extracted: ExtractedInvoiceData;
  /** Réponse brute du moteur principal, conservée pour l'audit. */
  raw: unknown;
  engine: { provider: OcrProvider; model: string };
  /** Moteur de la lecture de contrôle, ou null si elle n'a pas eu lieu. */
  controlEngine: OcrProvider | null;
}

/**
 * Lance l'OCR sur une ou plusieurs pages du même document, avec le moteur
 * configuré, puis la lecture de contrôle. Le résultat a exactement la même
 * forme quel que soit le moteur, et il est déjà normalisé.
 */
export async function runInvoiceOcr(files: OcrFile[]): Promise<OcrOutcome> {
  const provider = await resolveOcrProvider();
  const controlProvider = await resolveControlProvider(provider);

  // Les deux lectures partent en parallèle : la seconde ne coûte pas de temps.
  const [rawText, control] = await Promise.all([
    callProvider(provider, files, MAIN_CALL),
    controlProvider ? runControlReading(files, controlProvider) : Promise.resolve(null),
  ]);

  const raw = extractJson<Record<string, unknown>>(rawText);
  const extracted = normalizeExtracted({ ...raw, controle_lecture: control });
  extracted.tva_recoverable = computeTvaRecoverable(extracted);

  return {
    extracted,
    raw,
    engine: { provider, model: provider === 'gemini' ? await getGeminiModel() : PRIMARY_MODEL },
    controlEngine: control ? controlProvider : null,
  };
}

/** Moteur et modèle actifs, pour l'affichage et le diagnostic. */
export async function describeOcrEngine(): Promise<{ provider: OcrProvider; model: string; control: OcrProvider | null }> {
  const provider = await resolveOcrProvider();
  return {
    provider,
    model: provider === 'gemini' ? await getGeminiModel() : PRIMARY_MODEL,
    control: await resolveControlProvider(provider),
  };
}
