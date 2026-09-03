import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { tryGetAppUrl } from '@/lib/env';
import { describeOcrEngine } from '@/lib/ai/invoice-ocr';
import { callGemini } from '@/lib/ai/gemini';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Contrôle des variables d'environnement : indique ce qui est configuré
 * sans jamais révéler la moindre valeur secrète.
 */
function checkConfig(engine: { provider: string; model: string }) {
  const required: { variable: string; impact: string }[] = [
    { variable: 'NEXT_PUBLIC_SUPABASE_URL', impact: 'Base de données' },
    { variable: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', impact: 'Base de données' },
    { variable: 'SUPABASE_SERVICE_ROLE_KEY', impact: 'Base de données (serveur)' },
    { variable: 'ANTHROPIC_API_KEY', impact: 'Banque, Fuego, audits' },
    { variable: 'SQUARE_ACCESS_TOKEN', impact: 'Ventes Square' },
    { variable: 'SQUARE_LOCATION_ID', impact: 'Ventes Square' },
    { variable: 'SQUARE_WEBHOOK_SECRET', impact: 'Ventes en temps réel' },
  ];

  // La clé Google n'est indispensable que si l'OCR tourne effectivement
  // sur Gemini : inutile de la réclamer à qui est resté sur Claude.
  if (engine.provider === 'gemini') {
    required.push({ variable: 'GEMINI_API_KEY', impact: 'Scanner IA (OCR des factures)' });
  }

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
    ocr_provider: engine.provider,
    ocr_model: engine.model,
    missing_required: missing,
    missing_optional: optional,
  };
}

/**
 * Diagnostic du scanner (réservé aux utilisateurs connectés) :
 *  - disponibilité du moteur d'OCR actif (ping minimal, mis en cache 5 min)
 *  - existence du bucket de stockage + test d'upload
 *  - compteurs de factures
 */

interface AiHealth {
  status: 'green' | 'orange' | 'red';
  latency_ms: number;
  message: string;
  provider: string;
  model: string;
}

// Cache indexé par moteur : changer de moteur ne doit pas renvoyer le
// statut de l'autre pendant cinq minutes.
const cachedAiStatus = new Map<string, AiHealth & { timestamp: number }>();
const AI_CACHE_MS = 5 * 60 * 1000;

/** Ping Claude : un token de sortie sur le modèle le moins cher. */
async function pingAnthropic(): Promise<void> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Ping' }],
  });
}

/** Ping Gemini : quelques tokens, sans fichier, donc au coût quasi nul. */
async function pingGemini(): Promise<void> {
  await callGemini({ parts: [{ text: 'Ping' }], maxOutputTokens: 8 });
}

async function checkAiHealth(engine: { provider: string; model: string }): Promise<AiHealth> {
  const cached = cachedAiStatus.get(engine.provider);
  if (cached && Date.now() - cached.timestamp < AI_CACHE_MS) {
    const { timestamp, ...rest } = cached;
    return rest;
  }

  const startTime = Date.now();
  const base = { provider: engine.provider, model: engine.model };

  try {
    if (engine.provider === 'gemini') await pingGemini();
    else await pingAnthropic();

    const latency_ms = Date.now() - startTime;
    // Gemini répond plus lentement qu'un ping Haiku : sans ce seuil distinct,
    // un moteur parfaitement sain s'afficherait en permanence « Ralenti ».
    const threshold = engine.provider === 'gemini' ? 4000 : 2000;
    const status: AiHealth['status'] = latency_ms > threshold ? 'orange' : 'green';
    const result = { ...base, status, latency_ms, message: status === 'orange' ? 'Ralenti' : 'En ligne' };
    cachedAiStatus.set(engine.provider, { ...result, timestamp: Date.now() });
    return result;
  } catch (e: any) {
    const latency_ms = Date.now() - startTime;
    let message: string;
    if (e.status === 529 || e.message?.includes('Overloaded')) message = 'Saturé (Erreur 529)';
    else if (e.status === 429 || e.message?.includes('429')) message = 'Quota atteint (Erreur 429)';
    else if (e.message?.includes('GEMINI_API_KEY')) message = 'Clé API absente';
    else if (e.message?.includes('404')) message = 'Modèle introuvable';
    else if (e.message?.includes('401') || e.message?.includes('403')) message = 'Clé API refusée';
    else message = `Erreur (${e.status || 'Inconnue'})`;

    console.error(`[Health] Moteur ${engine.provider} indisponible : ${e.message}`);
    const result = { ...base, status: 'red' as const, latency_ms, message };
    cachedAiStatus.set(engine.provider, { ...result, timestamp: Date.now() });
    return result;
  }
}

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = createServiceRoleClient();
  const results: Record<string, any> = {};

  // OCR_PROVIDER mal orthographié ne doit pas faire tomber le diagnostic :
  // c'est précisément la page où l'on vient chercher la cause de la panne.
  let engine: { provider: string; model: string };
  let engineError: string | null = null;
  try {
    engine = describeOcrEngine();
  } catch (e: any) {
    engine = { provider: 'inconnu', model: 'inconnu' };
    engineError = e.message;
  }

  const config = checkConfig(engine);
  const aiHealth = engineError
    ? { status: 'red' as const, latency_ms: 0, message: engineError, provider: 'inconnu', model: 'inconnu' }
    : await checkAiHealth(engine);

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
