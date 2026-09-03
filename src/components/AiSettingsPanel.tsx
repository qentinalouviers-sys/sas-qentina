'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save, Trash2, Plug, ShieldCheck, AlertTriangle, KeyRound } from 'lucide-react';

/**
 * AiSettingsPanel — saisie des clés API des moteurs IA et choix de l'OCR.
 *
 * Une clé saisie ici part vers /api/settings/ai et n'en revient jamais :
 * l'écran ne connaît que son empreinte (quatre derniers caractères). Un champ
 * rempli n'est donc pas la clé enregistrée, c'est une clé en cours de saisie.
 */

interface SettingState {
  key: string;
  source: 'base' | 'environnement' | 'absent';
  configured: boolean;
  hint: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface SettingsPayload {
  encryption_ready: boolean;
  settings: SettingState[];
}

interface TestResult {
  success: boolean;
  model?: string;
  latency_ms?: number;
  error?: string;
}

const SECRETS = [
  {
    key: 'gemini_api_key',
    label: 'Google Gemini',
    role: "Lecture des factures (OCR). C'est le moteur le moins coûteux.",
    where: 'aistudio.google.com/apikey',
    placeholder: 'AIza…',
    provider: 'gemini' as const,
  },
  {
    key: 'anthropic_api_key',
    label: 'Anthropic Claude',
    role: 'Banque, Fuego, audits et chat. Nécessaire même si l’OCR tourne sur Gemini.',
    where: 'console.anthropic.com',
    placeholder: 'sk-ant-…',
    provider: 'anthropic' as const,
  },
];

const SOURCE_LABEL: Record<SettingState['source'], string> = {
  base: 'Saisie dans cet écran',
  environnement: 'Variable Vercel',
  absent: 'Non configurée',
};

export default function AiSettingsPanel() {
  const [state, setState] = useState<SettingsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/ai');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lecture impossible');
      setState(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const find = (key: string) => state?.settings.find(s => s.key === key);

  const save = async (key: string, value: string) => {
    setBusy(key);
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enregistrement impossible');
      setState(data);
      setDrafts(d => ({ ...d, [key]: '' }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (key: string) => {
    // La suppression n'est pas anodine : la variable Vercel reprend la main,
    // et elle peut contenir une autre clé que celle qu'on croit.
    if (!confirm('Supprimer cette clé ? L’application repassera sur la variable d’environnement Vercel si elle existe.')) return;
    setBusy(key);
    try {
      const res = await fetch(`/api/settings/ai?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Suppression impossible');
      setState(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async (provider: 'gemini' | 'anthropic') => {
    setBusy(`test_${provider}`);
    setTests(t => ({ ...t, [provider]: { success: false, error: 'Test en cours…' } }));
    try {
      const res = await fetch('/api/settings/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const payload: TestResult = await res.json();
      setTests(t => ({ ...t, [provider]: payload }));
    } catch (e) {
      setTests(t => ({ ...t, [provider]: { success: false, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setBusy(null);
    }
  };

  if (!state) {
    return (
      <div className="card">
        <div style={{ padding: 20, color: 'var(--text-muted)' }}>
          {error ? `Réglages illisibles : ${error}` : 'Chargement des réglages…'}
        </div>
      </div>
    );
  }

  const ocrProvider = find('ocr_provider')?.hint || 'gemini';
  const geminiModel = find('gemini_model')?.hint || '';

  return (
    <>
      {!state.encryption_ready && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--orange, #E89B3E)' }}>
          <div style={{ padding: '16px 0', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} style={{ color: 'var(--orange, #E89B3E)', flexShrink: 0 }} />
            <div>
              <strong>Chiffrement non configuré</strong>
              <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
                Impossible d’enregistrer une clé ici tant que la variable{' '}
                <code>SETTINGS_ENCRYPTION_KEY</code> n’existe pas dans Vercel. Générez-la une
                seule fois avec <code>openssl rand -hex 32</code>, ajoutez-la, puis redéployez.
                Ne la changez plus ensuite : les clés déjà enregistrées deviendraient illisibles.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--red, #D94F4F)' }}>
          <div style={{ padding: '14px 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{error}</div>
        </div>
      )}

      {/* ── Moteur d'OCR ────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div>
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Plug size={20} style={{ color: 'var(--teal)' }} />
              Moteur de lecture des factures
            </div>
            <div className="card-subtitle">
              Le scanner lit les factures avec ce moteur. Le reste de l’application
              (banque, Fuego, audits, chat) reste sur Claude dans tous les cas.
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 0 0', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 220 }}>
            <label className="form-label">Moteur</label>
            <select
              className="form-select"
              value={ocrProvider}
              disabled={busy === 'ocr_provider'}
              onChange={e => save('ocr_provider', e.target.value)}
            >
              <option value="gemini">Google Gemini — le moins cher</option>
              <option value="anthropic">Anthropic Claude</option>
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: 0, minWidth: 260 }}>
            <label className="form-label">Modèle Gemini</label>
            <input
              className="form-input"
              placeholder="gemini-2.5-flash (par défaut)"
              value={drafts.gemini_model ?? geminiModel}
              onChange={e => setDrafts(d => ({ ...d, gemini_model: e.target.value }))}
            />
          </div>
          <button
            className="btn btn-secondary"
            disabled={busy === 'gemini_model' || !(drafts.gemini_model ?? '').trim()}
            onClick={() => save('gemini_model', drafts.gemini_model ?? '')}
          >
            <Save size={16} /> Appliquer le modèle
          </button>
        </div>
      </div>

      {/* ── Clés API ────────────────────────────────────────────────────── */}
      {SECRETS.map(secret => {
        const current = find(secret.key);
        const draft = drafts[secret.key] ?? '';
        const result = tests[secret.provider];

        return (
          <div className="card" key={secret.key} style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <KeyRound size={20} style={{ color: 'var(--text-muted)' }} />
                  {secret.label}
                </div>
                <div className="card-subtitle">{secret.role}</div>
              </div>
            </div>

            <div style={{ padding: '16px 0 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
                {current?.configured ? (
                  <ShieldCheck size={16} style={{ color: 'var(--green, #2D8F5E)' }} />
                ) : (
                  <AlertTriangle size={16} style={{ color: 'var(--orange, #E89B3E)' }} />
                )}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {current?.configured
                    ? `${SOURCE_LABEL[current.source]}${current.hint ? ` — ${current.hint}` : ''}`
                    : 'Aucune clé disponible'}
                </span>
                {current?.updated_at && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    · modifiée le {new Date(current.updated_at).toLocaleDateString('fr-FR')}
                    {current.updated_by ? ` par ${current.updated_by}` : ''}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ marginBottom: 0, flex: '1 1 320px' }}>
                  <label className="form-label">
                    {current?.source === 'base' ? 'Remplacer la clé' : 'Coller la clé'}
                  </label>
                  <input
                    className="form-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={secret.placeholder}
                    value={draft}
                    onChange={e => setDrafts(d => ({ ...d, [secret.key]: e.target.value }))}
                  />
                </div>

                <button
                  className="btn btn-primary"
                  disabled={!draft.trim() || busy === secret.key || !state.encryption_ready}
                  onClick={() => save(secret.key, draft)}
                >
                  <Save size={16} /> {busy === secret.key ? 'Enregistrement…' : 'Enregistrer'}
                </button>

                <button
                  className="btn btn-secondary"
                  disabled={!current?.configured || busy === `test_${secret.provider}`}
                  onClick={() => test(secret.provider)}
                >
                  <Plug size={16} /> {busy === `test_${secret.provider}` ? 'Test…' : 'Tester'}
                </button>

                {current?.source === 'base' && (
                  <button
                    className="btn btn-secondary"
                    style={{ color: 'var(--red, #D94F4F)' }}
                    disabled={busy === secret.key}
                    onClick={() => remove(secret.key)}
                  >
                    <Trash2 size={16} /> Supprimer
                  </button>
                )}
              </div>

              <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                Clé à créer sur <strong>{secret.where}</strong>. Elle est chiffrée avant
                enregistrement et ne peut plus être relue depuis cet écran — seulement remplacée.
              </p>

              {result && (
                <div
                  style={{
                    marginTop: 14,
                    padding: '10px 12px',
                    borderRadius: 8,
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    background: result.success ? 'rgba(45, 143, 94, 0.1)' : 'rgba(217, 79, 79, 0.08)',
                    color: result.success ? 'var(--green, #2D8F5E)' : 'var(--red, #D94F4F)',
                  }}
                >
                  {result.success
                    ? `Clé valide — ${result.model} a répondu en ${result.latency_ms} ms.`
                    : result.error}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
