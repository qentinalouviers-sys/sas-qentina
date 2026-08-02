import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature');
    const webhookSecret = process.env.SQUARE_WEBHOOK_SECRET;

    // Verify signature
    if (webhookSecret && signature) {
      const notificationUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/square/webhook`;
      const hmac = crypto
        .createHmac('sha256', webhookSecret)
        .update(notificationUrl + body)
        .digest('base64');

      if (hmac !== signature) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    const event = JSON.parse(body);
    const supabase = createServiceRoleClient();

    if (event.type === 'order.fulfillment.updated' || event.type === 'payment.completed') {
      const orderId = event.data?.object?.order_id || event.data?.id;
      if (orderId) {
        // Fetch full order details from Square
        const orderRes = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
          headers: {
            'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-12-18',
          },
        });
        const { order } = await orderRes.json();

        if (order) {
          const totalMoney = (order.total_money?.amount || 0) / 100;
          const netAmount = (order.net_amounts?.total_money?.amount || 0) / 100;
          const discountAmount = (order.total_discount_money?.amount || 0) / 100;

          const { data: upsertedOrder } = await supabase
            .from('square_orders')
            .upsert({
              square_order_id: order.id,
              total_money: totalMoney,
              net_amount: netAmount,
              discount_amount: discountAmount,
              service: order.created_at?.substring(0, 10),
              created_at: order.created_at,
            }, { onConflict: 'square_order_id' })
            .select('id')
            .single();

          if (upsertedOrder && order.line_items) {
            await supabase.from('square_items').delete().eq('order_id', upsertedOrder.id);
            const items = order.line_items.map((item: {
              name?: string;
              quantity?: string;
              base_price_money?: { amount?: number };
              total_money?: { amount?: number };
            }) => ({
              order_id: upsertedOrder.id,
              name: item.name || 'Article',
              quantity: parseInt(item.quantity || '1'),
              base_price: (item.base_price_money?.amount || 0) / 100,
              total_price: (item.total_money?.amount || 0) / 100,
            }));
            await supabase.from('square_items').insert(items);
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
