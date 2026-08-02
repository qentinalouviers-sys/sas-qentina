import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

/**
 * Garde d'authentification pour les routes API.
 *
 * Le proxy (src/proxy.ts) bloque déjà les requêtes non authentifiées,
 * mais chaque route sensible revérifie ici (défense en profondeur) :
 * un simple oubli dans le matcher du proxy ne doit jamais exposer une route.
 *
 * Usage :
 *   const auth = await requireUser();
 *   if (auth.error) return auth.error;
 *   // auth.user est disponible
 */
export async function requireUser(): Promise<
  { user: User; error: null } | { user: null; error: NextResponse }
> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Authentification requise' }, { status: 401 }),
    };
  }
  return { user: data.user, error: null };
}
