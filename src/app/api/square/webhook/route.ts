import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { squareFetch, upsertSquareOrder } from '@/lib/square';
import { tryGetAppUrl } from '@/lib/env';

/**
 * Webhook Square — reçoit les événements de paiement/commande en temps réel.
 * Route publique (pas de session), sécurisée par la signature HMAC de Square.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature');
    const webhookSecret = process.env.SQUARE_WEBHOOK_SECRET;

    if (webhookSecret) {
      // Si le secret est configuré, la signature est OBLIGATOIRE :
      // une requête sans signature ou avec une signature invalide est rejetée.
      if (!signature) {
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
      }

      // Sans URL publique, la signature serait calculée sur « undefined/... »
      // et échouerait systématiquement. On répond 503 (problème de
      // configuration côté serveur) plutôt qu'un 401 trompeur : Square
      // réessaiera une fois la variable ajoutée.
      const appUrl = tryGetAppUrl();
      if (!appUrl) {
        console.error(
          '[Square Webhook] NEXT_PUBLIC_APP_URL est absent : impossible de vérifier la signature. ' +
          'Les ventes en temps réel sont REJETÉES tant que la variable n\'est pas définie sur Vercel ' +
          '(Settings → Environment Variables), avec la même valeur que dans le Square Developer Dashboard.'
        );
        return NextResponse.json(
          { error: 'Configuration serveur incomplète : NEXT_PUBLIC_APP_URL manquant' },
          { status: 503 }
        );
      }

      const notificationUrl = `${appUrl}/api/square/webhook`;
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(notificationUrl + body)
        .digest();
      const received = Buffer.from(signature, 'base64');
      if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
      ) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } else {
      console.warn(
        '[Square Webhook] SQUARE_WEBHOOK_SECRET non configuré — la signature ne peut pas être vérifiée. ' +
        'Ajoutez le secret depuis le Square Developer Dashboard pour sécuriser ce webhook.'
      );
    }

    const event = JSON.parse(body);

    if (event.type === 'order.fulfillment.updated' || event.type === 'payment.completed') {
      const orderId = event.data?.object?.order_id || event.data?.id;
      if (orderId) {
        // On ne fait jamais confiance au contenu du webhook :
        // on récupère la commande directement auprès de l'API Square.
        const { order } = await squareFetch(`/orders/${orderId}`);
        if (order) {
          const supabase = createServiceRoleClient();
          await upsertSquareOrder(supabase, order);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
