'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, KeyRound, Trash2, Plus, Copy, AlertTriangle, Check, Terminal } from 'lucide-react';

/**
 * AgentKeysPanel — clés d'accès pour les agents IA, et journal de leurs appels.
 *
 * Une clé n'est affichée QU'UNE fois, à sa création : la base n'en garde que
 * l'empreinte. C'est ce qui fait qu'une fuite de la base ne livre aucune clé
 * utilisable — et c'est aussi pourquoi l'écran doit le dire franchement au
 * moment où il l'affiche, plutôt que de laisser découvrir la contrainte plus
 * tard, clé perdue.
 */

interface AgentKey {
  id: string;
  name: string;
  key_hint: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface AgentCall {
  at: string;
  key_name: string | null;
  tool: string;
  scope: string | null;
  ok: boolean;
  error_code: string | null;
  duration_ms: number | null;
}

export default function AgentKeysPanel() {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [calls, setCalls] = useState<AgentCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [creating, setCreating] = useState(false);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/agent-keys');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Lecture impossible');
      setKeys(body.keys ?? []);
      setCalls(body.recentCalls ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!name.trim()) { setError('Donne un nom à la clé.'); return; }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/agent-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), write }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Création impossible');
      setFreshSecret(body.secret);
      setName('');
      setWrite(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: AgentKey) => {
    if (!confirm(`Révoquer « ${key.name} » ? Tout agent qui l'utilise sera coupé immédiatement.`)) return;
    const res = await fetch(`/api/settings/agent-keys?id=${key.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || 'Révocation impossible');
      return;
    }
    await load();
  };

  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bot size={18} style={{ color: 'var(--teal)' }} /> Agents IA
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 8 }}>
          Une clé permet à un agent (Hermes Agent, Claude, un script) d&apos;interroger QENTINA
          sans session : il la porte dans l&apos;en-tête <code>Authorization</code>. Les outils
          disponibles et les règles métier sont décrits sur <code>/api/agent/tools</code>.
          <br />
          <strong>Une clé en lecture seule ne voit même pas les outils d&apos;écriture</strong> :
          c&apos;est le réglage à préférer tant qu&apos;un agent n&apos;a pas besoin d&apos;écrire.
        </div>

        {error && (
          <div className="alert alert-warning" style={{ marginTop: 14 }}>
            <AlertTriangle size={16} /><span>{error}</span>
          </div>
        )}

        {freshSecret && (
          <div className="alert alert-warning" style={{ marginTop: 14, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
              <KeyRound size={16} />
              Copie cette clé maintenant : elle ne sera plus jamais affichée.
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              background: 'var(--bg-subtle, #f5f5f5)', padding: '8px 10px', borderRadius: 8,
              fontFamily: 'ui-monospace, monospace', fontSize: 12.5, wordBreak: 'break-all',
            }}>
              <span style={{ flex: 1 }}>{freshSecret}</span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(freshSecret);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    setError('Copie impossible : sélectionne la clé à la main.');
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copiée' : 'Copier'}
              </button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setFreshSecret(null)}>J&apos;ai copié la clé</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16 }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label className="form-label">Nom de la clé</label>
            <input
              type="text" className="form-input" value={name}
              placeholder="Hermes Agent — poste cuisine"
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Portée</label>
            <select className="form-select" value={write ? 'write' : 'read'} onChange={e => setWrite(e.target.value === 'write')}>
              <option value="read">Lecture seule</option>
              <option value="write">Lecture + écriture</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={create} disabled={creating}>
            <Plus size={16} /> {creating ? 'Création…' : 'Créer la clé'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><div className="card-title">Clés existantes</div></div>
        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Chargement…</div>
        ) : keys.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Aucune clé. Aucun agent ne peut donc accéder aux données.</div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Nom</th><th>Clé</th><th>Portée</th><th>Créée</th><th>Dernier usage</th><th></th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                    <td style={{ fontWeight: 600 }}>
                      {k.name}
                      {k.revoked_at && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--red)' }}>révoquée</span>}
                    </td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{k.key_hint}</td>
                    <td style={{ fontSize: 12 }}>{k.scopes.includes('write') ? 'lecture + écriture' : 'lecture seule'}</td>
                    <td style={{ fontSize: 12 }}>{String(k.created_at).slice(0, 10)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {k.last_used_at ? String(k.last_used_at).slice(0, 10) : 'jamais'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!k.revoked_at && (
                        <button className="btn btn-ghost btn-sm" onClick={() => revoke(k)} title="Révoquer">
                          <Trash2 size={15} style={{ color: 'var(--red)' }} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={16} /> Brancher Hermes Agent
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Une fois la clé créée, côté poste :
        </div>
        <pre style={{
          background: 'var(--bg-subtle, #f5f5f5)', padding: 12, borderRadius: 8, overflowX: 'auto',
          fontSize: 12, marginTop: 10, lineHeight: 1.5,
        }}>{`echo 'QENTINA_AGENT_KEY=qk_live_…' >> ~/.hermes/.env
hermes mcp add qentina --url "${appUrl}/api/agent/mcp" --auth header
hermes mcp test qentina`}</pre>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Le dossier <code>agent/skills/qentina-gestion/</code> du dépôt contient le skill à copier
          dans <code>~/.hermes/skills/</code> : il apprend à l&apos;agent les règles métier (compte
          courant jamais débiteur, mois clôturé en lecture seule, barème progressif).
        </div>
      </div>

      <div className="card">
        <div className="card-header"><div className="card-title">Derniers appels d&apos;agents</div></div>
        {calls.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Aucun appel enregistré.</div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr><th>Quand</th><th>Clé</th><th>Outil</th><th>Portée</th><th>Résultat</th></tr>
              </thead>
              <tbody>
                {calls.map((c, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{String(c.at).slice(0, 16).replace('T', ' ')}</td>
                    <td style={{ fontSize: 12 }}>{c.key_name ?? '—'}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{c.tool}</td>
                    <td style={{ fontSize: 12, color: c.scope === 'write' ? 'var(--orange)' : 'var(--text-muted)' }}>
                      {c.scope === 'write' ? 'écriture' : 'lecture'}
                    </td>
                    <td style={{ fontSize: 12, color: c.ok ? 'var(--green)' : 'var(--red)' }}>
                      {c.ok ? `ok (${c.duration_ms ?? '?'} ms)` : c.error_code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
