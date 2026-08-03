import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { createClaudeMessage } from '@/lib/anthropic';
import { extractJson } from '@/lib/ai/json';
import {
  parseBankCsv, distinctCategoryKeys, categoryFromRules, type ParsedBankRow,
} from '@/lib/bank-csv';

const CATEGORIES = [
  'fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'variable_fournisseur',
  'variable_salaire', 'impot_taxe', 'recette', 'autre',
] as const;

const CATEGORY_PROMPT = `Tu catégorises des libellés d'opérations bancaires pour un restaurant.

On te donne une liste de libellés. Renvoie UNIQUEMENT un JSON de la forme :
{ "categories": { "LIBELLÉ EXACT": "categorie", ... } }

Catégories autorisées : ${CATEGORIES.join(' | ')}

Règles :
- fixe_loyer : loyers, charges locatives
- fixe_assurance : assurances
- fixe_abonnement : internet, téléphone, électricité, eau, gaz, logiciels, télésurveillance
- variable_fournisseur : achats de marchandises (Metro, Mozzalat, Eurocibus, grossistes,
  supermarchés, boucheries, primeurs)
- variable_salaire : salaires, acomptes
- impot_taxe : URSSAF, impôts, TVA, cotisations
- recette : encaissements Square, Stripe, UberEats, Deliveroo, remises de chèques
- autre : virements personnels, frais bancaires, retraits

Reprends les libellés EXACTEMENT tels qu'ils te sont donnés, sans les reformuler.`;

/**
 * Catégorise les libellés distincts d'un relevé.
 *
 * En cas d'échec on ne fait pas échouer l'import : les montants et les dates
 * sont déjà exacts, et une catégorie se corrige en deux clics dans l'écran
 * Banque — perdre le relevé entier serait bien plus coûteux.
 */
async function categorizeLabels(
  anthropic: Anthropic,
  labels: string[]
): Promise<Record<string, string> | null> {
  if (labels.length === 0) return {};
  try {
    const response = await createClaudeMessage(anthropic, {
      system: CATEGORY_PROMPT,
      messages: [{ role: 'user', content: `Libellés à catégoriser :\n${labels.join('\n')}` }],
      max_tokens: 8000,
    });
    if (response.stop_reason === 'max_tokens') return null;

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') return null;

    const parsed = extractJson<{ categories?: Record<string, string> }>(textContent.text);
    return parsed?.categories ?? null;
  } catch (e) {
    console.error('Catégorisation des libellés impossible:', e);
    return null;
  }
}

/**
 * Applique les catégories aux lignes lues.
 *
 * Ordre de priorité : règle locale, puis réponse de l'IA, puis repli sur le
 * sens du montant. Les règles passent devant parce qu'elles sont sûres et
 * gratuites ; l'IA ne tranche que ce qu'elles ne reconnaissent pas.
 */
function toTransactions(rows: ParsedBankRow[], categories: Record<string, string> | null) {
  const allowed = new Set<string>(CATEGORIES);
  return rows.map(r => {
    const byRule = categoryFromRules(r.categoryKey, r.amount);
    const byAi = categories?.[r.categoryKey];
    const category = byRule
      ?? (byAi && allowed.has(byAi) ? byAi : null)
      ?? (r.amount > 0 ? 'recette' : 'autre');
    return { date: r.date, description: r.description, amount: r.amount, category };
  });
}

