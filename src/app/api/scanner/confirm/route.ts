import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  try {
    const {
      extracted,
      file_url,
      bank_tx_id,
      payment_method = 'bank',
      payment_notes,
      associe,
    } = await req.json();

    if (!extracted) {
      return NextResponse.json({ error: 'Données extraites manquantes' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // ── Generate accounting reference ──────────────────────────────────────
    const ym = (extracted.date || new Date().toISOString().slice(0, 10))
      .slice(0, 7).replace('-', '');
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const accountingRef = `FAC-${ym}-${suffix}`;

    // ── Find or create supplier ────────────────────────────────────────────
    let supplierId: string | null = null;
    if (extracted.fournisseur) {
      const { data: found } = await supabase
        .from('suppliers')
        .select('id')
        .ilike('name', `%${extracted.fournisseur}%`)
        .limit(1)
        .single();

      if (found) {
        supplierId = found.id;
      } else {
        const { data: created } = await supabase
          .from('suppliers')
          .insert({ name: extracted.fournisseur })
          .select('id')
          .single();
        supplierId = created?.id ?? null;
      }
    }

    // ── Insert invoice (try extended schema, fallback to base schema) ───────
    let invoice: any = null;

    const baseFields = {
      supplier_id:    supplierId,
      invoice_number: extracted.numero_facture,
      date:           extracted.date,
      total_ht:       extracted.total_ht,
      total_ttc:      extracted.total_ttc,
      pdf_url:        file_url,
      accounting_ref: accountingRef,
    };

    let firstError: any = null;
    let fallbackError: any = null;

    try {
      const { data, error } = await supabase
        .from('invoices')
        .insert({
          ...baseFields,
          accounting_class: extracted.compte_comptable || '601',
          payment_method:   payment_method,
          payment_notes:    payment_notes || null,
          type_document:    extracted.type_document || 'facture',
          company_name_present: extracted.nom_entreprise_present ?? true,
          tva_recoverable:  extracted.tva_recoverable ?? true,
        })
        .select('id')
        .single();
      if (!error) {
        invoice = data;
      } else {
        firstError = error;
        throw error;
      }
    } catch (e) {
      firstError = firstError || e;
      // Fallback: legacy schema without new columns (including accounting_ref)
      try {
        const { data, error } = await supabase
          .from('invoices')
          .insert({
            supplier_id:    supplierId,
            invoice_number: extracted.numero_facture,
            date:           extracted.date,
            total_ht:       extracted.total_ht,
            total_ttc:      extracted.total_ttc,
            pdf_url:        file_url,
          })
          .select('id')
          .single();
        if (!error) {
          invoice = data;
        } else {
          fallbackError = error;
        }
      } catch (err) {
        fallbackError = err;
      }
    }

    if (!invoice) {
      console.error('Invoice insert failed. First attempt:', firstError, 'Fallback attempt:', fallbackError);
      return NextResponse.json({
        error: 'Erreur insertion facture',
        details: {
          firstAttempt: firstError?.message || String(firstError),
          fallbackAttempt: fallbackError?.message || String(fallbackError)
        }
      }, { status: 500 });
    }

    // ── Insert invoice lines ───────────────────────────────────────────────
    if (extracted.lignes?.length) {
      await supabase.from('invoice_lines').insert(
        extracted.lignes.map((l: any) => ({
          invoice_id:     invoice.id,
          designation:    l.designation,
          quantity:       l.quantite,
          unit:           l.unite,
          unit_price_ht:  l.prix_unitaire_ht,
          total_ht:       l.prix_total_ht,
          category:       l.categorie,
        }))
      );
    }

    // ── Create CCA movement if payment method is CB Perso or Cash Perso and associate is specified ──
    if ((payment_method === 'card_perso' || (payment_method === 'cash' && associe)) && associe && invoice) {
      const toISODate = (d: Date) => d.toISOString().split('T')[0];
      const { error: ccaErr } = await supabase
        .from('mouvements_cca')
        .insert({
          date: extracted.date || toISODate(new Date()),
          associe: associe,
          sens: 'apport',
          sous_type: 'facture_payee_perso',
          montant: extracted.total_ttc || extracted.total_ht || 0,
          piece_justif: file_url,
          note: `Règlement ${payment_method === 'cash' ? 'espèces ' : ''}facture ${extracted.numero_facture || ''} (${extracted.fournisseur || 'Inconnu'}) [Scanner]`,
          rapproche_banque: false,
          invoice_id: invoice.id,
        });
      if (ccaErr) {
        console.error('Failed to insert mouvements_cca in scanner API confirm:', ccaErr);
        throw ccaErr;
      }
    }

    // ── Link bank transaction if provided ─────────────────────────────────
    if (bank_tx_id) {
      try {
        const { error } = await supabase
          .from('bank_transactions')
          .update({
            status:          'reconciled',
            invoice_id:      invoice.id,
            accounting_class: extracted.compte_comptable || '601',
          })
          .eq('id', bank_tx_id);
        if (error) throw error;
      } catch {
        // Fallback without accounting_class column
        await supabase
          .from('bank_transactions')
          .update({ status: 'reconciled', invoice_id: invoice.id })
          .eq('id', bank_tx_id);
      }
    }

    return NextResponse.json({
      success:       true,
      invoice_id:    invoice.id,
      accounting_ref: accountingRef,
      reconciled:    !!bank_tx_id,
    });

  } catch (err) {
    console.error('Scanner confirm error:', err);
    return NextResponse.json({ error: 'Erreur confirmation scanner' }, { status: 500 });
  }
}
