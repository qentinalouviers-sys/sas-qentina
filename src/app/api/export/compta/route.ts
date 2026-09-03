import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/api-auth';
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all';
import { monthBounds } from '@/lib/months';
import {
  buildEntries, unbalancedEntries, toFec, toCsv,
  type InvoiceRow, type BankRow, type CcaRow, type OrderRow,
} from '@/lib/fec';

/**
 * Export comptable d'un mois : GET /api/export/compta?month=AAAA-MM&format=fec|csv
 *
 * Quatre journaux (achats, ventes, banque, opérations diverses) au format FEC
 * — celui que tous les logiciels de cabinet importent — ou en CSV pour un
 * tableur. Le fichier FEC est nommé selon la convention SIREN + FEC + date.
 *
 * Un mois non clôturé s'exporte aussi (brouillon pour le cabinet), mais sans
 * date de validation : seule une clôture fige le chiffre.
 */

export const maxDuration = 60;

/** Ligne de facture telle que Supabase la rend : la relation peut arriver en tableau. */
type InvoiceFetched = Omit<InvoiceRow, 'lines' | 'supplier'> & {
  supplier: { name: string | null } | { name: string | null }[] | null;
};

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const month = request.nextUrl.searchParams.get('month') ?? '';
  const format = request.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'fec';

  let start: string, end: string;
  try {
    ({ start, end } = monthBounds(month));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const [orders, invoicesRaw, bank, cca, closureRes, sirenRes] = await Promise.all([
    fetchAllRows<OrderRow>((f0, f1) => supabase.from('square_orders')
      .select('id, service, net_amount, raw_data').gte('service', start).lte('service', end).range(f0, f1)),
    fetchAllRows<InvoiceFetched>((f0, f1) => supabase.from('invoices')
      .select('id, date, invoice_number, accounting_ref, accounting_class, total_ht, total_ttc, tva_recoverable, supplier:suppliers(name)')
      .gte('date', start).lte('date', end).range(f0, f1)),
    fetchAllRows<BankRow>((f0, f1) => supabase.from('bank_transactions')
      .select('id, date, description, amount, category, invoice_id').gte('date', start).lte('date', end).range(f0, f1)),
    fetchAllRows<CcaRow>((f0, f1) => supabase.from('mouvements_cca')
      .select('id, date, associe, sens, sous_type, montant, note, bank_transaction_id, invoice_id')
      .gte('date', start).lte('date', end).range(f0, f1)),
    supabase.from('closures').select('closed_at, reopened_at').eq('month', start).maybeSingle(),
    supabase.from('app_settings').select('value').eq('key', 'siren').maybeSingle(),
  ]);

  // Lignes des factures du mois, pour la ventilation par compte de charge.
  const lines = invoicesRaw.length > 0
    ? await fetchAllRowsIn<{ invoice_id: string; category: string | null; total_ht: number | null }, string>(
        invoicesRaw.map(i => i.id), (ids, f0, f1) => supabase.from('invoice_lines')
          .select('invoice_id, category, total_ht').in('invoice_id', ids).range(f0, f1))
    : [];
  const linesByInvoice = new Map<string, InvoiceRow['lines']>();
  for (const l of lines) {
    const arr = linesByInvoice.get(l.invoice_id) ?? [];
    arr.push({ category: l.category, total_ht: l.total_ht });
    linesByInvoice.set(l.invoice_id, arr);
  }
  const invoices: InvoiceRow[] = invoicesRaw.map(i => ({
    ...i,
    // Supabase rend la relation en objet ou en tableau selon la version : on normalise.
    supplier: Array.isArray(i.supplier) ? (i.supplier[0] ?? null) : i.supplier,
    lines: linesByInvoice.get(i.id) ?? [],
  }));

  const entries = buildEntries({ month, orders, invoices, bank, cca });

  // Une écriture déséquilibrée ne doit jamais partir chez le cabinet.
  const unbalanced = unbalancedEntries(entries);
  if (unbalanced.length > 0) {
    console.error('[Export compta] Écritures déséquilibrées :', unbalanced);
    return NextResponse.json(
      { error: `${unbalanced.length} écriture(s) déséquilibrée(s) — export refusé. Signale-le : c'est un défaut de l'outil, pas de tes données.`, unbalanced },
      { status: 500 },
    );
  }

  const closed = closureRes.data && !closureRes.data.reopened_at;
  const validDate = closed ? String(closureRes.data!.closed_at).slice(0, 10) : null;
  const siren = (sirenRes.data?.value ?? '').replace(/\D/g, '') || '000000000';

  if (format === 'csv') {
    return new NextResponse(toCsv(entries), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="qentina-ecritures-${month}.csv"`,
      },
    });
  }

  return new NextResponse(toFec(entries, validDate), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${siren}FEC${end.replace(/-/g, '')}.txt"`,
      // Utile au cabinet : le fichier est-il définitif ?
      'X-Qentina-Closed': closed ? 'yes' : 'no',
    },
  });
}
