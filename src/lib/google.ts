import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * Renvoie un jeton d'accès Google valide, en le rafraîchissant si besoin.
 * Renvoie null si l'application n'a jamais été autorisée (pas de refresh token).
 */
export async function getValidGoogleAccessToken(): Promise<string | null> {
  const supabase = createServiceRoleClient();

  // Une seule requête pour les deux clés (au lieu de deux .single() qui
  // renvoyaient une erreur 406 tant que les réglages n'existaient pas).
  const { data: settings } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['google_access_token', 'google_refresh_token']);

  const refreshToken = settings?.find(s => s.key === 'google_refresh_token')?.value;
  if (!refreshToken) return null; // jamais autorisé → l'utilisateur doit passer par /api/google/auth

  // Jeton en cache encore valide (marge de 60 s) ?
  const cached = settings?.find(s => s.key === 'google_access_token')?.value;
  if (cached) {
    try {
      const { token, expiry } = JSON.parse(cached);
      if (token && Date.now() < expiry - 60_000) return token;
    } catch {
      // cache illisible → on rafraîchit
    }
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error || !data.access_token) {
    console.error('Échec du rafraîchissement du jeton Google:', data.error || 'réponse inattendue');
    return null;
  }

  await supabase.from('app_settings').upsert({
    key: 'google_access_token',
    value: JSON.stringify({ token: data.access_token, expiry: Date.now() + data.expires_in * 1000 }),
    updated_at: new Date().toISOString(),
  });

  return data.access_token;
}
