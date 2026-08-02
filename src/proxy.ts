import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Proxy Next.js 16 (remplace l'ancien middleware.ts, déprécié).
 * Rôles :
 *  1. Rafraîchir la session Supabase (cookies).
 *  2. Bloquer tout accès non authentifié (redirection pages, 401 JSON pour les API).
 *  3. Restreindre le rôle "comptable" aux pages Finance & Compta.
 */

// Routes accessibles sans authentification.
// Le webhook Square est protégé par sa signature HMAC (voir la route).
const PUBLIC_PATHS = ['/login', '/api/square/webhook'];

// Préfixes autorisés pour le rôle "comptable" (pages + API correspondantes)
const COMPTABLE_PATHS = [
  '/factures',
  '/tva',
  '/banque',
  '/cca',
  '/pnl',
  '/api/invoices',
  '/api/scanner',
  '/api/bank',
  '/_next',
  '/favicon',
];

export async function proxy(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || supabaseUrl === 'your_supabase_url' || !supabaseKey || supabaseKey === 'your_supabase_anon_key') {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublicPath = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const isApiPath = pathname.startsWith('/api/');

  if (!user && !isPublicPath) {
    // Les API répondent en JSON, les pages redirigent vers le login
    if (isApiPath) {
      return NextResponse.json({ error: 'Authentification requise' }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    const role = user.user_metadata?.role;
    url.pathname = role === 'comptable' ? '/factures' : '/';
    return NextResponse.redirect(url);
  }

  // Restriction rôle "comptable" : uniquement Finance & Compta
  if (user && user.user_metadata?.role === 'comptable') {
    const isAllowed = COMPTABLE_PATHS.some(p => pathname.startsWith(p));
    if (!isAllowed) {
      if (isApiPath) {
        return NextResponse.json({ error: 'Accès réservé' }, { status: 403 });
      }
      const url = request.nextUrl.clone();
      url.pathname = '/factures';
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
