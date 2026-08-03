import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { squareFetch } from '@/lib/square';

/**
 * Diagnostic Square — pourquoi le chiffre d'affaires est-il incomplet ?
 *
 * Le module « À faire » sait **dire** qu'il manque des ventes : les versements
 * reçus sur le compte dépassent le CA enregistré, et comme un versement ne
 * contient que la carte, commission déduite, l'inégalité est une preuve. Mais
 * il ne sait pas dire **pourquoi**, et « relance la reprise » n'est une réponse
 * que si la reprise est effectivement en cause.
 *
 * Cette route interroge Square directement et compare, sur la même fenêtre :
 *
 *  1. **Les boutiques.** L'import ne lit qu'un seul `location_id`. Un second
 *     terminal, une caisse livraison, une boutique de test restée active — et
 *     une part des ventes n'entre jamais, définitivement, quel que soit le
 *     nombre de reprises lancées.
 *  2. **Les états.** L'import ne prend que les commandes `COMPLETED`. Une
 *     commande payée mais restée `OPEN` est invisible.
 *  3. **Le compte.** Ce que Square dit avoir, face à ce que la base contient.
 *
 * Lecture seule : aucune écriture, rien n'est corrigé ici. On établit le fait
 * avant de décider quoi faire.
 */

export const maxDuration = 60;

interface LocationSummary {
  id: string;
  name: string;
  status: string;
  configured: boolean;
}

