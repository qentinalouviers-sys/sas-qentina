import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';
import { requireUser } from '@/lib/supabase/api-auth';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const supabase = createServiceRoleClient();

    // Load all ingredients
    const { data: ingredients } = await supabase
      .from('ingredients')
      .select('id, name, unit, last_unit_price')
      .order('name');

    if (!ingredients || ingredients.length === 0) {
      return NextResponse.json({ anomalies: [] });
    }

    // Load recent invoice lines (limited)
    const { data: invoiceLines } = await supabase
      .from('invoice_lines')
      .select('designation, quantity, unit, unit_price_ht')
      .order('created_at', { ascending: false })
      .limit(300);

    // Pair each ingredient with its best matching invoice line (max 2)
    const ingredientContext = ingredients.map(ing => {
      const firstWord = ing.name.toLowerCase().split(' ')[0];
      const matched = (invoiceLines || [])
        .filter(l => l.designation?.toLowerCase().includes(firstWord))
        .slice(0, 2)
        .map(l => ({
          d: l.designation?.substring(0, 60), // truncate long designations
          qty: l.quantity,
          unit: l.unit,
          price: l.unit_price_ht,
        }));
      return {
        id: ing.id,
        n: ing.name,       // short key
        u: ing.unit,
        p: ing.last_unit_price,
        inv: matched,
      };
    });

    // Split into batches of 50 ingredients to avoid token overflow
    const BATCH_SIZE = 50;
    const allAnomalies: any[] = [];

    for (let i = 0; i < ingredientContext.length; i += BATCH_SIZE) {
      const batch = ingredientContext.slice(i, i + BATCH_SIZE);

      const prompt = `Tu es expert en gestion des coûts restauration. Analyse ce batch d'ingrédients d'une pizzeria napolitaine.

Format compact — clés: id=identifiant, n=nom, u=unité, p=prix_unitaire, inv=lignes_factures(d=désignation,qty=quantité,unit=unité,price=prix_ht)

DONNÉES:
${JSON.stringify(batch)}

MISSION: Détecter les incohérences réelles uniquement:
1. Conditionnement: produit acheté en sachet/barquette (nom contient "300G","500G","1KG","BARQUETTE" etc) mais prix saisi comme si c'était le kg — résultat: quantités achetées absurdes (>100kg pour un produit en petits formats)
2. Prix aberrant: prix irréaliste pour le secteur restauration (ex: tomates >50€/kg, farine >10€/kg, fromage <0.5€/kg)
3. Unité incorrecte: liquide en "kg", fromage en "L"
4. Prix manquant: p=null ou p=0 avec des achats en inv

RÈGLES IMPORTANTES:
- Signale UNIQUEMENT des vraies anomalies évidentes, pas des approximations
- Maximum 10 anomalies par batch
- Si aucune anomalie dans ce batch, retourne {"anomalies":[]}

Retourne UNIQUEMENT ce JSON valide, rien d'autre:
{"anomalies":[{"ingredient_id":"<id>","ingredient_name":"<n>","type":"conditionnement|prix_aberrant|unite_incorrecte|prix_manquant","severity":"high|medium|low","current_unit":"<u>","current_price":<p>,"description":"<1 phrase>","suggestion_unit":"<valeur ou null>","suggestion_price":<nombre ou null>,"reason":"<court>"}]}`;

      try {
        const msg = await createClaudeMessage(anthropic, {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2000,
        });

        const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '{"anomalies":[]}';

        // Robust JSON extraction: find the outermost { }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) continue;

        const jsonStr = text.substring(start, end + 1);

        try {
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed.anomalies)) {
            allAnomalies.push(...parsed.anomalies);
          }
        } catch (parseErr) {
          // Try to salvage partial JSON — extract complete anomaly objects
          const salvaged = salvageAnomalies(jsonStr);
          allAnomalies.push(...salvaged);
          console.warn(`Batch ${i / BATCH_SIZE + 1}: JSON parse error, salvaged ${salvaged.length} anomalies`);
        }
      } catch (batchErr) {
        console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, batchErr);
        // Continue with next batch
      }
    }

    // Deduplicate by ingredient_id + type
    const seen = new Set<string>();
    const deduplicated = allAnomalies.filter(a => {
      const key = `${a.ingredient_id}:${a.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by severity
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    deduplicated.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    return NextResponse.json({ anomalies: deduplicated.slice(0, 30) });
  } catch (error: any) {
    console.error('Stock audit error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Salvage complete anomaly objects from a partially valid JSON string
function salvageAnomalies(jsonStr: string): any[] {
  const results: any[] = [];
  // Match individual {...} objects inside the anomalies array
  const objectRegex = /\{[^{}]*"ingredient_id"[^{}]*\}/g;
  const matches = jsonStr.match(objectRegex);
  if (!matches) return [];

  for (const match of matches) {
    try {
      const obj = JSON.parse(match);
      if (obj.ingredient_id && obj.type) {
        results.push(obj);
      }
    } catch {
      // Skip malformed objects
    }
  }
  return results;
}
