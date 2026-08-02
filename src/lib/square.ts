import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * square.ts — Client API Square partagé (sync + webhook).
 * Centralise l'appel API et l'écriture des commandes en base pour
 * garantir que les deux chemins d'entrée produisent les mêmes données.
 */

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-12-18';

export async function squareFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
      ...options.headers,
    },
  });
  return res.json();
}

interface SquareApiOrder {
  id: string;
  created_at?: string;
  total_money?: { amount?: number };
  net_amounts?: { total_money?: { amount?: number } };
  total_discount_money?: { amount?: number };
  line_items?: {
    name?: string;
    quantity?: string;
    base_price_money?: { amount?: number };
    total_money?: { amount?: number };
    category_name?: string;
  }[];
}

/** Convertit une commande Square (API) en ligne square_orders. */
export function toOrderRow(order: SquareApiOrder) {
  return {
    square_order_id: order.id,
    total_money: (order.total_money?.amount || 0) / 100,
    net_amount: (order.net_amounts?.total_money?.amount || 0) / 100,
    discount_amount: (order.total_discount_money?.amount || 0) / 100,
    service: order.created_at?.substring(0, 10),
    created_at: order.created_at,
    raw_data: order, // conservé pour le calcul TVA (total_tax_money par ligne)
  };
}

/** Convertit les line_items d'une commande en lignes square_items. */
export function toItemRows(order: SquareApiOrder, dbOrderId: string) {
  return (order.line_items || []).map(item => ({
    order_id: dbOrderId,
    name: item.name || 'Article',
    quantity: parseInt(item.quantity || '1', 10),
    base_price: (item.base_price_money?.amount || 0) / 100,
    total_price: (item.total_money?.amount || 0) / 100,
    category_name: item.category_name || null,
  }));
}

/**
 * Upsert d'une commande unique + remplacement de ses articles.
 * Utilisé par le webhook (temps réel).
 */
export async function upsertSquareOrder(supabase: SupabaseClient, order: SquareApiOrder) {
  const { data: upserted, error } = await supabase
    .from('square_orders')
    .upsert(toOrderRow(order), { onConflict: 'square_order_id' })
    .select('id')
    .single();

  if (error || !upserted) throw error ?? new Error('Upsert square_orders a échoué');

  await supabase.from('square_items').delete().eq('order_id', upserted.id);
  const items = toItemRows(order, upserted.id);
  if (items.length > 0) {
    await supabase.from('square_items').insert(items);
  }
  return upserted.id;
}
