import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';
import { startOfMonth, endOfMonth, format } from 'date-fns';

export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages requis' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    
    // 1. Gather real-time data context for Fuego
    const now = new Date();
    const startStr = format(startOfMonth(now), 'yyyy-MM-dd');
    const endStr = format(endOfMonth(now), 'yyyy-MM-dd');

    // Fetch Sales
    const { data: orders } = await supabase
      .from('square_orders')
      .select('net_amount, service')
      .gte('service', startStr)
      .lte('service', endStr)
      .gt('net_amount', 0); // Exclude 0 amount

    const caTotal = orders?.reduce((sum, o) => sum + (o.net_amount || 0), 0) || 0;
    const nbCommandes = orders?.length || 0;
    const ticketMoyen = nbCommandes > 0 ? caTotal / nbCommandes : 0;

    // Fetch Invoices (Food)
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, total_ht')
      .gte('date', startStr)
      .lte('date', endStr);
      
    const invoiceIds = invoices?.map(i => i.id) || [];
    let achatsAlim = 0;
    if (invoiceIds.length > 0) {
      const { data: lines } = await supabase
        .from('invoice_lines')
        .select('total_ht')
        .in('invoice_id', invoiceIds)
        .eq('category', 'alimentaire');
      achatsAlim = lines?.reduce((sum, l) => sum + (l.total_ht || 0), 0) || 0;
    }
    const foodCost = caTotal > 0 ? (achatsAlim / caTotal) * 100 : 0;

    // Fetch Labor
    const { data: timecards } = await supabase
      .from('labor_timecards')
      .select('hours_worked, hourly_rate')
      .gte('start_at', startOfMonth(now).toISOString())
      .lte('start_at', endOfMonth(now).toISOString());
      
    const totalLaborCost = timecards?.reduce((sum, t) => sum + (t.hours_worked || 0) * (t.hourly_rate || 0), 0) || 0;
    const totalHours = timecards?.reduce((sum, t) => sum + (t.hours_worked || 0), 0) || 0;
    const ratioSalariale = caTotal > 0 ? (totalLaborCost / caTotal) * 100 : 0;
    const productiviteHoraire = totalHours > 0 ? caTotal / totalHours : 0;

    // Fetch custom Fuego context
    const { data: setting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'fuego_context')
      .single();
    
    const customContext = setting?.value ? `\nVoici également le contexte spécifique de mon restaurant :\n${setting.value}\n` : '';

    const dataContext = `
Données actuelles du restaurant (Mois en cours) :
- Chiffre d'Affaires : ${caTotal.toFixed(2)} €
- Nombre de commandes : ${nbCommandes}
- Ticket Moyen : ${ticketMoyen.toFixed(2)} €
- Achats Alimentaires (HT) : ${achatsAlim.toFixed(2)} €
- Food Cost : ${foodCost.toFixed(2)} % (Cible idéale : 28-32%)
- Masse Salariale : ${totalLaborCost.toFixed(2)} € (${ratioSalariale.toFixed(2)} % du CA)
- Productivité Horaire : ${productiviteHoraire.toFixed(2)} € générés par heure travaillée
${customContext}`;

    const systemPrompt = `Tu t'appelles Fuego (🔥). Tu es l'assistant virtuel intelligent du logiciel QENTINA, dédié au pilotage de restaurants (spécialisé pour une pizzeria napolitaine).
Tu t'adresses au gérant de manière professionnelle, proactive mais chaleureuse (tu peux utiliser le tutoiement). 
Ton rôle est de l'aider à analyser ses performances, répondre à ses questions sur la gestion, et lui donner des conseils pour optimiser sa rentabilité.

Voici les données EN TEMPS RÉEL de son restaurant pour le mois en cours, que tu dois utiliser pour lui répondre avec précision :
${dataContext}

Règles importantes :
- Ne mentionne jamais explicitement que tu viens de lire ces données sous forme de contexte injecté. Agis comme si tu avais accès nativement au système.
- Sois concis. Va à l'essentiel.
- Si le Food Cost dépasse 32%, tire la sonnette d'alarme et propose des solutions (contrôle des portions, augmentation des prix, pertes).
- Termine souvent par une question d'ouverture pour l'aider à creuser.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    
    const response = await createClaudeMessage(anthropic, {
      system: systemPrompt,
      messages: messages,
      max_tokens: 1500,
    });

    const textContent = response.content.find(c => c.type === 'text');
    return NextResponse.json({ reply: textContent?.type === 'text' ? textContent.text : 'Désolé, je n\'ai pas pu formuler de réponse.' });

  } catch (error) {
    console.error('Fuego error:', error);
    return NextResponse.json({ error: 'Erreur lors de la communication avec Fuego' }, { status: 500 });
  }
}
