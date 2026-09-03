'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, Unlock, ShieldCheck, AlertTriangle, Download } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { monthLabel, recentMonths, isMonthOver } from '@/lib/months';

/**
 * ClosuresPanel — clôturer un mois, le rouvrir, exporter ses chiffres.
 *
 * Un mois clôturé devient lecture seule dans la base (trigger) : c'est ce
 * qui donne un sens au chiffre transmis au cabinet — celui qu'on a validé ne
 * peut plus bouger en silence. La réouverture reste possible, mais motivée
 * et journalisée.
 */

interface Snapshot {
  ca_ht: number; ca_ttc: number; orders: number;
  achats_ht: number; cogs: number; cogs_method: 'inventaire' | 'achats'; stock_variation: number;
  tva_collectee: number; tva_deductible: number; tva_nette: number;
  invoices: number; bank_transactions: number;
}

interface Closure {
  month: string;
  closed_at: string;
  closed_by: string | null;
  snapshot: Snapshot;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
}

interface Blocking { id: string; title: string; action: string }

export default function ClosuresPanel() {
  const [closures, setClosures] = useState<Closure[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<{ month: string; items: Blocking[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const months = recentMonths(today, 12);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/closures');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lecture impossible');
      setClosures(data.closures);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClosures([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closureOf = (month: string) => closures?.find(c => c.month === month && !c.reopened_at) ?? null;
  const reopenedOf = (month: string) => closures?.find(c => c.month === month && c.reopened_at) ?? null;

  const act = async (action: 'close' | 'reopen', month: string) => {
    let reason: string | undefined;
    if (action === 'reopen') {
      const r = prompt(`Rouvrir ${monthLabel(month)} ?\n\nIndique le motif — il sera conservé dans le journal des clôtures (10 caractères au moins).`);
      if (r === null) return;
      reason = r;
    } else if (!confirm(`Clôturer ${monthLabel(month)} ?\n\nPlus aucune facture, écriture bancaire, mouvement de compte courant ou trajet daté de ce mois ne pourra être ajouté, modifié ou supprimé. Les chiffres du mois seront figés pour l'export comptable.`)) {
      return;
    }

    setBusy(month);
    setError(null);
    setBlocking(null);
    try {
      const res = await fetch('/api/closures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, month, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.blocking) setBlocking({ month, items: data.blocking });
        throw new Error(data.error || 'Action impossible');
      }
      await load();
      if (action === 'close') setExpanded(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-header">
        <div>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={18} style={{ color: 'var(--teal)' }} /> Clôtures mensuelles
          </div>
          <div className="card-subtitle">
            Un mois clôturé devient lecture seule : ses chiffres sont ceux transmis au cabinet, et ils ne
            peuvent plus bouger en silence. On ne clôture qu&apos;un mois écoulé, sans point critique ouvert.
          </div>
        </div>
      </div>

      {error && (
        <div className="alert alert-warning" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>
          <AlertTriangle size={16} /> <span>{error}</span>
        </div>
      )}

      {blocking && blocking.items.length > 0 && (
        <div style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(217,79,79,0.06)', border: '1px solid rgba(217,79,79,0.3)', borderRadius: 10, fontSize: 13 }}>
          <strong>À régler avant de clôturer {monthLabel(blocking.month)} :</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {blocking.items.map(b => <li key={b.id}><strong>{b.title}</strong> — {b.action}</li>)}
          </ul>
        </div>
      )}

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Mois</th>
              <th>État</th>
              <th style={{ textAlign: 'right' }}>CA HT</th>
              <th style={{ textAlign: 'right' }}>Coût matières</th>
              <th style={{ textAlign: 'right' }}>TVA nette</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {closures === null ? (
              <tr><td colSpan={6} style={{ color: 'var(--text-muted)' }}>Chargement…</td></tr>
            ) : months.map(month => {
              const closed = closureOf(month);
              const reopened = reopenedOf(month);
              const over = isMonthOver(month, today);
              const snap = closed?.snapshot;
              const isBusy = busy === month;
              return (
                <tr key={month} style={closed ? { background: 'rgba(45,143,94,0.05)' } : undefined}>
                  <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{monthLabel(month)}</td>
                  <td style={{ fontSize: 12 }}>
                    {closed ? (
                      <span style={{ color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <ShieldCheck size={14} /> Clôturé le {new Date(closed.closed_at).toLocaleDateString('fr-FR')}
                        {closed.closed_by ? ` par ${closed.closed_by}` : ''}
                      </span>
                    ) : reopened ? (
                      <span style={{ color: '#92400E' }} title={reopened.reopen_reason ?? ''}>
                        Rouvert le {new Date(reopened.reopened_at!).toLocaleDateString('fr-FR')} — {reopened.reopen_reason}
                      </span>
                    ) : over ? (
                      <span style={{ color: 'var(--text-muted)' }}>Ouvert</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>En cours</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{snap ? formatCurrency(snap.ca_ht) : '—'}</td>
                  <td style={{ textAlign: 'right' }} title={snap ? (snap.cogs_method === 'inventaire' ? 'Mesuré : achats ± variation de stock' : 'Sur achats (pas d\'inventaire aux bornes)') : ''}>
                    {snap ? <>{formatCurrency(snap.cogs)} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{snap.cogs_method === 'inventaire' ? 'mesuré' : 'achats'}</span></> : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: snap && snap.tva_nette < 0 ? 'var(--green)' : undefined }}>
                    {snap ? formatCurrency(snap.tva_nette) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {closed ? (
                      <>
                        <a className="btn btn-secondary btn-sm" href={`/api/export/compta?month=${month}&format=fec`} title="Fichier des écritures comptables (FEC)">
                          <Download size={14} /> FEC
                        </a>{' '}
                        <a className="btn btn-secondary btn-sm" href={`/api/export/compta?month=${month}&format=csv`} title="Journaux en CSV (achats, ventes, banque, OD)">
                          <Download size={14} /> CSV
                        </a>{' '}
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => act('reopen', month)} title="Rouvrir, avec motif">
                          <Unlock size={14} /> Rouvrir
                        </button>{' '}
                        <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === month ? null : month)}>
                          {expanded === month ? 'Masquer' : 'Détail'}
                        </button>
                      </>
                    ) : over ? (
                      <button className="btn btn-primary btn-sm" disabled={isBusy} onClick={() => act('close', month)}>
                        <Lock size={14} /> {isBusy ? 'Contrôle…' : 'Clôturer'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {expanded && closureOf(expanded) && (() => {
        const s = closureOf(expanded)!.snapshot;
        const rows: [string, string][] = [
          ['Chiffre d\'affaires TTC', formatCurrency(s.ca_ttc)],
          ['Chiffre d\'affaires HT', formatCurrency(s.ca_ht)],
          ['Commandes', String(s.orders)],
          ['Achats HT (factures + paiements sans facture)', formatCurrency(s.achats_ht)],
          ['Variation de stock', s.cogs_method === 'inventaire' ? formatCurrency(s.stock_variation) : 'non mesurée'],
          ['Coût matières consommé', `${formatCurrency(s.cogs)} (${s.ca_ht > 0 ? ((s.cogs / s.ca_ht) * 100).toFixed(1) : '—'} % du CA HT)`],
          ['TVA collectée', formatCurrency(s.tva_collectee)],
          ['TVA déductible (factures)', formatCurrency(s.tva_deductible)],
          ['TVA nette', formatCurrency(s.tva_nette)],
          ['Factures / écritures bancaires', `${s.invoices} / ${s.bank_transactions}`],
        ];
        return (
          <div style={{ marginTop: 14, padding: '12px 16px', background: 'var(--cream-light)', borderRadius: 10, fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, textTransform: 'capitalize' }}>{monthLabel(expanded)} — chiffres figés à la clôture</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '4px 24px' }}>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--border-light)', padding: '4px 0' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{k}</span><strong>{v}</strong>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
