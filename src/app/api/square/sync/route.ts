import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

const SQUARE_BASE = 'https://connect.squareup.com/v2';

async function squareFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-12-18',
      ...options.headers,
    },
  });
  return res.json();
}

export async function POST() {
  try {
    const supabase = createServiceRoleClient();
    const locationId = process.env.SQUARE_LOCATION_ID;

    // Sync orders — last 365 days (1 an)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);

    let syncedOrders = 0;
    let syncedItems = 0;
    let cursor: string | undefined = undefined;

    do {
      const ordersBody: any = {
        location_ids: [locationId],
        limit: 500,
        query: {
          filter: {
            date_time_filter: {
              created_at: { start_at: startDate.toISOString() }
            },
            state_filter: { states: ['COMPLETED'] }
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
        }
      };

      if (cursor) {
        ordersBody.cursor = cursor;
      }

      const ordersRes = await squareFetch('/orders/search', {
        method: 'POST',
        body: JSON.stringify(ordersBody),
      });

      if (ordersRes.errors) {
        console.error('Square API errors:', ordersRes.errors);
        return NextResponse.json({ error: 'Square API Error', details: ordersRes.errors }, { status: 400 });
      }

      if (ordersRes.orders && ordersRes.orders.length > 0) {
        // 1. Prepare orders for batch upsert
        const ordersToUpsert = ordersRes.orders.map((order: any) => {
          const totalMoney = (order.total_money?.amount || 0) / 100;
          const netAmount = (order.net_amounts?.total_money?.amount || 0) / 100;
          const discountAmount = (order.total_discount_money?.amount || 0) / 100;
          const serviceDate = order.created_at?.substring(0, 10);
          return {
            square_order_id: order.id,
            total_money: totalMoney,
            net_amount: netAmount,
            discount_amount: discountAmount,
            service: serviceDate,
            created_at: order.created_at,
            raw_data: order,
          };
        });

        // 2. Batch upsert orders and select back the generated IDs
        const { data: upsertedOrders, error: upsertError } = await supabase
          .from('square_orders')
          .upsert(ordersToUpsert, { onConflict: 'square_order_id' })
          .select('id, square_order_id');

        if (upsertError) {
          console.error('Upsert orders error:', upsertError);
          throw upsertError;
        }

        // Map square_order_id to database order UUID
        const orderIdMap = new Map<string, string>();
        if (upsertedOrders) {
          upsertedOrders.forEach((o: any) => {
            orderIdMap.set(o.square_order_id, o.id);
          });
        }

        const itemsToInsert: any[] = [];
        const orderIdsToClear: string[] = [];

        for (const order of ordersRes.orders) {
          const dbOrderId = orderIdMap.get(order.id);
          if (dbOrderId) {
            orderIdsToClear.push(dbOrderId);
            if (order.line_items) {
              order.line_items.forEach((item: any) => {
                itemsToInsert.push({
                  order_id: dbOrderId,
                  name: item.name || 'Article',
                  quantity: parseInt(item.quantity || '1'),
                  base_price: (item.base_price_money?.amount || 0) / 100,
                  total_price: (item.total_money?.amount || 0) / 100,
                  category_name: item.category_name || null,
                });
              });
            }
          }
        }

        // 3. Delete existing items for all these orders in one query
        if (orderIdsToClear.length > 0) {
          const { error: deleteError } = await supabase
            .from('square_items')
            .delete()
            .in('order_id', orderIdsToClear);

          if (deleteError) {
            console.error('Delete items error:', deleteError);
            throw deleteError;
          }
        }

        // 4. Batch insert all new items
        if (itemsToInsert.length > 0) {
          const { error: insertError } = await supabase
            .from('square_items')
            .insert(itemsToInsert);

          if (insertError) {
            console.error('Insert items error:', insertError);
            throw insertError;
          }
          syncedItems += itemsToInsert.length;
        }

        syncedOrders += ordersToUpsert.length;
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
