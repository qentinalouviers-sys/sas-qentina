import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';

// ─── OCR Prompt ───────────────────────────────────────────────────────────────
const SCAN_PROMPT = `Tu es un assistant OCR expert pour un restaurant.
Analyse ce document (facture fournisseur, ticket de caisse, bon de livraison, reçu CB).
Retourne UNIQUEMENT un JSON valide, sans markdown, sans texte autour.

{
  "fournisseur": "string",
  "date": "YYYY-MM-DD",
  "numero_facture": "string ou null",
  "total_ht": number,
  "total_ttc": number,
  "tva": number,
  "compte_comptable": "601|607|606|6061|61|62|63|64|autre",
  "type_document": "facture|ticket_caisse|bon_livraison|recu",
  "nom_entreprise_present": boolean,
  "lignes": [
    {
      "designation": "string",
      "quantite": number,
      "unite": "kg|L|unité|g|mL",
      "prix_unitaire_ht": number,
      "prix_total_ht": number,
      "categorie": "alimentaire|materiel|emballage|boisson|autre"
    }
  ]
}

Classification comptable :
- 601 : Matières premières alimentaires (farine, viande, fromage, légumes, sauce)
- 607 : Boissons, café, alcool revendus en l'état
- 606 : Fournitures, emballages, nettoyage, petit matériel
- 6061 : Énergie (électricité, gaz, eau)
- 61 : Loyer, assurances, crédit bail
- 62 : Téléphone, internet, SaaS, commissions plateforme
- 63 : Impôts, URSSAF, taxes
- 64 : Salaires, acomptes personnel

Règles impératives :
- Si "METRO" dans le nom → retourner "Métro"
- Si "EUROCIBUS" ou "MOZZALAT" → retourner "Mozzalat"
- Si pas de numéro de facture (ticket simple) → retourner null pour numero_facture
- Si une valeur est illisible → 0 pour les nombres, null pour les textes
- Toujours retourner total_ht et total_ttc même si c'est le même montant (pas de TVA)
- Pour nom_entreprise_present, vérifie bien si l'une des mentions client "TEKOTEK", "QENTINA" ou "TEKO TEK" apparaît explicitement sur la facture ou le ticket (soit comme client, soit dans l'en-tête client).`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rnd2(v: number): number {
  return Math.round(Number(v) * 100) / 100;
}

function safeParseJSON(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  const s = (m ? m[0] : text).replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(s);
}

