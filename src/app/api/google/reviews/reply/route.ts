import { NextResponse } from 'next/server';
import { getValidGoogleAccessToken } from '@/lib/google';

export async function POST(request: Request) {
  try {
    const { reviewName, replyText } = await request.json();
    if (!reviewName || !replyText) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const token = await getValidGoogleAccessToken();
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: replyText })
    });

    const data = await res.json();
    if (data.error) {
      if (data.error.status === 'RESOURCE_EXHAUSTED' || data.error.message?.includes('Quota')) {
        throw new Error("Quota Google My Business épuisé (ou limite à 0). Vous devez demander l'accès à l'API My Business depuis Google Cloud Console pour pouvoir répondre aux avis.");
      }
      throw new Error(data.error.message || 'Error replying to review');
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('Google Reviews Reply error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
