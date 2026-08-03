import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { syncSquareOrders, SquareApiError } from '@/lib/square-sync';

/**
 * Synchronisation Square automatique — déclenchée chaque nuit par Vercel Cron
 * (voir `vercel.json`).
 *
 * ── Sur la fenêtre de 45 jours ──
 * Le travail de nuit couvre les 45 derniers jours, pas l'année. C'est
 * volontaire : cette fenêtre englobe le mois courant et le précédent en
 * entier — la période qui compte pour une déclaration de TVA — et se termine
 * toujours largement dans le temps imparti. Une synchronisation annuelle chaque
 * nuit serait lente, coûteuse en appels, et risquerait d'être coupée : on
 * retomberait sur le défaut qu'on vient de corriger.
 * Pour remonter plus loin, il y a le rattrapage d'historique dans les Réglages.
 *
 * ── Sur l'authentification ──
 * Cette route écrit en base et appelle l'API Square. Laissée ouverte, n'importe
 * qui pourrait la déclencher en boucle. Vercel ajoute automatiquement l'en-tête
 * `Authorization: Bearer $CRON_SECRET` à ses appels **dès lors que la variable
 * CRON_SECRET est définie**. Si elle ne l'est pas, la route refuse de
 * travailler plutôt que de s'exécuter à découvert.
 */
export const maxDuration = 60;

/** Comparaison à temps constant, pour ne rien révéler par la durée. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error(
      '[cron] CRON_SECRET absent : la synchronisation automatique est désactivée. '
      + 'Ajoute cette variable dans Vercel → Settings → Environments.'
    );
    return NextResponse.json(
      {
        error: 'CRON_SECRET non configuré — synchronisation automatique désactivée '
          + 'pour ne pas exposer une route d\'écriture.',
      },
      { status: 503 }
    );
  }

  const header = request.headers.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !secretMatches(provided, secret)) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const result = await syncSquareOrders({ days: 45, budgetMs: 50_000 });
    const ms = Date.now() - startedAt;

    // Journalisé pour être consultable dans les logs Vercel : c'est la seule
    // trace d'un travail qui tourne sans personne devant l'écran.
    const résumé =
      `[cron] Square : ${result.orders} commandes, ${result.items} articles, `
      + `${result.batches} lot(s), depuis le ${result.since}, en ${ms} ms`;

    if (!result.complete) {
      console.warn(`${résumé} — INCOMPLET, la prochaine nuit reprendra le reste.`);
    } else if (result.zeroAmountOrders > 0) {
      console.warn(`${résumé} — dont ${result.zeroAmountOrders} sans montant exploitable.`);
    } else {
      console.info(résumé);
    }

    return NextResponse.json({
      success: true,
      complete: result.complete,
      synced: {
        orders: result.orders,
        items: result.items,
        batches: result.batches,
        zeroAmountOrders: result.zeroAmountOrders,
      },
      since: result.since,
      durationMs: ms,
    });
  } catch (error: any) {
    // Un échec silencieux serait le pire des cas : sans personne devant
    // l'écran, le chiffre d'affaires se figerait sans que rien ne l'indique.
    console.error('[cron] Square : échec de la synchronisation —', error?.message || error);
    if (error instanceof SquareApiError) {
      console.error('[cron] détail Square :', JSON.stringify(error.details));
    }
    return NextResponse.json(
      { error: `Synchronisation automatique en échec : ${error?.message || 'cause inconnue'}` },
      { status: 500 }
    );
  }
}