/** Compte les commandes d'une boutique sur la fenêtre, par état. */
async function countOrders(
  locationId: string,
  startAt: string,
  states: string[],
): Promise<{ count: number; amountTtc: number; truncated: boolean }> {
  let cursor: string | undefined;
  let count = 0;
  let cents = 0;
  let pages = 0;

  do {
    const body: Record<string, unknown> = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt } },
          state_filter: { states },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
    };
    if (cursor) body.cursor = cursor;

    const res = await squareFetch('/orders/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.errors) throw new Error(JSON.stringify(res.errors));

    for (const o of (res.orders || []) as any[]) {
      count++;
      cents += o.net_amounts?.total_money?.amount ?? o.total_money?.amount ?? 0;
    }
    cursor = res.cursor;
    pages++;

    // Garde-fou : au-delà, on répond avec ce qu'on a et on le dit. Un
    // diagnostic tronqué qui s'annonce vaut mieux qu'une route qui expire.
    if (pages >= 20) return { count, amountTtc: cents / 100, truncated: !!cursor };
  } while (cursor);

  return { count, amountTtc: cents / 100, truncated: false };
}

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const configuredId = process.env.SQUARE_LOCATION_ID;
  if (!configuredId) {
    return NextResponse.json(
      { error: 'SQUARE_LOCATION_ID absente : l\'import ne peut lire aucune boutique.' },
      { status: 503 },
    );
  }

  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days')) || 90, 1), 400);
  const start = new Date();
  start.setDate(start.getDate() - days);
  const startAt = start.toISOString();
  const startDate = startAt.slice(0, 10);

  try {
    // ── 1. Les boutiques du compte ──────────────────────────────────────────
    const locRes = await squareFetch('/locations');
    if (locRes.errors) throw new Error(JSON.stringify(locRes.errors));

    const locations: LocationSummary[] = ((locRes.locations || []) as any[]).map(l => ({
      id: l.id,
      name: l.name || '(sans nom)',
      status: l.status || 'UNKNOWN',
      configured: l.id === configuredId,
    }));

    const active = locations.filter(l => l.status === 'ACTIVE');
    const ignored = active.filter(l => !l.configured);

    // ── 2. Les ventes, boutique par boutique ────────────────────────────────
    // Chaque boutique ignorée est chiffrée : sans le montant, « il y a une
    // deuxième boutique » ne dit pas s'il s'agit de 50 € ou de 10 000 €.
    const perLocation = [];
    for (const loc of active) {
      const completed = await countOrders(loc.id, startAt, ['COMPLETED']);
      perLocation.push({ ...loc, completed });
    }

    // ── 3. Les commandes payées mais non clôturées ──────────────────────────
    const openOnConfigured = await countOrders(configuredId, startAt, ['OPEN']);

    // ── 4. Ce que la base contient réellement ───────────────────────────────
    const supabase = createServiceRoleClient();
    // Paginé : c'est cette requête qui, plafonnée à 1 000 lignes, a fait
    // annoncer « il manque 18 793 € » alors que les commandes étaient bien en
    // base. Un diagnostic qui se trompe est pire que pas de diagnostic.
    const storedRows = await fetchAllRows<{ net_amount: number | null }>(
      (from, to) => supabase
        .from('square_orders')
        .select('net_amount')
        .gte('service', startDate)
        .range(from, to),
    );
    const storedTtc = Math.round(
      storedRows.reduce((s, o) => s + (o.net_amount || 0), 0) * 100,
    ) / 100;

    const squareTtc = perLocation
      .filter(l => l.configured)
      .reduce((s, l) => s + l.completed.amountTtc, 0);
    const squareCount = perLocation
      .filter(l => l.configured)
      .reduce((s, l) => s + l.completed.count, 0);

    // ── 5. Les constats, en clair ───────────────────────────────────────────
    const findings: string[] = [];

    if (ignored.length > 0) {
      const total = perLocation
        .filter(l => !l.configured)
        .reduce((s, l) => s + l.completed.amountTtc, 0);
      findings.push(
        `${ignored.length} boutique(s) Square active(s) ne sont pas importées : `
        + `${ignored.map(l => `« ${l.name} »`).join(', ')}. `
        + `Elles totalisent ${total.toFixed(2)} € TTC sur ${days} jours — ce montant `
        + `n'entrera JAMAIS, quel que soit le nombre de reprises lancées, tant que `
        + `l'import ne lit qu'une boutique.`,
      );
    }

    if (openOnConfigured.count > 0) {
      findings.push(
        `${openOnConfigured.count} commande(s) restée(s) « ouvertes » côté Square `
        + `(${openOnConfigured.amountTtc.toFixed(2)} € TTC). L'import ne prend que les `
        + `commandes clôturées : celles-ci sont invisibles. À clôturer dans Square.`,
      );
    }

    const missing = Math.round((squareTtc - storedTtc) * 100) / 100;
    if (missing > 1) {
      findings.push(
        `Sur la boutique configurée, Square annonce ${squareCount} commandes pour `
        + `${squareTtc.toFixed(2)} € TTC, la base en contient ${storedRows.length} pour `
        + `${storedTtc.toFixed(2)} € : il manque ${missing.toFixed(2)} €. `
        + `Ici une reprise de l'historique est la bonne réponse.`,
      );
    } else if (findings.length === 0) {
      findings.push(
        `La base contient tout ce que Square annonce sur ${days} jours `
        + `(${squareCount} commandes, ${squareTtc.toFixed(2)} € TTC). `
        + `Si un écart persiste avec les versements bancaires, il vient d'ailleurs : `
        + `remboursements, avances Square Capital, ou période comparée décalée.`,
      );
    }

    const truncated = perLocation.some(l => l.completed.truncated) || openOnConfigured.truncated;
    if (truncated) {
      findings.push(
        `Lecture interrompue au bout de 10 000 commandes : les montants ci-dessus `
        + `sont des minima. Relance sur une fenêtre plus courte pour un chiffre exact.`,
      );
    }

    return NextResponse.json({
      days,
      since: startDate,
      configuredLocationId: configuredId,
      locations: perLocation,
      openOrders: openOnConfigured,
      stored: { count: storedRows.length, amountTtc: storedTtc },
      square: { count: squareCount, amountTtc: squareTtc },
      missing,
      findings,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Diagnostic impossible : ${e.message}` },
      { status: 500 },
    );
  }
}
