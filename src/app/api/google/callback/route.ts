import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';

/**
 * Retour du flux OAuth Google : échange le code contre les jetons,
 * puis les stocke dans app_settings (refresh + access token).
 */
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = request.cookies.get('google_oauth_state')?.value;

  if (!code) {
    return NextResponse.json({ error: 'No code provided' }, { status: 400 });
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/google/callback`;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const supabase = createServiceRoleClient();

    if (data.refresh_token) {
      await supabase.from('app_settings').upsert({ key: 'google_refresh_token', value: data.refresh_token });
    }

    const expiry = Date.now() + (data.expires_in * 1000);
    await supabase.from('app_settings').upsert({ key: 'google_access_token', value: JSON.stringify({ token: data.access_token, expiry }) });

    const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/avis?google_auth=success`);
    response.cookies.delete('google_oauth_state');
    return response;
  } catch (error: any) {
    console.error('Google OAuth error:', error);
    return NextResponse.json({ error: 'Erreur OAuth Google' }, { status: 500 });
  }
}
