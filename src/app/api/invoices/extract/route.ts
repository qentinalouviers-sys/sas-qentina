import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createClaudeMessage } from '@/lib/anthropic';

const SYSTEM_PROMPT = `Tu es un assistant d'extraction de données pour un restaurant.
Analyse ce PDF ou cette image de facture et retourne UNIQUEMENT un JSON valide, sans texte avant ni après, sans markdown.

Format :
{
  "fournisseur": "string",
  "date": "YYYY-MM-DD",
  "numero_facture": "string",
  "total_ht": number,
  "total_ttc": number,
  "compte_comptable": "601|607|606|6061|61|62|63|64|autre", // classification comptable restauration
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

Règles de classification comptable (compte_comptable) :
- 601 : Matières premières alimentaires (farine, viande, fromage, légumes, sauce tomate, etc.) utilisées en cuisine.
- 607 : Boissons, café, alcool, ou autres produits revendus dans l'état au client sans transformation.
- 606 : Fournitures de fonctionnement et petit équipement (emballages, boîtes à pizza, sacs, produits d'entretien, ustensiles).
- 6061 : Énergie et fluides (électricité, gaz, eau) si la facture concerne ces postes.
- 61 : Services extérieurs (loyer, charges locatives, assurances, crédit bail).
- 62 : Autres services extérieurs (téléphone, internet, abonnements logiciels, SaaS, commissions bancaires, UberEats/Deliveroo).
- 63 : Impôts, taxes et cotisations (TVA, URSSAF, taxes foncières).
- 64 : Charges de personnel (salaires, acomptes).
- autre : tout élément ne rentrant pas dans ces catégories.

Règles de quantité et de prix :
- L'unité DOIT être standardisée (kg, L, unité, g, mL). Par exemple, pour un carton de 25kg de farine, retourne quantite: 25, unite: "kg".
- Le prix unitaire HT doit correspondre à cette unité standard. Si le carton de 25kg coûte 50€, le prix unitaire est 2 (50/25).
- Si le nom contient "EUROCIBUS" ou "MOZZALAT", retourne TOUJOURS "Mozzalat".
- Si le nom contient "METRO", retourne TOUJOURS "Métro".
- Pour nom_entreprise_present, vérifie bien si l'une des mentions client "TEKOTEK", "QENTINA" ou "TEKO TEK" apparaît explicitement sur la facture ou le ticket (soit comme client, soit dans l'en-tête client).`;

