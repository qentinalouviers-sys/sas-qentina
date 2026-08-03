import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { categoryFromRules } from '@/lib/bank-csv';

/**
 * Réapplique les règles de catégorisation aux dépenses restées non classées.
 *
 * La table de règles s'enrichit avec le temps — un fournisseur reconnu
 * aujourd'hui ne l'était pas au moment de l'import. Sans cette route, une
 * règle ajoutée ne vaut que pour les relevés à venir, et les mouvements déjà
 * en base restent en « autre » : ils partent alors dans les charges fixes au
 * lieu du coût matières, et faussent le food cost indéfiniment.
 *
 * **Ne touche que les lignes en `autre` ou sans catégorie.** Une catégorie
 * choisie à la main n'est jamais écrasée. Chaque ligne modifiée le reste
 * modifiable dans l'écran Banque.
 *
 * `POST /api/bank/recategorize?dryRun=1` renvoie ce qui changerait, sans rien
 * écrire : la simulation est le mode par défaut du bon sens, on n'écrit qu'à la
 * demande explicite.
 */

export const maxDuration = 60;

interface Proposal {
  id: string;
  date: string;
  description: string;
  amount: number;
  from: string;
  to: string;
}

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1';
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('bank_transactions')
    .select('id, date, description, amount, category')
    .or('category.is.null,category.eq.autre');

  if (error) {
    return NextResponse.json(
      { error: `Lecture des mouvements impossible : ${error.message}` },
      { status: 500 },
    );
  }

  const rows = data || [];
  const proposals: Proposal[] = [];

  for (const t of rows) {
    const next = categoryFromRules(t.description || '');
    if (!next || next === t.category) continue;

    // Une règle « recette » ne doit jamais requalifier un débit, ni
    // l'inverse : le signe du montant est un fait, le libellé une indication.
    // Sur un relevé réel, « REMISE CHQ » apparaît aussi en frais de remise.
    const amount = t.amount || 0;
    if (next === 'recette' && amount < 0) continue;
    if (next !== 'recette' && amount > 0) continue;

    proposals.push({
      id: t.id,
      date: t.date,
      description: t.description,
      amount,
      from: t.category || '(vide)',
      to: next,
    });
  }

  const byCategory: Record<string, { count: number; amount: number }> = {};
  for (const p of proposals) {
    const b = (byCategory[p.to] ||= { count: 0, amount: 0 });
    b.count++;
    b.amount = Math.round((b.amount + Math.abs(p.amount)) * 100) / 100;
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      examined: rows.length,
      proposed: proposals.length,
      byCategory,
      sample: proposals.slice(0, 20),
    });
  }

  // Regroupement par catégorie cible : une requête par catégorie au lieu
  // d'une par ligne. L'import bancaire a déjà montré qu'une centaine de
  // requêtes séquentielles finit coupée en cours de route.
  let updated = 0;
  const failures: string[] = [];

  for (const [category, bucket] of Object.entries(byCategory)) {
    const ids = proposals.filter(p => p.to === category).map(p => p.id);
    const { error: updateError } = await supabase
      .from('bank_transactions')
      .update({ category })
      .in('id', ids);

    if (updateError) {
      failures.push(`${category} : ${updateError.message}`);
      continue;
    }
    updated += bucket.count;
  }

  return NextResponse.json({
    dryRun: false,
    examined: rows.length,
    updated,
    byCategory,
    ...(failures.length ? { failures } : {}),
  });
}
