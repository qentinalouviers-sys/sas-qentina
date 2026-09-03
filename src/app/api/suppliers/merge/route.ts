import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';

/**
 * Fusionne deux fiches fournisseur : les factures de la fiche source passent
 * sur la fiche cible, puis la source est supprimée.
 *
 * Nécessaire parce qu'un même fournisseur finit par exister sous deux
 * orthographes (« Métro » / « MÃ©tro », « Metro Cash & Carry »). Tant que les
 * deux fiches coexistent, ses achats sont répartis entre elles et aucun des
 * deux totaux n'est exploitable.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const { source_id, target_id } = await request.json().catch(() => ({}));
  if (!source_id || !target_id || typeof source_id !== 'string' || typeof target_id !== 'string') {
    return NextResponse.json({ error: 'source_id et target_id sont requis' }, { status: 400 });
  }
  if (source_id === target_id) {
    return NextResponse.json({ error: 'Une fiche ne peut pas être fusionnée avec elle-même' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: both, error: readErr } = await supabase
    .from('suppliers')
    .select('id, name')
    .in('id', [source_id, target_id]);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if ((both ?? []).length !== 2) {
    return NextResponse.json({ error: 'Fiche fournisseur introuvable' }, { status: 404 });
  }

  const { data: moved, error: moveErr } = await supabase
    .from('invoices')
    .update({ supplier_id: target_id })
    .eq('supplier_id', source_id)
    .select('id');
  if (moveErr) return NextResponse.json({ error: moveErr.message }, { status: 500 });

  const { error: delErr } = await supabase.from('suppliers').delete().eq('id', source_id);
  if (delErr) {
    // Les factures sont déjà sur la cible : on le dit plutôt que de laisser
    // croire que rien n'a bougé.
    return NextResponse.json(
      { error: `Factures déplacées (${moved?.length ?? 0}) mais fiche source non supprimée : ${delErr.message}` },
      { status: 500 },
    );
  }

  const source = both!.find(s => s.id === source_id)!;
  const target = both!.find(s => s.id === target_id)!;
  console.log(`[Fournisseurs] « ${source.name} » fusionné dans « ${target.name} » (${moved?.length ?? 0} facture(s)) par ${auth.user.email ?? auth.user.id}`);

  return NextResponse.json({ success: true, moved: moved?.length ?? 0, target: target.name });
}
