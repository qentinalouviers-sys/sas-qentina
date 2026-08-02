import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'No code provided' }, { status: 400 });
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
    
    // Store access token with expiry
    const expiry = Date.now() + (data.expires_in * 1000);
    await supabase.from('app_settings').upsert({ key: 'google_access_token', value: JSON.stringify({ token: data.access_token, expiry }) });

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/avis?google_auth=success`);
  } catch (error: any) {
    console.error('Google OAuth error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
