import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { createAnthropicClient, getSettingSource } from '@/lib/ai/settings';
import { callGemini, getGeminiModel } from '@/lib/ai/gemini';
import { FALLBACK_HAIKU } from '@/lib/anthropic';

/**
 * Test d'une clé API, à la demande depuis l'écran Réglages.
 *
 * Le ping est volontairement minuscule (un token de sortie) : le coût est
 * négligeable et l'on sait tout de suite si la clé est bonne, plutôt que de
 * le découvrir au milieu d'un scan de facture.
 */

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const { provider } = await request.json().catch(() => ({ provider: null }));
  if (provider !== 'gemini' && provider !== 'anthropic') {
    return NextResponse.json({ error: 'Moteur inconnu' }, { status: 400 });
  }

  const started = Date.now();

  try {
    if (provider === 'gemini') {
      await callGemini({ parts: [{ text: 'Ping' }], maxOutputTokens: 8 });
      return NextResponse.json({
        success: true,
        provider,
        model: await getGeminiModel(),
        latency_ms: Date.now() - started,
        source: await getSettingSource('gemini_api_key'),
      });
    }

    const anthropic = await createAnthropicClient();
    await anthropic.messages.create({
      model: FALLBACK_HAIKU,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Ping' }],
    });
    return NextResponse.json({
      success: true,
      provider,
      model: FALLBACK_HAIKU,
      latency_ms: Date.now() - started,
      source: await getSettingSource('anthropic_api_key'),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[Réglages IA] Test ${provider} en échec : ${reason}`);
    // 200 volontaire : l'échec du test n'est pas une erreur de la requête,
    // c'est son résultat. Le front l'affiche au lieu de le traiter en panne.
    return NextResponse.json({
      success: false,
      provider,
      latency_ms: Date.now() - started,
      error: reason,
    });
  }
}
