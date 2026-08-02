import { createBrowserClient } from '@supabase/ssr';

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Validate before creating client
  if (!url || !key || url === 'your_supabase_url' || key === 'your_supabase_anon_key') {
    // Return a mock client that won't throw
    return createBrowserClient(
      'https://placeholder.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2MjU5MjMyMDAsImV4cCI6MTk0MTQ5OTIwMH0.placeholder'
    );
  }

  _client = createBrowserClient(url, key);
  return _client;
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return !!(url && key && url !== 'your_supabase_url' && key !== 'your_supabase_anon_key');
}
