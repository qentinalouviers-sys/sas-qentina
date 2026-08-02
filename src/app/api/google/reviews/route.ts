import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    const placeId = process.env.GOOGLE_PLACE_ID;

    if (!apiKey || !placeId) {
      // Fallback check if it was missing
      return NextResponse.json({ error: 'Missing Places API credentials' }, { status: 500 });
    }

    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}?fields=reviews,displayName&key=${apiKey}&languageCode=fr`);
    const data = await res.json();

    if (data.error) throw new Error(data.error.message || 'Error fetching Places API');

    const rawReviews = data.reviews || [];

    // Map Places API review format to My Business API format expected by frontend
    const mappedReviews = rawReviews.map((r: any) => {
      // Convert number rating to string format
      const ratingMap: Record<number, string> = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE' };
      
      return {
        name: r.name, // Used as ID for reply (Note: replying won't work without MyBusiness Quota)
        reviewer: {
          displayName: r.authorAttribution?.displayName || 'Client Anonyme',
          profilePhotoUrl: r.authorAttribution?.photoUri || '',
        },
        createTime: r.publishTime,
        starRating: ratingMap[r.rating] || 'FIVE',
        comment: r.text?.text || '',
        // Places API does not return merchant replies unfortunately.
        reviewReply: null
      };
    });

    return NextResponse.json({
      reviews: mappedReviews,
      locationName: placeId
    });
  } catch (error: any) {
    console.error('Google Places Reviews error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
