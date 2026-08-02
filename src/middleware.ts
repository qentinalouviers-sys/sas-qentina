import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // Skip if Supabase is not configured
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || supabaseUrl === 'your_supabase_url' || !supabaseKey || supabaseKey === 'your_supabase_anon_key') {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    supabaseUrl,
    supabaseKey,
    {
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
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Webhook Square: pas de protection auth
  if (request.nextUrl.pathname.startsWith('/api/square/webhook')) {
    return supabaseResponse;
  }

  // Pages publiques
  const publicPaths = ['/login', '/api/square/webhook', '/api/scanner/health'];
  const isPublicPath = publicPaths.some(p => request.nextUrl.pathname.startsWith(p));

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone();
    // Comptables are redirected to /factures after login
    const role = user.user_metadata?.role;
    url.pathname = role === 'comptable' ? '/factures' : '/';
    return NextResponse.redirect(url);
  }

  // ── Restriction Comptable ─────────────────────────────────────────────────
  // Users with role 'comptable' can only access Finance & Compta routes
  if (user) {
    const role = user.user_metadata?.role;
    if (role === 'comptable') {
      const allowedPaths = [
        '/factures',
        '/tva',
        '/banque',
        '/cca',
        '/pnl',
        '/api/invoices',
        '/api/scanner',
        '/api/tva',
        '/api/banque',
        '/api/cca',
        '/api/pnl',
        '/_next',
        '/favicon',
      ];
      const pathname = request.nextUrl.pathname;
      const isAllowed = allowedPaths.some(p => pathname.startsWith(p));
      if (!isAllowed) {
        const url = request.nextUrl.clone();
        url.pathname = '/factures';
        return NextResponse.redirect(url);
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
