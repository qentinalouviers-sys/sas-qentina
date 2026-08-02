import Anthropic from '@anthropic-ai/sdk';
import { createClaudeMessage } from '@/lib/anthropic';
import { extractJson } from '@/lib/ai/json';

/**
 * invoice-ocr.ts — OCR de factures par Claude (prompt + appel + règles TVA).
 * Utilisé par /api/scanner ET /api/invoices/extract : un seul prompt,
 * une seule logique, des résultats identiques quel que soit le point d'entrée.
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

function toContentBlock(f: OcrFile) {
  return f.mimeType.includes('pdf')
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: f.fileBase64 } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: f.mimeType, data: f.fileBase64 } };
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

/** Lance l'OCR Claude sur une ou plusieurs pages du même document. */
export async function runInvoiceOcr(files: OcrFile[]): Promise<ExtractedInvoiceData> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await createClaudeMessage(anthropic, {
    system: INVOICE_OCR_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...files.map(toContentBlock),
        { type: 'text', text: 'Extrais les données de ces pages faisant partie du même document.' },
      ],
    }],
    max_tokens: 4096,
  });

  const textContent = response.content.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Réponse Claude invalide');
  }

  const extracted = extractJson<ExtractedInvoiceData>(textContent.text);
  extracted.tva_recoverable = computeTvaRecoverable(extracted);
  return extracted;
}
