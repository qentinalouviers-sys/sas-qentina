import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/api-auth';
import {
  describeSettings,
  saveSetting,
  deleteSetting,
  isSettingKey,
  isSecretKey,
} from '@/lib/ai/settings';

/**
 * Réglages des moteurs IA : lecture d'état, enregistrement, suppression.
 *
 * Une clé API ne ressort JAMAIS d'ici. La lecture ne renvoie que l'empreinte
 * (quatre derniers caractères), la provenance et la date : de quoi savoir ce
 * qui est en place sans jamais exposer le secret au navigateur.
 *
 * L'accès est restreint par proxy.ts : le rôle « comptable » n'atteint pas
 * /api/settings. La garde requireUser reste en défense en profondeur.
 */

/** Valeurs acceptées pour les réglages non secrets. */
const ALLOWED_VALUES: Record<string, readonly string[]> = {
  ocr_provider: ['gemini', 'anthropic'],
};

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await describeSettings());
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[Réglages IA] Lecture impossible : ${reason}`);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { key, value } = await request.json();

    if (typeof key !== 'string' || !isSettingKey(key)) {
      return NextResponse.json({ error: 'Réglage inconnu' }, { status: 400 });
    }
    if (typeof value !== 'string' || !value.trim()) {
      return NextResponse.json({ error: 'Valeur vide' }, { status: 400 });
    }

    const allowed = ALLOWED_VALUES[key];
    if (allowed && !allowed.includes(value.trim())) {
      return NextResponse.json(
        { error: `Valeur refusée. Attendu : ${allowed.join(' ou ')}.` },
        { status: 400 }
      );
    }

    // Garde-fou de saisie : une clé collée avec un espace ou tronquée produit
    // sinon une erreur d'authentification incompréhensible au premier scan.
    if (isSecretKey(key) && value.trim().length < 20) {
      return NextResponse.json(
        { error: 'Cette clé semble trop courte. Vérifiez le copier-coller.' },
        { status: 400 }
      );
    }

    await saveSetting(key, value, auth.user.email ?? auth.user.id);
    return NextResponse.json({ success: true, ...(await describeSettings()) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[Réglages IA] Enregistrement impossible : ${reason}`);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const key = request.nextUrl.searchParams.get('key');
    if (!key || !isSettingKey(key)) {
      return NextResponse.json({ error: 'Réglage inconnu' }, { status: 400 });
    }

    await deleteSetting(key);
    return NextResponse.json({ success: true, ...(await describeSettings()) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[Réglages IA] Suppression impossible : ${reason}`);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