const SYSTEM_PROMPT = `Tu es un assistant d'analyse bancaire pour un restaurant.
Analyse ce PDF de relevé de compte et extrait chaque ligne de transaction de manière très structurée.
Retourne UNIQUEMENT un JSON valide, sans texte avant ni après, sans markdown.

Format attendu :
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "Libellé de l'opération",
      "amount": number, // Négatif pour une dépense, positif pour une recette
      "category": "fixe_loyer|fixe_assurance|fixe_abonnement|variable_fournisseur|variable_salaire|impot_taxe|recette|autre"
    }
  ]
}

Règles de catégorisation :
- fixe_loyer : loyers, charges locatives
- fixe_assurance : assurances responsabilité civile, locaux
- fixe_abonnement : abonnements internet, téléphone, électricité, eau, gaz, logiciels (Qentina, etc)
- variable_fournisseur : prélèvements ou virements fournisseurs (Metro, Mozzalat, viandes, boissons...)
- variable_salaire : virements de salaires, acomptes
- impot_taxe : URSSAF, impôts, TVA
- recette : remises de chèques, virements Square/Stripe/UberEats/Deliveroo
- autre : virements personnels, frais bancaires, retraits DAB, etc.

IMPORTANT : Le JSON doit être parfaitement conforme à la norme RFC 8259.
1. Ne mets JAMAIS de guillemets doubles internes sans les échapper. Remplace-les par des guillemets simples.
2. N'ajoute AUCUN caractère spécial ou texte en dehors de la structure JSON.
3. Assure-toi que toutes les clés et valeurs textuelles sont entourées de guillemets doubles.`;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a description string to a canonical form for deduplication.
 * Trims whitespace, collapses multiple spaces, and lowercases.
 */
function normalizeDescription(desc: string): string {
  return (desc || '')
    .trim()
    .replace(/\s+/g, ' ')        // collapse multiple spaces (incl. non-breaking)
    .replace(/\u00a0/g, ' ')     // replace non-breaking spaces
    .toLowerCase();
}

/**
 * Round an amount to 2 decimal places to avoid floating-point drift
 * when comparing amounts extracted by the AI.
 */
function normalizeAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Build the deduplication key for a transaction.
 */
function dedupeKey(date: string, description: string, amount: number): string {
  return `${date}|${normalizeDescription(description)}|${normalizeAmount(amount)}`;
}

/**
 * Determine the initial status of a transaction based on its category and amount.
 */
function deriveStatus(t: { amount: number; category: string }): string {
  if (t.amount > 0) return 'reconciled';
  if (
    t.category === 'variable_fournisseur' ||
    t.category.startsWith('fixe_') ||
    t.category === 'impot_taxe'
  ) {
    return 'pending_invoice';
  }
  return 'ignored';
}

// ─── JSON Repair ────────────────────────────────────────────────────────────

/**
 * Pré-traitement spécifique aux relevés bancaires : les libellés contiennent
 * parfois des guillemets non échappés qui cassent le JSON. On les remplace
 * avant de passer au parseur robuste partagé (extractJson).
 */
