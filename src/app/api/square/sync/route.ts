import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { squareFetch, toOrderRow, toItemRows } from '@/lib/square';

/**
 * Synchronisation Square — importe les commandes COMPLETED.
 *
 * La caisse Square est la référence du chiffre d'affaires : cette route est
 * donc celle dont l'exhaustivité compte le plus. Deux précautions en
 * découlent.
 *
 * 1. **Elle s'arrête d'elle-même avant que la plateforme ne la coupe**, et
 *    renvoie son curseur pour être reprise. Une fonction interrompue en cours
 *    de pagination laissait une partie des commandes de côté en annonçant un
 *    succès — c'est le même défaut qui avait tronqué l'import bancaire.
 *
 * 2. **Elle dit toujours si elle a fini** (`complete`). Un chiffre d'affaires
 *    partiel sans avertissement fausse la TVA, le P&L et le food cost.
 *
 * L'upsert sur `square_order_id` rend l'opération rejouable sans doublon.
 */
export const maxDuration = 60;

/** Marge de sécurité : on rend la main avant la limite de la plateforme. */
const BUDGET_MS = 45_000;

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const startedAt = Date.now();

  try {
    const supabase = createServiceRoleClient();
    const locationId = process.env.SQUARE_LOCATION_ID;

    // Reprise et fenêtre de dates optionnelles : permettent de rattraper un
    // mois précis sans rejouer une année entière.
    let body: { cursor?: string; days?: number; startAt?: string } = {};
    try { body = await request.json(); } catch { /* corps vide = valeurs par défaut */ }

    const startDate = new Date();
    if (body.startAt && /^\d{4}-\d{2}-\d{2}/.test(body.startAt)) {
      startDate.setTime(Date.parse(body.startAt));
    } else {
      startDate.setDate(startDate.getDate() - (body.days && body.days > 0 ? body.days : 365));
    }

    let syncedOrders = 0;
    let syncedItems = 0;
    let batches = 0;
    let zeroAmountOrders = 0;
    let cursor: string | undefined = body.cursor;

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

        // Une commande à zéro trahit une donnée Square incomplète : on la
        // compte pour que le chiffre d'affaires ne soit pas silencieusement
        // minoré (c'est ce que produisait l'absence de repli sur total_money).
        zeroAmountOrders += orders.filter(
          o => !(o.net_amounts?.total_money?.amount ?? o.total_money?.amount)
        ).length;
      }

      cursor = ordersRes.cursor;
      batches++;

      // On rend la main avant d'être coupé, en conservant le curseur.
      if (cursor && Date.now() - startedAt > BUDGET_MS) {
        return NextResponse.json({
          success: true,
          complete: false,
          cursor,
          synced: { orders: syncedOrders, items: syncedItems, batches, zeroAmountOrders },
          message:
            `${syncedOrders} commandes importées, mais il en reste. Relance la `
            + `synchronisation pour continuer — aucun doublon ne sera créé.`,
        });
      }
    } while (cursor);

    return NextResponse.json({
      success: true,
      complete: true,
      synced: { orders: syncedOrders, items: syncedItems, batches, zeroAmountOrders, timecards: 0 },
      message: zeroAmountOrders > 0
        ? `${syncedOrders} commandes importées, dont ${zeroAmountOrders} sans montant `
          + `exploitable côté Square — à vérifier dans la caisse.`
        : undefined,
    });
  } catch (error: any) {
    console.error('Square sync error:', error);
    // On renvoie la cause : « Erreur synchronisation Square » seul ne permet
    // pas de distinguer un jeton expiré d'une panne de base.
    return NextResponse.json(
      { error: `Erreur synchronisation Square : ${error?.message || 'cause inconnue'}` },
      { status: 500 }
    );
  }
}
