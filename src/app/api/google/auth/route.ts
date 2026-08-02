import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireUser } from '@/lib/supabase/api-auth';

/**
 * Démarre le flux OAuth Google (Business Profile).
 * Un jeton `state` aléatoire est stocké en cookie httpOnly et vérifié
 * au retour dans /api/google/callback (protection CSRF).
 */
export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/google/callback`;
  const scope = 'https://www.googleapis.com/auth/business.manage';
  const state = crypto.randomBytes(24).toString('hex');

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent(scope)}` +
    `&access_type=offline&prompt=consent` +
    `&state=${state}`;

  const response = NextResponse.redirect(authUrl);
  response.cookies.set('google_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/api/google',
  });
  return response;
}
