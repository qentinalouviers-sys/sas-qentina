import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';
import { requireUser } from '@/lib/supabase/api-auth';
import { createAnthropicClient } from '@/lib/ai/settings';

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const supabase = createServiceRoleClient();
    const { chartData, topItems, totalCA, totalOrders } = await request.json();

    const { data: s_hours } = await supabase.from('app_settings').select('value').eq('key', 'opening_hours').single();
    const openingHours = s_hours?.value ? JSON.parse(s_hours.value) : null;
    
    let hoursContext = '';
    if (openingHours) {
      hoursContext = `\nVoici les jours d'ouverture officiels du restaurant :\n`;
      ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].forEach(day => {
         const m = openingHours[day]?.Midi;
         const s = openingHours[day]?.Soir;
         if (!m && !s) hoursContext += `- ${day}: FERMÉ\n`;
         else hoursContext += `- ${day}: ${m ? 'Midi ' : ''}${m && s ? '& ' : ''}${s ? 'Soir' : ''}\n`;
      });
      hoursContext += `(Prends impérativement en compte ces fermetures dans ton analyse. Inutile de recommander d'ouvrir un jour fermé sauf si c'est une opportunité évidente, et ne sois pas surpris si le CA est à 0 sur un service fermé).\n`;
    }

    const prompt = `Tu es Fuego 🔥, l'assistant IA expert en restauration et gestion financière du logiciel QENTINA.
Le restaurateur (qui gère une pizzeria napolitaine) te demande d'analyser ses ventes récentes depuis Square.
${hoursContext}
Voici les données agrégées de la période sélectionnée :
- Chiffre d'Affaires total : ${totalCA} €
- Nombre de commandes : ${totalOrders}
- Répartition par jour et service (Midi/Soir) :
${JSON.stringify(chartData, null, 2)}

- Top 10 des produits les plus vendus :
${JSON.stringify(topItems, null, 2)}

Ta mission :
1. Fais une analyse très concise et punchy (3 ou 4 paragraphes max).
2. Dégage la tendance principale en tenant compte de ses jours d'ouverture.
3. Donne 1 ou 2 conseils d'expert actionnables pour optimiser le chiffre d'affaires ou la rentabilité.
4. Utilise un ton pro mais dynamique et encourageant, digne de "Fuego". N'hésite pas à utiliser quelques emojis.`;

    const anthropic = await createAnthropicClient();
    const msg = await createClaudeMessage(anthropic, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';

    return NextResponse.json({ insight: text });
  } catch (error: any) {
    console.error('AI Ventes error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