// ─── Route ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { fileBase64, mimeType, filename, files } = await req.json();
    if ((!fileBase64 || !mimeType) && (!files || files.length === 0)) {
      return NextResponse.json({ error: 'Fichier requis (fileBase64 + mimeType ou files)' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── 1. Claude OCR ──────────────────────────────────────────────────────
    const isPDF = mimeType ? mimeType.includes('pdf') : false;
    let sourceBlocks: any[] = [];
    if (files && Array.isArray(files) && files.length > 0) {
      sourceBlocks = files.map(f => {
        const isFPDF = f.mimeType.includes('pdf');
        return isFPDF
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.fileBase64 } }
          : { type: 'image',    source: { type: 'base64', media_type: f.mimeType,             data: f.fileBase64 } };
      });
    } else {
      sourceBlocks = [
        isPDF
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
          : { type: 'image',    source: { type: 'base64', media_type: mimeType,             data: fileBase64 } }
      ];
    }

    const aiRes = await createClaudeMessage(anthropic, {
      system: SCAN_PROMPT,
      messages: [{
        role: 'user',
        content: [
          ...sourceBlocks,
          { type: 'text', text: 'Extrais les données de ces pages faisant partie de la même facture.' }
        ],
      }],
      max_tokens: 4096,
    });

    const textContent = aiRes.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return NextResponse.json({ error: 'Réponse IA invalide' }, { status: 500 });
    }

    let extracted: any;
    try {
      extracted = safeParseJSON(textContent.text);
      
      // Calcul automatique de la récupérabilité de la TVA (règle fiscale française)
      let tvaRecoverable = true;
      const typeDoc = extracted.type_document || 'facture';
      const isCompanyPresent = !!extracted.nom_entreprise_present;
      const ttc = extracted.total_ttc || 0;

      if (typeDoc === 'ticket_caisse') {
        if (ttc > 150 && !isCompanyPresent) {
          tvaRecoverable = false;
        }
      } else if (typeDoc === 'facture') {
        if (!isCompanyPresent) {
          tvaRecoverable = false;
        }
      }
      extracted.tva_recoverable = tvaRecoverable;
    } catch {
      return NextResponse.json({ error: 'JSON non parsable', raw: textContent.text }, { status: 500 });
    }

    // ── 2. Détection de doublons ───────────────────────────────────────────
    let isDuplicate = false;
    let duplicateInvoice: any = null;

    // Par numéro de facture
    if (extracted.numero_facture) {
      const { data: byNum } = await supabase
        .from('invoices')
        .select('id, invoice_number, date, total_ttc, accounting_ref, suppliers(name)')
        .eq('invoice_number', extracted.numero_facture)
        .limit(1);
      if (byNum && byNum.length > 0) {
        isDuplicate = true;
        duplicateInvoice = byNum[0];
      }
    }

    // Par date + montant TTC (tickets sans numéro)
    if (!isDuplicate && extracted.total_ttc && extracted.date) {
      const ttc = rnd2(extracted.total_ttc);
      const { data: byAmt } = await supabase
        .from('invoices')
        .select('id, invoice_number, date, total_ttc, accounting_ref, suppliers(name)')
        .eq('date', extracted.date)
        .gte('total_ttc', ttc - 0.5)
        .lte('total_ttc', ttc + 0.5)
        .limit(1);
      if (byAmt && byAmt.length > 0) {
        isDuplicate = true;
        duplicateInvoice = byAmt[0];
      }
    }

    // ── 3. Upload fichier dans Supabase Storage ────────────────────────────
    let fileUrl: string | null = null;
    if (!isDuplicate) {
      try {
        if (files && Array.isArray(files) && files.length > 0) {
          const uploadPromises = files.map(async (f, idx) => {
            const bytes = Buffer.from(f.fileBase64, 'base64');
            const isFPDF = f.mimeType.includes('pdf');
            const ext = isFPDF ? 'pdf' : (f.mimeType.split('/')[1] || 'jpg');
            const ts = Date.now();
            const safeFile = `${idx}_${(filename || `scan_${ts}.${ext}`)}`
              .replace(/[^a-zA-Z0-9._-]/g, '_')
              .substring(0, 80);
            const now = new Date();
            const path = `invoices/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${ts}_${safeFile}`;

            const { error: uploadErr } = await supabase.storage
              .from('invoice-files')
              .upload(path, bytes, { contentType: f.mimeType, upsert: false });

            if (uploadErr) {
              console.warn(`Storage upload page ${idx + 1} failed:`, uploadErr.message);
              return null;
            }

            const { data: { publicUrl } } = supabase.storage
              .from('invoice-files')
              .getPublicUrl(path);
            return publicUrl;
          });
          const urls = await Promise.all(uploadPromises);
          const validUrls = urls.filter(u => u !== null);
          if (validUrls.length > 0) {
            fileUrl = JSON.stringify(validUrls);
          }
        } else {
          const bytes = Buffer.from(fileBase64, 'base64');
          const ext = isPDF ? 'pdf' : (mimeType.split('/')[1] || 'jpg');
          const ts = Date.now();
          const safeFile = (filename || `scan_${ts}.${ext}`)
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .substring(0, 80);
          const now = new Date();
          const path = `invoices/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${ts}_${safeFile}`;

          const { error: uploadErr } = await supabase.storage
            .from('invoice-files')
            .upload(path, bytes, { contentType: mimeType, upsert: false });

          if (!uploadErr) {
            const { data: { publicUrl } } = supabase.storage
              .from('invoice-files')
              .getPublicUrl(path);
            fileUrl = publicUrl;
          } else {
            console.warn('Storage upload failed (bucket "invoice-files" may not exist):', uploadErr.message);
          }
        }
      } catch (e) {
        console.warn('Storage upload exception (non-fatal):', e);
      }
    }

    // ── 4. Recherche transactions bancaires correspondantes ────────────────
    const bankCandidates: any[] = [];
    if (!isDuplicate && extracted.total_ttc && extracted.date) {
      const targetAmt = -Math.abs(rnd2(Number(extracted.total_ttc)));
      const d = new Date(extracted.date);
      const dMin = new Date(d); dMin.setDate(d.getDate() - 10);
      const dMax = new Date(d); dMax.setDate(d.getDate() + 10);

      const { data: candidates } = await supabase
        .from('bank_transactions')
        .select('id, date, description, amount, status, category')
        .in('status', ['pending_invoice', 'facture_ok'])
        .gte('amount', targetAmt - 2.0)
        .lte('amount', targetAmt + 2.0)
        .gte('date', dMin.toISOString().split('T')[0])
        .lte('date', dMax.toISOString().split('T')[0])
        .order('date', { ascending: false })
        .limit(5);

      if (candidates) {
        for (const c of candidates) {
          const amtDiff = Math.abs(Math.abs(Number(c.amount)) - Math.abs(targetAmt));
          const dDiff = Math.abs(new Date(c.date).getTime() - d.getTime()) / 86_400_000;
          // Score 0–100 : amount ×0.7 + date ×0.3
          const amtScore = Math.max(0, 100 - (amtDiff / Math.max(Math.abs(targetAmt), 1)) * 500);
          const dScore   = Math.max(0, 100 - dDiff * 8);
          const score    = Math.round(amtScore * 0.7 + dScore * 0.3);
          bankCandidates.push({
            ...c,
            score,
            amount_diff: rnd2(amtDiff),
            date_diff: Math.round(dDiff),
          });
        }
        bankCandidates.sort((a, b) => b.score - a.score);
      }
    }

    const matchConfidence: 'high' | 'medium' | 'low' | 'none' =
      bankCandidates.length === 0        ? 'none'
      : bankCandidates[0].score >= 85   ? 'high'
      : bankCandidates[0].score >= 55   ? 'medium'
      :                                    'low';

    return NextResponse.json({
      success: true,
      extracted,
      file_url: fileUrl,
      is_duplicate: isDuplicate,
      duplicate_invoice: duplicateInvoice,
      bank_candidates: bankCandidates,
      match_confidence: matchConfidence,
    });

  } catch (err) {
    console.error('Scanner error:', err);
    return NextResponse.json({ error: 'Erreur scanner IA' }, { status: 500 });
  }
}
