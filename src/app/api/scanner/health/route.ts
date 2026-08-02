import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { tryGetAppUrl } from '@/lib/env';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Contrôle des variables d'environnement : indique ce qui est configuré
 * sans jamais révéler la moindre valeur secrète.
 */
function checkConfig() {
  const required: { variable: string; impact: string }[] = [
    { variable: 'NEXT_PUBLIC_SUPABASE_URL', impact: 'Base de données' },
    { variable: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', impact: 'Base de données' },
    { variable: 'SUPABASE_SERVICE_ROLE_KEY', impact: 'Base de données (serveur)' },
    { variable: 'ANTHROPIC_API_KEY', impact: 'Scanner IA & Fuego' },
    { variable: 'SQUARE_ACCESS_TOKEN', impact: 'Ventes Square' },
    { variable: 'SQUARE_LOCATION_ID', impact: 'Ventes Square' },
    { variable: 'SQUARE_WEBHOOK_SECRET', impact: 'Ventes en temps réel' },
  ];

  const missing = required.filter(r => !process.env[r.variable]?.trim());

  const appUrl = tryGetAppUrl();
  if (!appUrl) {
    missing.push({
      variable: 'NEXT_PUBLIC_APP_URL',
      impact: 'Webhook Square rejeté + connexion Google impossible',
    });
  }

  // Variables optionnelles (les avis Google fonctionnent sans)
  const optional = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACE_ID']
    .filter(key => !process.env[key]?.trim());

  return {
    ok: missing.length === 0,
    app_url: appUrl,
    missing_required: missing,
    missing_optional: optional,
  };
}

/**
 * Diagnostic du scanner (réservé aux utilisateurs connectés) :
 *  - disponibilité de l'API Claude (ping 1 token, mis en cache 5 min)
 *  - existence du bucket de stockage + test d'upload
 *  - compteurs de factures
 */

let cachedAiStatus: { status: 'green' | 'orange' | 'red'; latency_ms: number; message: string; timestamp: number } | null = null;
const AI_CACHE_MS = 5 * 60 * 1000;

async function checkAnthropicHealth(): Promise<{ status: 'green' | 'orange' | 'red'; latency_ms: number; message: string }> {
  if (cachedAiStatus && (Date.now() - cachedAiStatus.timestamp < AI_CACHE_MS)) {
    const { status, latency_ms, message } = cachedAiStatus;
    return { status, latency_ms, message };
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const startTime = Date.now();

  try {
    // Ping le moins cher possible : Haiku, 1 token de sortie
    await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Ping' }],
    });
    const latency_ms = Date.now() - startTime;
    const status = latency_ms > 2000 ? 'orange' : 'green';
    const message = status === 'orange' ? 'Ralenti' : 'En ligne';
    cachedAiStatus = { status, latency_ms, message, timestamp: Date.now() };
    return { status, latency_ms, message };
  } catch (e: any) {
    const latency_ms = Date.now() - startTime;
    let message = 'Hors ligne';
    if (e.status === 529 || e.message?.includes('Overloaded')) message = 'Saturé (Erreur 529)';
    else if (e.status === 429) message = 'Limite de débit atteinte (Erreur 429)';
    else message = `Erreur (${e.status || 'Inconnue'})`;

    cachedAiStatus = { status: 'red', latency_ms, message, timestamp: Date.now() };
    return { status: 'red', latency_ms, message };
  }
}

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = createServiceRoleClient();
  const results: Record<string, any> = {};

  const config = checkConfig();
  const aiHealth = await checkAnthropicHealth();

  // Bucket de stockage
  const { data: buckets, error: bucketsErr } = await supabase.storage.listBuckets();
  results.bucket_invoice_files_exists = buckets?.some(b => b.name === 'invoice-files') ?? false;
  if (bucketsErr) results.buckets_error = bucketsErr.message;

  // Test d'upload (PNG 1×1 transparent)
  const testPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const testPath = `invoices/test/health_check_${Date.now()}.png`;

  const { error: uploadErr } = await supabase.storage
    .from('invoice-files')
    .upload(testPath, testPng, { contentType: 'image/png', upsert: true });

  if (uploadErr) {
    results.upload_test = 'FAIL';
    results.upload_error = uploadErr.message;
  } else {
    results.upload_test = 'OK';
    await supabase.storage.from('invoice-files').remove([testPath]);
  }

  // Compteurs factures
  const { count: withFile } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .not('pdf_url', 'is', null);
  results.invoices_with_file = withFile ?? 0;

  const { count: total } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true });
  results.invoices_total = total ?? 0;

  const allOk = results.bucket_invoice_files_exists && results.upload_test === 'OK';

  return NextResponse.json({
    status: allOk && aiHealth.status !== 'red' && config.ok ? 'OK' : 'PARTIAL',
    config,
    ai: aiHealth,
    ...results,
  });
}