function parseBankJson(jsonText: string): any {
  const cleaned = jsonText.replace(
    /"description":\s*"([\s\S]*?)"\s*(?=,\s*"(?:amount|category|date)"|\s*\})/g,
    (_match, desc) => `"description": "${desc.replace(/(?<!\\)"/g, "'")}"`
  );
  return extractJson(cleaned);
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { pdfBase64, csvText } = await request.json();
    if (!pdfBase64 && !csvText) {
      return NextResponse.json({ error: 'PDF ou CSV requis' }, { status: 400 });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── Voie rapide : CSV lu directement ───────────────────────────────────
    // Un export bancaire est déjà structuré. Le lire nous-mêmes rend les dates
    // et les montants exacts par construction, écarte les lignes de solde
    // d'ouverture et de clôture (qui entreraient sinon comme des opérations
    // fantômes), et supprime toute limite de taille. L'IA ne sert plus qu'à
    // catégoriser les libellés distincts — 64 appels de contexte au lieu de 177
    // lignes à retranscrire. Si le format n'est pas reconnu, on retombe sur
    // l'extraction par IA plus bas.
    let csvExtracted: { transactions: any[] } | null = null;
    let csvDegraded = false;
    if (csvText) {
      const { rows, skipped } = parseBankCsv(csvText);
      if (rows.length > 0) {
        // Les règles locales couvrent la majorité des libellés sans rien
        // coûter ; on ne soumet à l'IA que ceux qu'elles ne reconnaissent pas.
        // Un libellé n'est « inconnu » que si AUCUNE de ses lignes n'est
        // reconnue : une règle à montant peut n'en couvrir qu'une partie.
        const unknown = distinctCategoryKeys(rows).filter(
          k => !rows.some(r => r.categoryKey === k && categoryFromRules(k, r.amount))
        );
        const categories = await categorizeLabels(anthropic, unknown);
        csvDegraded = categories === null && unknown.length > 0;
        csvExtracted = { transactions: toTransactions(rows, categories) };
        console.info(
          `Bank CSV lu directement : ${rows.length} opérations, ${skipped} ligne(s) de solde `
          + `écartée(s), ${unknown.length} libellé(s) soumis à l'IA`
        );
      }
    }

    let contentBlock: any[] = [];
    if (pdfBase64) {
      contentBlock = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64,
          },
        },
        {
          type: 'text',
          text: 'Extrais toutes les transactions de ce relevé bancaire PDF au format JSON.',
        },
      ];
    } else if (csvText) {
      contentBlock = [
        {
          type: 'text',
          text: `Voici un export CSV de mon relevé de compte. Extrais toutes les transactions au format JSON demandé.\n\n${csvText}`,
        },
      ];
    }

    let extracted: any;

    if (csvExtracted) {
      extracted = csvExtracted;
    } else {
      // Voie IA : PDF, ou CSV dont le format n'a pas été reconnu.
      const response = await createClaudeMessage(anthropic, {
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contentBlock }],
        // Un relevé mensuel produit facilement plus de 4 096 tokens de JSON :
        // c'est l'ancienne valeur, et elle tronquait la réponse en silence.
        max_tokens: 32000,
      });

      // Réponse coupée par la limite de tokens. Le parseur sait « réparer » un
      // JSON tronqué en le refermant au dernier objet complet — sur un relevé
      // bancaire, ça importerait un relevé incomplet sans le dire. On refuse.
      if (response.stop_reason === 'max_tokens') {
        console.error('Bank extract: réponse tronquée (max_tokens atteint)');
        return NextResponse.json(
          {
            error:
              'Le relevé est trop long pour être traité en une fois. Découpe-le par mois '
              + 'et importe les fichiers un par un — mieux vaut refuser que d’importer '
              + 'un relevé incomplet sans le signaler.',
          },
          { status: 422 }
        );
      }

      const textContent = response.content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return NextResponse.json({ error: 'Réponse Claude invalide' }, { status: 500 });
      }

      try {
        extracted = parseBankJson(textContent.text);
      } catch {
        console.error('Failed to parse Claude JSON response. Raw text:', textContent.text);
        return NextResponse.json(
          { error: 'JSON non parsable après tentative de réparation' },
          { status: 500 }
        );
      }
    }

    if (!extracted.transactions || !Array.isArray(extracted.transactions)) {
      return NextResponse.json({ error: 'Format invalide, "transactions" manquant' }, { status: 400 });
    }

    // ── STEP 1 : Normalize the full batch from the AI ──────────────────────
    // Build a multi-set: key → { normalized transaction, count in this batch }
    const batchMap = new Map<string, { tx: any; count: number }>();

    for (const raw of extracted.transactions) {
      const date: string = raw.date;
      const description = normalizeDescription(raw.description);
      const amount = normalizeAmount(Number(raw.amount));
      const category: string = raw.category || 'autre';

      if (!date || isNaN(amount)) {
        console.warn('Skipping invalid transaction:', raw);
        continue;
      }

      const key = dedupeKey(date, description, amount);
      const existing = batchMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        batchMap.set(key, {
          tx: { date, description, amount, category, status: deriveStatus({ amount, category }) },
          count: 1,
        });
      }
    }

    if (batchMap.size === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    // ── STEP 2 : Query existing counts from DB in a single request ─────────
    // Build a list of OR conditions for every unique (date, amount) pair
    // then filter in-memory on the normalized description.
    // This minimises round-trips to Supabase.
    const supabase = createServiceRoleClient();

    // Collect all unique dates present in the batch for a bounded DB query
    const uniqueDates = [...new Set([...batchMap.values()].map(v => v.tx.date))];

    const { data: existing, error: fetchError } = await supabase
      .from('bank_transactions')
      .select('date, description, amount')
      .in('date', uniqueDates);

    if (fetchError) {
      console.error('Error fetching existing transactions:', fetchError);
      return NextResponse.json({ error: 'Erreur vérification doublons' }, { status: 500 });
    }

    // Build a count map of what is already in the DB
    const dbCountMap = new Map<string, number>();
    for (const row of existing || []) {
      const key = dedupeKey(row.date, row.description, Number(row.amount));
      dbCountMap.set(key, (dbCountMap.get(key) || 0) + 1);
    }

    // ── STEP 3 : Build insert list (only genuine new transactions) ─────────
    const toInsertRows: any[] = [];
    for (const [key, { tx, count }] of batchMap) {
      const alreadyInDb = dbCountMap.get(key) || 0;
      const missing = count - alreadyInDb;
      for (let i = 0; i < missing; i++) {
        toInsertRows.push({ ...tx });
      }
    }

    if (toInsertRows.length === 0) {
      return NextResponse.json({
        success: true,
        count: 0,
        message: 'Aucune nouvelle transaction (relevé déjà importé ou doublons éliminés)',
      });
    }

    // Les montants sont exacts même quand la catégorisation a échoué : on
    // importe, mais on le dit, pour que les catégories soient revues.
    const degradedNote = csvDegraded
      ? 'Montants et dates exacts, et les libellés courants ont été catégorisés par règles. '
        + 'Les libellés inhabituels n’ont pas pu l’être (IA indisponible) : ils sont en '
        + '« autre », à revoir dans la liste.'
      : undefined;

    // ── STEP 4 : insertion par lots ────────────────────────────────────────
    // Surtout pas de `onConflict` ici : l'index anti-doublon porte sur une
    // EXPRESSION (description normalisée), et PostgreSQL ne sait pas rattacher
    // « ON CONFLICT (date, description, amount) » à un index d'expression.
    // L'insertion groupée échouait donc systématiquement et repartait ligne à
    // ligne — 177 allers-retours pour un relevé de deux mois, assez lent pour
    // que la fonction soit coupée en cours de route et que la moitié du relevé
    // manque, sans le moindre message.
    //
    // Un INSERT simple n'a besoin d'aucune inférence : il fonctionne avec cet
    // index. Les doublons connus ont déjà été retirés à l'étape 3 ; il ne reste
    // que le cas rare de deux imports simultanés, où le lot fautif est repris
    // ligne à ligne.
    const CHUNK = 50;
    let insertedCount = 0;

    for (let i = 0; i < toInsertRows.length; i += CHUNK) {
      const chunk = toInsertRows.slice(i, i + CHUNK);
      const { error: chunkError } = await supabase.from('bank_transactions').insert(chunk);

      if (!chunkError) {
        insertedCount += chunk.length;
        continue;
      }

      // Un seul doublon fait échouer tout le lot : on le rejoue ligne à ligne
      // pour n'écarter que la ligne fautive — au plus CHUNK requêtes, pas 177.
      console.warn(`Lot ${i / CHUNK + 1} refusé, reprise ligne à ligne :`, chunkError.message);
      for (const row of chunk) {
        const { error: rowErr } = await supabase.from('bank_transactions').insert(row);
        if (!rowErr) insertedCount++;
        else if (rowErr.code !== '23505') {
          // 23505 = doublon, attendu et sans conséquence
          console.error('Ligne refusée (hors doublon) :', rowErr);
        }
      }
    }

    // Si des lignes ont été perdues en route, on le dit plutôt que d'annoncer
    // un import complet : c'est exactement ce qui a masqué un demi-relevé.
    const manquantes = toInsertRows.length - insertedCount;
    const note = manquantes > 0
      ? `${insertedCount} opérations importées sur ${toInsertRows.length} : `
        + `${manquantes} ont été refusées. Relance l'import pour les rattraper.`
      : degradedNote;

    return NextResponse.json({ success: true, count: insertedCount, message: note });

  } catch (error: any) {
    console.error('Bank extract error:', error);
    // On renvoie la cause réelle : un « Erreur extraction banque » nu ne laisse
    // que le code 500 à l'écran et fait chercher la panne au mauvais endroit.
    const detail = error?.error?.error?.message || error?.message || 'erreur inconnue';
    return NextResponse.json(
      { error: `Erreur extraction banque : ${detail}` },
      { status: error?.status === 429 ? 429 : 500 }
    );
  }
}
