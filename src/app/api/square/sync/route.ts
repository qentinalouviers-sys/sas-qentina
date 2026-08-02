import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { squareFetch, toOrderRow, toItemRows } from '@/lib/square';

/**
 * Synchronisation manuelle Square — importe les commandes COMPLETED
 * des 365 derniers jours (par lots de 500, curseur de pagination).
 */
export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const supabase = createServiceRoleClient();
    const locationId = process.env.SQUARE_LOCATION_ID;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);

    let syncedOrders = 0;
    let syncedItems = 0;
    let cursor: string | undefined = undefined;

    do {
      const ordersBody: Record<string, unknown> = {
        location_ids: [locationId],
        limit: 500,
        query: {
          filter: {
            date_time_filter: {
              created_at: { start_at: startDate.toISOString() },
            },
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

      if (ordersRes.errors) {
        console.error('Square API errors:', ordersRes.errors);
        return NextResponse.json({ error: 'Square API Error', details: ordersRes.errors }, { status: 400 });
      }

      const orders: any[] = ordersRes.orders || [];
      if (orders.length > 0) {
        // 1. Upsert des commandes en lot, on récupère les UUID générés
        const { data: upsertedOrders, error: upsertError } = await supabase
          .from('square_orders')
          .upsert(orders.map(toOrderRow), { onConflict: 'square_order_id' })
          .select('id, square_order_id');

        if (upsertError) throw upsertError;

        const orderIdMap = new Map<string, string>(
          (upsertedOrders || []).map((o: { square_order_id: string; id: string }) => [o.square_order_id, o.id])
        );

        // 2. Reconstruire les articles de ces commandes
        const itemsToInsert = orders.flatMap(order => {
          const dbOrderId = orderIdMap.get(order.id);
          return dbOrderId ? toItemRows(order, dbOrderId) : [];
        });
        const orderIdsToClear = [...orderIdMap.values()];

        if (orderIdsToClear.length > 0) {
          const { error: deleteError } = await supabase
            .from('square_items')
            .delete()
            .in('order_id', orderIdsToClear);
          if (deleteError) throw deleteError;
        }

        if (itemsToInsert.length > 0) {
          const { error: insertError } = await supabase
            .from('square_items')
            .insert(itemsToInsert);
          if (insertError) throw insertError;
          syncedItems += itemsToInsert.length;
        }

        syncedOrders += orders.length;
      }

      cursor = ordersRes.cursor;
    } while (cursor);

    return NextResponse.json({
      success: true,
      synced: { orders: syncedOrders, items: syncedItems, timecards: 0 },
    });
  } catch (error) {
    console.error('Square sync error:', error);
    return NextResponse.json({ error: 'Erreur synchronisation Square' }, { status: 500 });
  }
}