export async function POST(request: NextRequest) {
  try {
    const { pdfBase64, fileBase64, mimeType, filename } = await request.json();
    const activeBase64 = fileBase64 || pdfBase64;
    if (!activeBase64) {
      return NextResponse.json({ error: 'Fichier requis (PDF ou image)' }, { status: 400 });
    }

    const activeMimeType = mimeType || 'application/pdf';
    const isPDF = activeMimeType.includes('pdf');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let sourceBlock: any;
    if (isPDF) {
      sourceBlock = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: activeBase64,
        },
      };
    } else {
      sourceBlock = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: activeMimeType,
          data: activeBase64,
        },
      };
    }

    const response = await createClaudeMessage(anthropic, {
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            sourceBlock,
            {
              type: 'text',
              text: 'Extrais les données de cette facture au format JSON.',
            },
          ],
        },
      ],
      max_tokens: 4096,
    });

    const textContent = response.content.find((c: any) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return NextResponse.json({ error: 'Réponse Claude invalide' }, { status: 500 });
    }

    let extracted: any;
    try {
      extracted = JSON.parse(textContent.text);
    } catch {
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        return NextResponse.json({ error: 'JSON non parsable', raw: textContent.text }, { status: 500 });
      }
    }

    // Calcul de récupérabilité de la TVA (normes fiscales françaises)
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

    // Save to DB
    const supabase = createServiceRoleClient();

    // Find or create supplier
    let supplierId: string | null = null;
    if (extracted.fournisseur) {
      const { data: existing } = await supabase
        .from('suppliers')
        .select('id')
        .ilike('name', `%${extracted.fournisseur}%`)
        .limit(1)
        .single();

      if (existing) {
        supplierId = existing.id;
      } else {
        const { data: newSupplier } = await supabase
          .from('suppliers')
          .insert({ name: extracted.fournisseur })
          .select('id')
          .single();
        supplierId = newSupplier?.id || null;
      }
    }

    // Check for duplicate invoice
    if (supplierId && extracted.numero_facture) {
      const { data: duplicate } = await supabase
        .from('invoices')
        .select('id')
        .eq('supplier_id', supplierId)
        .eq('invoice_number', extracted.numero_facture)
        .limit(1)
        .single();

      if (duplicate) {
        return NextResponse.json({ success: false, error: `Facture doublon détectée (n° ${extracted.numero_facture}). Elle a déjà été importée.` });
      }
    }

    // Upload file to Supabase Storage
    let fileUrl: string | null = null;
    try {
      const bytes = Buffer.from(activeBase64, 'base64');
      const ext = isPDF ? 'pdf' : (activeMimeType.split('/')[1] || 'jpg');
      const ts = Date.now();
      const safeFile = (filename || `invoice_${ts}.${ext}`)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 80);
      const now = new Date();
      const path = `invoices/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${ts}_${safeFile}`;

      const { error: uploadErr } = await supabase.storage
        .from('invoice-files')
        .upload(path, bytes, { contentType: activeMimeType, upsert: false });

      if (!uploadErr) {
        const { data: { publicUrl } } = supabase.storage
          .from('invoice-files')
          .getPublicUrl(path);
        fileUrl = publicUrl;
      } else {
        console.warn('Storage upload failed (bucket "invoice-files" may not exist):', uploadErr.message);
      }
    } catch (e) {
      console.warn('Storage upload exception (non-fatal):', e);
    }

    // Generate internal accounting reference
    const yearMonth = extracted.date ? extracted.date.substring(0, 7).replace('-', '') : new Date().toISOString().substring(0, 7).replace('-', '');
    const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const accountingRef = `FAC-${yearMonth}-${randSuffix}`;

    let invoice: any = null;
    let invError: any = null;

    // Try inserting with accounting columns first (fallback if they are not in DB yet)
    try {
      const { data, error } = await supabase
        .from('invoices')
        .insert({
          supplier_id: supplierId,
          invoice_number: extracted.numero_facture,
          date: extracted.date,
          total_ht: extracted.total_ht,
          total_ttc: extracted.total_ttc,
          pdf_url: fileUrl,
          accounting_ref: accountingRef,
          accounting_class: extracted.compte_comptable || '601',
          type_document: extracted.type_document || 'facture',
          company_name_present: extracted.nom_entreprise_present ?? true,
          tva_recoverable: extracted.tva_recoverable ?? true,
        })
        .select('id')
        .single();
      invoice = data;
      invError = error;
    } catch (e) {
      console.warn("DB lacks accounting columns on invoices table. Falling back...", e);
    }

    // If failed, retry with legacy schema
    if (invError || !invoice) {
      const { data, error } = await supabase
        .from('invoices')
        .insert({
          supplier_id: supplierId,
          invoice_number: extracted.numero_facture,
          date: extracted.date,
          total_ht: extracted.total_ht,
          total_ttc: extracted.total_ttc,
          pdf_url: fileUrl,
        })
        .select('id')
        .single();
      invoice = data;
      invError = error;
    }

    if (invError || !invoice) {
      return NextResponse.json({ error: 'Erreur insertion facture', details: invError }, { status: 500 });
    }

    // Insert lines
    if (extracted.lignes?.length) {
      const lines = extracted.lignes.map((l: {
        designation: string;
        quantite: number;
        unite: string;
        prix_unitaire_ht: number;
        prix_total_ht: number;
        categorie: string;
      }) => ({
        invoice_id: invoice.id,
        designation: l.designation,
        quantity: l.quantite,
        unit: l.unite,
        unit_price_ht: l.prix_unitaire_ht,
        total_ht: l.prix_total_ht,
        category: l.categorie,
      }));
      await supabase.from('invoice_lines').insert(lines);

      // Update or create ingredient prices
      for (const l of extracted.lignes) {
        if (l.categorie === 'alimentaire' || l.categorie === 'boisson') {
          const { data: ingredient } = await supabase
            .from('ingredients')
            .select('id')
            .ilike('name', `%${l.designation}%`)
            .limit(1)
            .single();

          if (ingredient) {
            await supabase
              .from('ingredients')
              .update({ last_unit_price: l.prix_unitaire_ht, last_updated: new Date().toISOString() })
              .eq('id', ingredient.id);
          } else {
            // Auto-create new ingredient
            await supabase
              .from('ingredients')
              .insert({
                name: l.designation,
                unit: l.unite || 'kg',
                last_unit_price: l.prix_unitaire_ht,
                last_updated: new Date().toISOString(),
              });
          }
        }
      }
    }

    // Auto-Reconciliation with Bank Transactions
    // Look for a bank transaction within +/- 10 days with a matching amount
    const targetAmount = -Math.abs(extracted.total_ttc);
    const invoiceDate = new Date(extracted.date);
    const minDate = new Date(invoiceDate); minDate.setDate(invoiceDate.getDate() - 10);
    const maxDate = new Date(invoiceDate); maxDate.setDate(invoiceDate.getDate() + 10);

    const { data: bankTx } = await supabase
      .from('bank_transactions')
      .select('id')
      .eq('status', 'pending_invoice')
      .gte('amount', targetAmount - 0.5) // Tolerance of 50 cents
      .lte('amount', targetAmount + 0.5)
      .gte('date', minDate.toISOString().split('T')[0])
      .lte('date', maxDate.toISOString().split('T')[0])
      .limit(1)
      .single();

    if (bankTx) {
      const updateData: any = { status: 'reconciled', invoice_id: invoice.id };
      
      try {
        await supabase
          .from('bank_transactions')
          .update({
            ...updateData,
            accounting_class: extracted.compte_comptable || '601',
          })
          .eq('id', bankTx.id);
      } catch (e) {
        console.warn("DB lacks accounting_class on bank_transactions table. Falling back...", e);
        await supabase
          .from('bank_transactions')
          .update(updateData)
          .eq('id', bankTx.id);
      }
    }

    return NextResponse.json({
      success: true,
      invoice_id: invoice.id,
      pdf_url: fileUrl,
      extracted,
      reconciled_tx_id: bankTx?.id,
      accounting_ref: accountingRef
    });
  } catch (error) {
    console.error('Extract error:', error);
    return NextResponse.json({ error: 'Erreur extraction' }, { status: 500 });
  }
}
