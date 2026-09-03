import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { buildSnapshot, checkClosure, monthBounds, monthLabel } from '@/lib/closures';

/**
 * Clôture mensuelle.
 *
 *  GET  → état des clôtures (mois, date, auteur, chiffres figés).
 *  POST { action: 'close',  month }          → clôture, après contrôles.
 *  POST { action: 'reopen', month, reason }  → réouverture motivée, journalisée.
 *
 * Le verrou est dans la base (trigger) ; cette route ne fait que poser ou
 * lever la clôture, et refuse de figer un mois dont un chiffre de base est
 * faux (intervention critique ouverte : caisse muette, CA incomplet…).
 */

export const maxDuration = 60;

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from('closures')
    .select('month, closed_at, closed_by, snapshot, reopened_at, reopened_by, reopen_reason')
    .order('month', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    closures: (data ?? []).map(c => ({ ...c, month: String(c.month).slice(0, 7) })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const { action, month, reason } = body as { action?: string; month?: string; reason?: string };
  if (typeof month !== 'string') return NextResponse.json({ error: 'Mois requis (AAAA-MM)' }, { status: 400 });

  let start: string;
  try {
    start = monthBounds(month).start;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const who = auth.user.email ?? auth.user.id;
  const today = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from('closures').select('month, reopened_at').eq('month', start).maybeSingle();
  const isClosed = !!existing && !existing.reopened_at;

  if (action === 'close') {
    if (isClosed) return NextResponse.json({ error: `${monthLabel(month)} est déjà clôturé.` }, { status: 409 });

    const check = await checkClosure(supabase, month, today);
    if (check.notOver) {
      return NextResponse.json({ error: `${monthLabel(month)} n'est pas terminé : on ne clôture qu'un mois écoulé.` }, { status: 422 });
    }
    if (!check.canClose) {
      return NextResponse.json({
        error: `${monthLabel(month)} ne peut pas être clôturé : ${check.blocking.length} point(s) critique(s) à régler d'abord.`,
        blocking: check.blocking,
      }, { status: 422 });
    }

    const snapshot = await buildSnapshot(supabase, month);
    const { error } = await supabase.from('closures').upsert({
      month: start, closed_at: new Date().toISOString(), closed_by: who, snapshot,
      reopened_at: null, reopened_by: null, reopen_reason: null,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await supabase.from('closure_log').insert({ month: start, action: 'close', by: who, snapshot });

    return NextResponse.json({ success: true, month, snapshot });
  }

  if (action === 'reopen') {
    if (!isClosed) return NextResponse.json({ error: `${monthLabel(month)} n'est pas clôturé.` }, { status: 409 });
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 10) {
      return NextResponse.json({ error: 'Un motif de réouverture est obligatoire (10 caractères au moins) : il sera conservé dans le journal.' }, { status: 400 });
    }

    const { error } = await supabase.from('closures')
      .update({ reopened_at: new Date().toISOString(), reopened_by: who, reopen_reason: why })
      .eq('month', start);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await supabase.from('closure_log').insert({ month: start, action: 'reopen', by: who, reason: why });

    return NextResponse.json({ success: true, month });
  }

  return NextResponse.json({ error: 'Action inconnue (close | reopen)' }, { status: 400 });
}
