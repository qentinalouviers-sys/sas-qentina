import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { syncSquareOrders, SquareApiError } from '@/lib/square-sync';

/**
 * Rattrapage manuel de l'historique Square.
 *
 * La synchronisation courante est assurée chaque nuit par
 * `/api/cron/square-sync` : cette route n'est plus dans le geste quotidien.
 * Elle sert à reprendre un historique profond, que le travail de nuit ne
 * remonte pas (il ne couvre que les 45 derniers jours).
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    let body: { cursor?: string; days?: number; startAt?: string } = {};
    try { body = await request.json(); } catch { /* corps vide = valeurs par défaut */ }

    const result = await syncSquareOrders({
      cursor: body.cursor,
      days: body.days,
      startAt: body.startAt,
    });

    return NextResponse.json({
      success: true,
      complete: result.complete,
      cursor: result.cursor,
      synced: {
        orders: result.orders,
        items: result.items,
        batches: result.batches,
        zeroAmountOrders: result.zeroAmountOrders,
      },
      message: !result.complete
        ? `${result.orders} commandes importées, mais il en reste. Relance pour continuer — `
          + `aucun doublon ne sera créé.`
        : result.zeroAmountOrders > 0
          ? `${result.orders} commandes importées, dont ${result.zeroAmountOrders} sans montant `
            + `exploitable côté Square — à vérifier dans la caisse.`
          : undefined,
    });
  } catch (error: any) {
    console.error('Square sync error:', error);
    if (error instanceof SquareApiError) {
      return NextResponse.json(
        { error: 'Square a refusé la requête', details: error.details },
        { status: 400 }
      );
    }
    // On renvoie la cause : un libellé générique ne permet pas de distinguer
    // un jeton expiré d'une panne de base.
    return NextResponse.json(
      { error: `Erreur synchronisation Square : ${error?.message || 'cause inconnue'}` },
      { status: 500 }
    );
  }
}
