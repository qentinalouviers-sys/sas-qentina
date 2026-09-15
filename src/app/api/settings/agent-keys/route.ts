import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { generateAgentKey, type Scope } from '@/lib/agent/auth';

/**
 * Clés d'accès des agents IA — /api/settings/agent-keys
 *
 * Protégé comme le reste de /api/settings : session utilisateur obligatoire,
 * rôle « comptable » exclu par le proxy.
 *
 * La clé en clair n'apparaît QUE dans la réponse à sa création. Elle n'est pas
 * stockée, donc ni relisible ni récupérable : c'est ce qui fait qu'une fuite de
 * la base ne livre aucune clé utilisable. Perdue, elle se révoque et se recrée.
 */

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = createServiceRoleClient();
  const [{ data: keys, error }, { data: calls }] = await Promise.all([
    supabase.from('agent_keys')
      .select('id, name, key_hint, scopes, created_at, last_used_at, revoked_at')
      .order('created_at', { ascending: false }),
    supabase.from('agent_calls')
      .select('at, key_name, tool, scope, ok, error_code, duration_ms')
      .order('at', { ascending: false })
      .limit(25),
  ]);

  if (error) {
    return NextResponse.json(
      { error: `Lecture impossible : ${error.message}. Si la table n'existe pas, exécute db/migration_agent_api.sql.` },
      { status: 500 },
    );
  }

  return NextResponse.json({ keys: keys ?? [], recentCalls: calls ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const write = body.write === true;

  if (!name) {
    return NextResponse.json({ error: 'Donne un nom à la clé : c\'est ce qui permettra de savoir laquelle révoquer.' }, { status: 400 });
  }

  const { raw, hash, hint } = generateAgentKey();
  const scopes: Scope[] = write ? ['read', 'write'] : ['read'];

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_keys')
    .insert({ name, key_hash: hash, key_hint: hint, scopes, created_by: auth.user.email ?? null })
    .select('id, name, key_hint, scopes, created_at')
    .single();

  if (error) {
    return NextResponse.json({ error: `Création impossible : ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    key: data,
    // Unique occasion de la lire. L'écran doit le dire clairement.
    secret: raw,
    warning: "Cette clé ne sera plus jamais affichée. Copie-la maintenant dans la configuration de ton agent.",
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Identifiant de clé manquant.' }, { status: 400 });

  // On révoque, on ne supprime pas : le journal des appels doit rester lisible
  // et nommer la clé qui les a passés.
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from('agent_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return NextResponse.json({ error: `Révocation impossible : ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true });
}
