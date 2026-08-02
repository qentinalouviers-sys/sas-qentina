import { createServiceRoleClient } from '@/lib/supabase/server';

export async function getValidGoogleAccessToken() {
  const supabase = createServiceRoleClient();
  const { data: atData } = await supabase.from('app_settings').select('value').eq('key', 'google_access_token').single();
  const { data: rtData } = await supabase.from('app_settings').select('value').eq('key', 'google_refresh_token').single();

  if (!rtData?.value) return null; // No refresh token, needs auth

  let accessToken = null;
  if (atData?.value) {
    const { token, expiry } = JSON.parse(atData.value);
    if (Date.now() < expiry - 60000) {
      return token; // Token still valid
    }
  }

  // Need to refresh
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: rtData.value,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (data.error) {
    console.error('Failed to refresh google token:', data);
    return null;
  }

  const newExpiry = Date.now() + (data.expires_in * 1000);
  await supabase.from('app_settings').upsert({ key: 'google_access_token', value: JSON.stringify({ token: data.access_token, expiry: newExpiry }) });

  return data.access_token;
}
