/**
 * square-sync.ts — Import des commandes Square. Logique partagée entre le
 * travail planifié de 2 h du matin et le rattrapage manuel.
 *
 * La caisse Square est la référence du chiffre d'affaires : c'est l'exhaustivité
 * qui compte ici, pas la rapidité. Deux précautions en découlent.
 *
 * 1. **La fonction s'arrête avant que la plateforme ne la coupe** et renvoie son
 *    curseur pour être reprise. Une pagination interrompue laissait une partie
 *    des commandes dehors en annonçant un succès — et comme le tri va du plus
 *    récent au plus ancien, ce sont les ventes anciennes qui disparaissaient.
 *
 * 2. **Elle dit toujours si elle a fini.** Un chiffre d'affaires partiel non
 *    signalé fausse la TVA, le P&L et le food cost sans laisser de trace.
 *
 * L'upsert sur `square_order_id` la rend rejouable sans créer de doublon : on
 * peut la relancer autant de fois que nécessaire.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { squareFetch, toOrderRow, toItemRows } from '@/lib/square';

export interface SquareSyncOptions {
  /** Profondeur en jours (défaut 365). Ignoré si `startAt` est fourni. */
  days?: number;
  /** Borne de départ ISO (YYYY-MM-DD…), prioritaire sur `days`. */
  startAt?: string;
  /** Curseur de reprise renvoyé par un appel précédent. */
  cursor?: string;
  /** Budget de temps avant de rendre la main, en millisecondes. */
  budgetMs?: number;
}

export interface SquareSyncResult {
  complete: boolean;
  cursor?: string;
  orders: number;
  items: number;
  batches: number;
  /** Commandes sans montant exploitable côté Square — CA potentiellement minoré. */
  zeroAmountOrders: number;
  /** Borne de départ effectivement utilisée, pour la journalisation. */
  since: string;
}

export class SquareApiError extends Error {
  constructor(public details: unknown) {
    super('Square API a renvoyé une erreur');
    this.name = 'SquareApiError';
  }
}

export async function syncSquareOrders(
  options: SquareSyncOptions = {}
): Promise<SquareSyncResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 45_000;
  const supabase = createServiceRoleClient();
  const locationId = process.env.SQUARE_LOCATION_ID;

  const startDate = new Date();
  if (options.startAt && /^\d{4}-\d{2}-\d{2}/.test(options.startAt)) {
    startDate.setTime(Date.parse(options.startAt));
  } else {
    startDate.setDate(startDate.getDate() - (options.days && options.days > 0 ? options.days : 365));
  }

  let orders = 0;
  let items = 0;
  let batches = 0;
  let zeroAmountOrders = 0;
  let cursor: string | undefined = options.cursor;

  do {
    const ordersBody: Record<string, unknown> = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startDate.toISOString() } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
    };
    if (cursor) ordersBody.cursor = cursor;

    const ordersRes = await squareFetch('/orders/search', {
      method: 'POST',
      body: JSON.stringify(ordersBody),
    });

    if (ordersRes.errors) throw new SquareApiError(ordersRes.errors);

    const batch: any[] = ordersRes.orders || [];
    if (batch.length > 0) {
      const { data: upserted, error: upsertError } = await supabase
        .from('square_orders')
        .upsert(batch.map(toOrderRow), { onConflict: 'square_order_id' })
        .select('id, square_order_id');
      if (upsertError) throw upsertError;

      const idMap = new Map<string, string>(
        (upserted || []).map((o: { square_order_id: string; id: string }) => [o.square_order_id, o.id])
      );

      const itemRows = batch.flatMap(order => {
        const dbId = idMap.get(order.id);
        return dbId ? toItemRows(order, dbId) : [];
      });
      const orderIds = [...idMap.values()];

      if (orderIds.length > 0) {
        const { error: deleteError } = await supabase
          .from('square_items').delete().in('order_id', orderIds);
        if (deleteError) throw deleteError;
      }
      if (itemRows.length > 0) {
        const { error: insertError } = await supabase.from('square_items').insert(itemRows);
        if (insertError) throw insertError;
        items += itemRows.length;
      }

      orders += batch.length;
      zeroAmountOrders += batch.filter(
        o => !(o.net_amounts?.total_money?.amount ?? o.total_money?.amount)
      ).length;
    }

    cursor = ordersRes.cursor;
    batches++;

    if (cursor && Date.now() - startedAt > budgetMs) {
      return {
        complete: false, cursor, orders, items, batches, zeroAmountOrders,
        since: startDate.toISOString().slice(0, 10),
      };
    }
  } while (cursor);

  return {
    complete: true, orders, items, batches, zeroAmountOrders,
    since: startDate.toISOString().slice(0, 10),
  };
}
