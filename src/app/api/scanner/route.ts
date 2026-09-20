import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import type { OcrFile } from '@/lib/ai/invoice-ocr';
import { analyzeInvoiceFiles } from '@/lib/scanner';

// L'OCR d'une facture de plusieurs pages dépasse largement le délai par défaut
// d'une fonction Vercel. L'appel Gemini n'est pas streamé : sans ce réglage,
// une grosse facture se solde par un 504 avant toute réponse.
export const maxDuration = 60;

/**
 * Scanner IA — étape 1 : OCR (double lecture) + détection de doublons +
 * candidats bancaires. N'enregistre RIEN : l'utilisateur relit, corrige, puis
 * confirme via /api/scanner/confirm. La logique vit dans lib/scanner.ts, que
 * les agents IA empruntent aussi.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { fileBase64, mimeType, filename, files } = await req.json();
    if ((!fileBase64 || !mimeType) && (!files || files.length === 0)) {
      return NextResponse.json({ error: 'Fichier requis (fileBase64 + mimeType ou files)' }, { status: 400 });
    }

    const ocrFiles: OcrFile[] =
      files && Array.isArray(files) && files.length > 0 ? files : [{ fileBase64, mimeType }];

    let analysis;
    try {
      analysis = await analyzeInvoiceFiles(createServiceRoleClient(), ocrFiles, filename);
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur OCR' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      extracted: analysis.extracted,
      // Ce que l'humain devra regarder avant de confirmer. L'écran les
      // recalcule à chaque correction, et le serveur à la confirmation :
      // cette liste sert à l'affichage initial, pas à la décision.
      anomalies: analysis.anomalies,
      ocr_engine: analysis.ocr_engine,
      file_url: analysis.file_url,
      is_duplicate: analysis.is_duplicate,
      duplicate_invoice: analysis.extracted.doublon,
      bank_candidates: analysis.bank_candidates,
      match_confidence: analysis.match_confidence,
    });
  } catch (err) {
    console.error('Scanner error:', err);
    return NextResponse.json({ error: 'Erreur scanner IA' }, { status: 500 });
  }
}
