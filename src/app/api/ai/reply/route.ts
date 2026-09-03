import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';
import { requireUser } from '@/lib/supabase/api-auth';
import { createAnthropicClient } from '@/lib/ai/settings';

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { reviewComment, rating, reviewerName } = await request.json();

    const supabase = createServiceRoleClient();
    const { data: s_app } = await supabase.from('app_settings').select('value').eq('key', 'fuego_context').single();
    const context = s_app?.value || "Nous sommes QENTINA, une pizzeria napolitaine.";

    const prompt = `Tu es Fuego 🔥, l'assistant du restaurant QENTINA.
Voici le contexte du restaurant : ${context}

Un client nommé ${reviewerName} a laissé un avis Google de ${rating} étoiles avec le commentaire suivant :
"${reviewComment}"

Rédige une réponse professionnelle, polie et adaptée à cet avis au nom de l'équipe du restaurant.
- Si l'avis est positif, remercie chaleureusement.
- Si l'avis est négatif ou mitigé, montre de l'empathie, excuse-toi pour les désagréments, et propose une solution (ex: revenir pour une meilleure expérience).
- Ne mets pas de guillemets autour de ta réponse finale.
- Reste concis (3-4 phrases max).`;

    const anthropic = await createAnthropicClient();
    const msg = await createClaudeMessage(anthropic, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';

    return NextResponse.json({ reply: text });
  } catch (error: any) {
    console.error('AI Reply error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
