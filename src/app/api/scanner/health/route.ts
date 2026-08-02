import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';

let cachedAiStatus: { status: 'green' | 'orange' | 'red'; latency_ms: number; message: string; timestamp: number } | null = null;

async function checkAnthropicHealth(): Promise<{ status: 'green' | 'orange' | 'red'; latency_ms: number; message: string }> {
  // If cache is valid (less than 30 seconds old), return it
  if (cachedAiStatus && (Date.now() - cachedAiStatus.timestamp < 30000)) {
    return {
      status: cachedAiStatus.status,
      latency_ms: cachedAiStatus.latency_ms,
      message: cachedAiStatus.message
    };
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const startTime = Date.now();

  // 1. Essai avec le modèle principal (Sonnet)
  try {
    // Fast check (1 token output)
    await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Ping' }]
    });
    const latency_ms = Date.now() - startTime;
    const status = latency_ms > 2000 ? 'orange' : 'green';
    const message = status === 'orange' ? 'Ralenti' : 'En ligne';

    cachedAiStatus = { status, latency_ms, message, timestamp: Date.now() };
    return { status, latency_ms, message };
  } catch (e: any) {
    console.warn("[Health Check] Modèle principal claude-sonnet-4-6 indisponible. Test du modèle de secours (Opus)...");
  }

  // 2. Essai avec le modèle de secours principal (Opus)
  try {
    await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Ping' }]
    });
    const latency_ms = Date.now() - startTime;
    const status = 'orange';
    const message = 'Secours (Opus)';

    cachedAiStatus = { status, latency_ms, message, timestamp: Date.now() };
    return { status, latency_ms, message };
  } catch (e: any) {
    const latency_ms = Date.now() - startTime;
    let message = 'Hors ligne';
    let status: 'green' | 'orange' | 'red' = 'red';

    if (e.status === 529 || (e.message && e.message.includes('Overloaded'))) {
      message = 'Saturé (Erreur 529)';
    } else if (e.status === 429) {
      message = 'Limite de débit atteinte (Erreur 429)';
    } else {
      message = `Erreur (${e.status || 'Inconnue'})`;
    }

    cachedAiStatus = { status, latency_ms, message, timestamp: Date.now() };
    return { status, latency_ms, message };
  }
}

export async function GET() {
  const supabase = createServiceRoleClient();
  const results: Record<string, any> = {};

  // 1. Check Anthropic API status
  const aiHealth = await checkAnthropicHealth();

  // 2. Check bucket exists
  const { data: buckets, error: bucketsErr } = await supabase.storage.listBuckets();
  results.buckets_found = buckets?.map(b => b.name) ?? [];
  results.bucket_invoice_files_exists = buckets?.some(b => b.name === 'invoice-files') ?? false;
  if (bucketsErr) results.buckets_error = bucketsErr.message;

  // 3. Try a test upload (1×1 px transparent PNG)
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
    const { data: { publicUrl } } = supabase.storage
      .from('invoice-files')
      .getPublicUrl(testPath);
    results.public_url = publicUrl;

    // Cleanup test file
    await supabase.storage.from('invoice-files').remove([testPath]);
    results.cleanup = 'done';
  }

  // 4. Check invoices with pdf_url
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
    status: allOk && aiHealth.status !== 'red' ? 'OK' : 'PARTIAL',
    ai: aiHealth,
    ...results,
  });
}
