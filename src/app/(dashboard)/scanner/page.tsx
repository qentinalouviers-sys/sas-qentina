'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  ScanLine, Camera, Upload, CheckCircle, AlertCircle, XCircle,
  Loader2, Banknote, CreditCard, Link2, Download, X, Info,
  RotateCcw, FileText, Sparkles, ChevronDown, ChevronUp,
  ArrowRight, Search, Clock,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate } from '@/lib/utils';
import ClaudeStatusIndicator from '@/components/ClaudeStatusIndicator';
import type { InvoiceAnomaly } from '@/lib/invoice-checks';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedData {
  fournisseur: string;
  date: string;
  numero_facture: string | null;
  total_ht: number;
  total_ttc: number;
  tva?: number;
  compte_comptable: string;
  type_document: string;
  lignes: any[];
}

interface BankCandidate {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: string;
  score: number;
  amount_diff: number;
  date_diff: number;
}

interface ScanResult {
  extracted: ExtractedData;
  file_url: string | null;
  is_duplicate: boolean;
  duplicate_invoice: any | null;
  bank_candidates: BankCandidate[];
  match_confidence: 'high' | 'medium' | 'low' | 'none';
  /** Points à vérifier avant d'enregistrer (voir lib/invoice-checks.ts). */
  anomalies?: InvoiceAnomaly[];
}

type QueueStatus =
  | 'pending' | 'reading' | 'uploading' | 'analyzing'
  | 'matching' | 'complete' | 'error' | 'duplicate';

interface QueueItem {
  id: string;
  file: File;
  preview: string | null;
  status: QueueStatus;
  progress: number;
  step: string;
  result: ScanResult | null;
  error: string | null;
  // User action state
  actionTaken: boolean;
  selectedBankTxId: string | null;
  /** Renseigné par confirmAction ; jamais lu avant la confirmation. */
  paymentMethod?: 'bank' | 'cash' | 'card_perso';
  associe?: 'justine' | 'yohan' | null;
  confirmedRef: string | null;
  showCandidates: boolean;
  showManualSelector: boolean;
  files?: File[];
}

interface MultiPageFile {
  file: File;
  /** Object URL créée à l'ajout du fichier, révoquée à la suppression/reset. */
  previewUrl: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_QUEUE = 5;
const TERMINAL: QueueStatus[] = ['complete', 'error', 'duplicate'];

const STATUS_LABEL: Record<QueueStatus, string> = {
  pending:   'En attente',
  reading:   'Lecture',
  uploading: 'Envoi',
  analyzing: 'Analyse IA',
  matching:  'Rapprochement',
  complete:  'Terminé',
  error:     'Erreur',
  duplicate: 'Doublon',
};

// Étapes de progression affichées en points — libellés partagés via STATUS_LABEL.
const PROGRESS_STEPS: QueueStatus[] = ['reading', 'uploading', 'analyzing', 'matching'];
const STEP_ORDER: QueueStatus[] = ['pending', ...PROGRESS_STEPS, 'complete'];

const ACCOUNTING_LABELS: Record<string, string> = {
  '601': '601 — Matières Premières',
  '607': '607 — Marchandises (Boissons)',
  '606': '606 — Fournitures & Emballages',
  '6061':'6061 — Énergie',
  '61':  '61 — Services extérieurs',
  '62':  '62 — Autres services',
  '63':  '63 — Impôts & Taxes',
  '64':  '64 — Personnel',
  'autre':'Autre',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtSize = (b: number) =>
  b < 1024 ? `${b} o`
  : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko`
  : `${(b / 1048576).toFixed(1)} Mo`;

const readBase64 = (file: File): Promise<{ base64: string; preview: string | null }> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      const full = e.target?.result as string;
      res({ base64: full.split(',')[1], preview: file.type.startsWith('image/') ? full : null });
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });

function accentFor(item: QueueItem): string {
  if (item.status === 'error')     return 'var(--red)';
  if (item.status === 'duplicate') return '#D97706';
  if (item.status === 'complete') {
    if (item.actionTaken)                          return 'var(--green)';
    if (item.result?.match_confidence === 'high')  return 'var(--green)';
    if ((item.result?.bank_candidates?.length ?? 0) > 0) return 'var(--orange)';
    return 'var(--text-muted)';
  }
  if (['analyzing','matching'].includes(item.status)) return 'var(--teal)';
  if (['reading','uploading'].includes(item.status))  return '#7C3AED';
  return 'var(--border)';
}

// ─── QueueCard component ──────────────────────────────────────────────────────

interface CardProps {
  item: QueueItem;
  isActive: boolean;
  onRemove: () => void;
  onConfirm: (
    id: string, bankId: string | null, pm: 'bank'|'cash'|'card_perso',
    associe: 'justine' | 'yohan' | undefined, confirmations: string[],
  ) => Promise<void>;
  onToggleCandidates: () => void;
  onToggleManual: () => Promise<void>;
  bankTxList: any[];
}

function QueueCard({ item, isActive, onRemove, onConfirm, onToggleCandidates, onToggleManual, bankTxList }: CardProps) {
  const [txSearch, setTxSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showCcaSelector, setShowCcaSelector] = useState(false);
  const [showCashSelector, setShowCashSelector] = useState(false);
  // Points inhabituels que l'utilisateur a cochés « j'ai vérifié ». Tant que
  // tous ne le sont pas, les boutons d'enregistrement n'apparaissent pas :
  // le contrôle humain est exigé, pas suggéré.
  const [acked, setAcked] = useState<Set<string>>(() => new Set());

  const anomalies  = item.result?.anomalies ?? [];
  const blocking   = anomalies.filter(a => a.level === 'bloquant');
  const toConfirm  = anomalies.filter(a => a.level === 'a_confirmer');
  const canAct     = blocking.length === 0 && toConfirm.every(a => acked.has(a.code));

  const isTerminal = TERMINAL.includes(item.status);
  const canRemove  = (item.status === 'pending' || isTerminal) && !item.actionTaken;
  const accent     = accentFor(item);

  const filteredTx = bankTxList.filter(tx => {
    if (!txSearch) return true;
    const s = txSearch.toLowerCase();
    return tx.description?.toLowerCase().includes(s) ||
           String(Math.abs(tx.amount)).includes(s);
  });

  const doConfirm = async (bankId: string | null, pm: 'bank'|'cash'|'card_perso', associe?: 'justine' | 'yohan') => {
    setConfirming(true);
    await onConfirm(item.id, bankId, pm, associe, Array.from(acked));
    setConfirming(false);
  };

  // Step dots
  const stepIdx = STEP_ORDER.indexOf(item.status);
  const currentStep = PROGRESS_STEPS[Math.max(0, stepIdx - 1)];

  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--border)',
      borderLeft: `4px solid ${accent}`,
      borderRadius: 16,
      overflow: 'hidden',
      boxShadow: isActive ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      transition: 'box-shadow 0.2s',
    }}>

      {/* ── Header row ───────────────────────────────────────────────── */}
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>

        {/* Thumbnail / icon */}
        {item.preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL locale, incompatible next/image
          <img src={item.preview} alt="" style={{
            width: 52, height: 52, borderRadius: 10, objectFit: 'cover',
            border: '1px solid var(--border-light)', flexShrink: 0,
          }} />
        ) : (
          <div style={{
            width: 52, height: 52, borderRadius: 10, background: 'var(--cream-light)',
            border: '1px solid var(--border-light)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--text-muted)',
          }}>
            <FileText size={22} />
          </div>
        )}

        {/* File info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.file.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {fmtSize(item.file.size)}
            {item.result?.extracted?.fournisseur && (
              <> · <strong style={{ color: 'var(--text-secondary)' }}>{item.result.extracted.fournisseur}</strong></>
            )}
            {item.result?.extracted?.total_ttc != null && (
              <> · <strong style={{ color: 'var(--red)' }}>{formatCurrency(item.result.extracted.total_ttc)}</strong></>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
          background: `${accent}18`, color: accent,
          fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 100,
          whiteSpace: 'nowrap',
        }}>
          {isActive && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
          {item.status === 'complete' && item.actionTaken && <CheckCircle size={11} />}
          {item.status === 'error'     && <XCircle size={11} />}
          {item.status === 'duplicate' && <Info size={11} />}
          {item.status === 'pending'   && <Clock size={11} />}
          {STATUS_LABEL[item.status]}
        </div>

        {/* Remove */}
        {canRemove && (
          <button onClick={onRemove} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', padding: 4, flexShrink: 0, lineHeight: 1,
          }}>
            <X size={16} />
          </button>
        )}
      </div>

      {/* ── Progress bar ─────────────────────────────────────────────── */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.step}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: accent }}>{item.progress}%</span>
        </div>
        <div style={{ height: 6, background: 'var(--cream-dark)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${item.progress}%`,
            transition: 'width 0.35s ease',
            background:
              item.status === 'error'     ? 'var(--red)'
              : item.status === 'duplicate' ? '#D97706'
              : item.status === 'complete' && item.actionTaken ? 'var(--green)'
              : 'linear-gradient(90deg, var(--teal-light), var(--teal))',
          }} />
        </div>

        {/* Step dots (only when not terminal) */}
        {!isTerminal && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
            {PROGRESS_STEPS.map((s, i) => {
              const done   = stepIdx > i + 1;
              const active = stepIdx === i + 1;
              return (
                <div key={s} style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: done ? 'var(--green)' : active ? 'var(--teal)' : 'var(--border)',
                  opacity: active ? 1 : done ? 0.9 : 0.4,
                  animation: active ? 'pulse 1s ease-in-out infinite' : undefined,
                }} />
              );
            })}
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
              {currentStep ? STATUS_LABEL[currentStep] : 'En attente...'}
            </span>
          </div>
        )}
      </div>

      {/* ── Result panel ─────────────────────────────────────────────── */}
      {isTerminal && (
        <div style={{ borderTop: '1px solid var(--border-light)', padding: '14px 16px' }}>

          {/* ERROR */}
          {item.status === 'error' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <XCircle size={18} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Erreur d'analyse</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{item.error}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={onRemove} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <RotateCcw size={12} /> Retirer
              </button>
            </div>
          )}

          {/* DUPLICATE */}
          {item.status === 'duplicate' && item.result && (
            <div style={{ background: 'rgba(217,119,6,0.07)', borderRadius: 10, padding: 12, border: '1px solid rgba(217,119,6,0.2)' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#92400E', marginBottom: 6 }}>⚠️ Doublon détecté</div>
              <div style={{ fontSize: 12, color: '#B45309', lineHeight: 1.5 }}>
                Cette facture est déjà enregistrée dans le système.
                {item.result.duplicate_invoice?.accounting_ref && (
                  <> Référence existante : <strong style={{ fontFamily: 'monospace' }}>{item.result.duplicate_invoice.accounting_ref}</strong></>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Link href="/factures" className="btn btn-ghost btn-sm" style={{ fontSize: 12, gap: 5, display: 'flex', alignItems: 'center' }}>
                  <FileText size={12} /> Voir les factures
                </Link>
                <button className="btn btn-ghost btn-sm" onClick={onRemove} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Ignorer
                </button>
              </div>
            </div>
          )}

          {/* COMPLETE — action taken → success */}
          {item.status === 'complete' && item.actionTaken && (
            <div style={{ background: 'rgba(45,143,94,0.07)', borderRadius: 10, padding: 14, border: '1px solid rgba(45,143,94,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <CheckCircle size={16} style={{ color: 'var(--green)' }} />
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>Facture enregistrée</span>
              </div>
              <div style={{ fontSize: 12, color: '#1A5C38', lineHeight: 1.6 }}>
                Référence : <strong style={{ fontFamily: 'monospace' }}>{item.confirmedRef}</strong>
                <br />
                {item.selectedBankTxId
                  ? '✅ Rapprochée à une transaction bancaire'
                  : item.paymentMethod === 'cash'
                  ? (item.associe
                    ? `💸 Réglée en espèces par ${item.associe.charAt(0).toUpperCase() + item.associe.slice(1)} (apport CCA enregistré)`
                    : '💸 Réglée en espèces entreprise (comptabilisée sans transaction bancaire)')
                  : `💳 Réglée par CB personnelle de ${item.associe ? item.associe.charAt(0).toUpperCase() + item.associe.slice(1) : "l'associé"} (apport CCA enregistré)`}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <Link href="/factures" className="btn btn-secondary btn-sm" style={{ fontSize: 12, gap: 6, display: 'flex', alignItems: 'center' }}>
                  <FileText size={13} /> Voir les factures
                </Link>
                {item.result?.file_url && (
                  <a
                    href={item.result.file_url}
                    target="_blank" rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12, gap: 6, display: 'flex', alignItems: 'center' }}
                  >
                    <Download size={13} /> Télécharger le fichier
                  </a>
                )}
              </div>
            </div>
          )}

          {/* COMPLETE — needs action */}
          {item.status === 'complete' && !item.actionTaken && item.result && (
            <div>
              {/* Extracted data summary */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                gap: 8, padding: 12, background: 'var(--cream-light)', borderRadius: 10, marginBottom: 14,
              }}>
                <DataPill label="Fournisseur" value={item.result.extracted.fournisseur || '—'} />
                <DataPill label="Date" value={item.result.extracted.date ? formatDate(item.result.extracted.date) : '—'} />
                <DataPill label="Montant TTC" value={formatCurrency(item.result.extracted.total_ttc)} valueColor="var(--red)" />
                <DataPill
                  label="Compte"
                  value={ACCOUNTING_LABELS[item.result.extracted.compte_comptable] || item.result.extracted.compte_comptable || '—'}
                  valueColor="var(--teal)"
                />
                {item.result.extracted.numero_facture && (
                  <DataPill label="N° Facture" value={item.result.extracted.numero_facture} mono />
                )}
              </div>

              {/* ── Points à vérifier avant d'enregistrer ── */}
              {anomalies.length > 0 && (
                <AnomalyPanel
                  anomalies={anomalies}
                  acked={acked}
                  onToggle={code => setAcked(prev => {
                    const next = new Set(prev);
                    if (next.has(code)) next.delete(code); else next.add(code);
                    return next;
                  })}
                  onRemove={onRemove}
                />
              )}

              {canAct && (<>
              {/* ── HIGH confidence match ── */}
              {item.result.match_confidence === 'high' && item.result.bank_candidates.length > 0 && (
                <div style={{
                  background: 'rgba(45,143,94,0.06)', border: '1.5px solid rgba(45,143,94,0.25)',
                  borderRadius: 12, padding: 14, marginBottom: 12,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle size={14} /> Transaction bancaire trouvée — haute confiance
                  </div>
                  <CandidateRow c={item.result.bank_candidates[0]} />
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', display: 'flex', gap: 8, padding: '11px', marginTop: 10 }}
                    disabled={confirming}
                    onClick={() => doConfirm(item.result!.bank_candidates[0].id, 'bank')}
                  >
                    {confirming ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={15} />}
                    Confirmer le rapprochement
                  </button>
                </div>
              )}

              {/* ── MEDIUM / LOW confidence ── */}
              {(item.result.match_confidence === 'medium' || item.result.match_confidence === 'low') && item.result.bank_candidates.length > 0 && (
                <div style={{
                  background: 'rgba(232,155,62,0.06)', border: '1.5px solid rgba(232,155,62,0.25)',
                  borderRadius: 12, padding: 14, marginBottom: 12,
                }}>
                  <button
                    onClick={onToggleCandidates}
                    style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0 }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#B45309', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertCircle size={14} />
                      {item.result.bank_candidates.length} correspondance{item.result.bank_candidates.length > 1 ? 's' : ''} possible{item.result.bank_candidates.length > 1 ? 's' : ''}
                    </span>
                    {item.showCandidates ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {item.showCandidates && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {item.result.bank_candidates.map(c => (
                        <CandidateRow
                          key={c.id}
                          c={c}
                          compact
                          action={
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={confirming}
                              onClick={() => doConfirm(c.id, 'bank')}
                              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <Link2 size={12} /> Lier
                            </button>
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── No match info ── */}
              {item.result.match_confidence === 'none' && (
                <div style={{
                  background: 'var(--cream-light)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '10px 14px', marginBottom: 12,
                  fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <Info size={14} /> Aucune transaction bancaire correspondante trouvée pour cette période
                </div>
              )}

              {/* ── Action buttons ── */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: (item.showManualSelector || showCcaSelector || showCashSelector) ? 12 : 0 }}>
                <button
                  className="btn btn-ghost"
                  style={{ flex: '1 1 130px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '10px 12px', border: '1px solid var(--border)' }}
                  onClick={() => {
                    onToggleManual();
                    setShowCcaSelector(false);
                    setShowCashSelector(false);
                  }}
                >
                  <Search size={13} /> Sélectionner manuellement
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ flex: '1 1 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '10px 12px', background: 'rgba(45,143,94,0.08)', color: 'var(--green)', border: '1px solid rgba(45,143,94,0.25)' }}
                  disabled={confirming}
                  onClick={() => {
                    setShowCashSelector(!showCashSelector);
                    setShowCcaSelector(false);
                  }}
                >
                  <Banknote size={13} /> Espèces
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ flex: '1 1 110px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, padding: '10px 12px', background: 'rgba(124,58,237,0.08)', color: '#7C3AED', border: '1px solid rgba(124,58,237,0.25)' }}
                  disabled={confirming}
                  onClick={() => {
                    setShowCcaSelector(!showCcaSelector);
                    setShowCashSelector(false);
                  }}
                >
                  <CreditCard size={13} /> CB Personnelle
                </button>
              </div>

              {showCashSelector && (
                <div style={{
                  marginTop: 10,
                  marginBottom: 10,
                  padding: 12,
                  background: 'rgba(45, 143, 94, 0.05)',
                  border: '1.5px dashed rgba(45, 143, 94, 0.3)',
                  borderRadius: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Info size={12} /> Quel type de règlement en espèces ?
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        doConfirm(null, 'cash');
                        setShowCashSelector(false);
                      }}
                      style={{ flex: '1 1 120px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: 'var(--green)', borderColor: 'rgba(45,143,94,0.3)', cursor: 'pointer', background: 'white' }}
                    >
                      Espèces Entreprise
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        doConfirm(null, 'cash', 'justine');
                        setShowCashSelector(false);
                      }}
                      style={{ flex: '1 1 90px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#EC4899', borderColor: 'rgba(236,72,153,0.3)', cursor: 'pointer', background: 'white' }}
                    >
                      Espèces Justine
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        doConfirm(null, 'cash', 'yohan');
                        setShowCashSelector(false);
                      }}
                      style={{ flex: '1 1 90px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#3B82F6', borderColor: 'rgba(59,130,246,0.3)', cursor: 'pointer', background: 'white' }}
                    >
                      Espèces Yohan
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowCashSelector(false)}
                      style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}

              {showCcaSelector && (
                <div style={{
                  marginTop: 10,
                  marginBottom: 10,
                  padding: 12,
                  background: 'rgba(124, 58, 237, 0.05)',
                  border: '1.5px dashed rgba(124, 58, 237, 0.3)',
                  borderRadius: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#7C3AED', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Info size={12} /> Qui a réglé cette facture ?
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        doConfirm(null, 'card_perso', 'justine');
                        setShowCcaSelector(false);
                      }}
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#EC4899', borderColor: 'rgba(236,72,153,0.3)', cursor: 'pointer', background: 'white' }}
                    >
                      Justine
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        doConfirm(null, 'card_perso', 'yohan');
                        setShowCcaSelector(false);
                      }}
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#3B82F6', borderColor: 'rgba(59,130,246,0.3)', cursor: 'pointer', background: 'white' }}
                    >
                      Yohan
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowCcaSelector(false)}
                      style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}

              {/* ── Manual bank tx selector ── */}
              {item.showManualSelector && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ padding: '10px 12px', background: 'var(--cream-light)', borderBottom: '1px solid var(--border-light)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                      Sélectionner une transaction bancaire à lier
                    </div>
                    <div style={{ position: 'relative' }}>
                      <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                      <input
                        type="text"
                        className="form-input"
                        placeholder="Rechercher par libellé ou montant..."
                        value={txSearch}
                        onChange={e => setTxSearch(e.target.value)}
                        style={{ fontSize: 12, padding: '7px 10px 7px 28px' }}
                      />
                    </div>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {filteredTx.length === 0 ? (
                      <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                        Aucune transaction en attente
                      </div>
                    ) : filteredTx.map(tx => (
                      <div
                        key={tx.id}
                        onClick={() => doConfirm(tx.id, 'bank')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', flexWrap: 'wrap',
                          cursor: 'pointer', borderBottom: '1px solid var(--border-light)',
                          transition: 'background 0.12s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(42,125,123,0.05)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tx.description}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDate(tx.date)}</div>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', flexShrink: 0 }}>
                          {formatCurrency(tx.amount)}
                        </span>
                        <ArrowRight size={13} style={{ color: 'var(--teal)', flexShrink: 0 }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              </>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Small shared sub-components ─────────────────────────────────────────────

/**
 * Ce que l'humain doit regarder avant d'enregistrer.
 *
 * Les bloquants n'ont pas de case : la facture ne peut pas entrer en l'état,
 * il faut la rescanner ou la saisir autrement. Les points à confirmer exigent
 * une coche chacun — pas de « tout accepter », c'est précisément le geste
 * qu'on veut empêcher.
 */
function AnomalyPanel({ anomalies, acked, onToggle, onRemove }: {
  anomalies: InvoiceAnomaly[];
  acked: Set<string>;
  onToggle: (code: string) => void;
  onRemove: () => void;
}) {
  const blocking  = anomalies.filter(a => a.level === 'bloquant');
  const toConfirm = anomalies.filter(a => a.level === 'a_confirmer');
  const remaining = toConfirm.filter(a => !acked.has(a.code)).length;

  return (
    <div style={{
      border: `1px solid ${blocking.length ? 'rgba(217,79,79,0.35)' : 'rgba(232,155,62,0.4)'}`,
      background: blocking.length ? 'rgba(217,79,79,0.05)' : 'rgba(232,155,62,0.07)',
      borderRadius: 10, padding: 12, marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <AlertCircle size={15} style={{ color: blocking.length ? 'var(--red)' : '#B45309', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 800, color: blocking.length ? 'var(--red)' : '#92400E' }}>
          {blocking.length
            ? 'Facture refusée en l\'état'
            : remaining > 0
              ? `${remaining} point${remaining > 1 ? 's' : ''} à vérifier avant d'enregistrer`
              : 'Points vérifiés — tu peux enregistrer'}
        </span>
      </div>

      {blocking.map(a => (
        <div key={a.code} style={{ fontSize: 12, color: '#7F1D1D', lineHeight: 1.5, padding: '6px 0', borderTop: '1px solid rgba(217,79,79,0.15)' }}>
          <strong>{a.message}</strong>
          <div style={{ color: '#991B1B', marginTop: 2 }}>{a.verification}</div>
        </div>
      ))}

      {toConfirm.map(a => (
        <label key={a.code} style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
          fontSize: 12, lineHeight: 1.5, padding: '6px 0', borderTop: '1px solid rgba(232,155,62,0.2)',
          opacity: acked.has(a.code) ? 0.65 : 1,
        }}>
          <input
            type="checkbox"
            checked={acked.has(a.code)}
            onChange={() => onToggle(a.code)}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span>
            <strong style={{ color: '#78350F' }}>{a.message}</strong>
            <div style={{ color: '#92400E', marginTop: 2 }}>{a.verification}</div>
            {acked.has(a.code) && <div style={{ color: 'var(--green)', fontWeight: 700, marginTop: 2 }}>Vérifié</div>}
          </span>
        </label>
      ))}

      {blocking.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={onRemove} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Retirer de la file
          </button>
        </div>
      )}
    </div>
  );
}

function DataPill({ label, value, valueColor, mono }: { label: string; value: string; valueColor?: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: valueColor || 'var(--text-primary)', marginTop: 2, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function CandidateRow({ c, compact, action }: { c: BankCandidate; compact?: boolean; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 10, flexWrap: 'wrap',
      background: 'var(--cream-light)', borderRadius: 10, padding: '10px 12px',
      border: '1px solid var(--border-light)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: compact ? 12 : 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: compact ? 0 : 2 }}>
          {compact
            ? <>{formatDate(c.date)} · {c.date_diff}j d'écart</>
            : <>{formatDate(c.date)} · écart : {c.date_diff} jour{c.date_diff > 1 ? 's' : ''} / {formatCurrency(c.amount_diff)}</>}
        </div>
      </div>
      <span style={{ fontSize: compact ? 13 : 15, fontWeight: compact ? 700 : 800, color: 'var(--red)' }}>{formatCurrency(c.amount)}</span>
      <ScoreBadge score={c.score} />
      {action}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 85 ? { bg: 'rgba(45,143,94,0.15)', color: 'var(--green)' }
    : score >= 55 ? { bg: 'rgba(232,155,62,0.15)', color: '#B45309' }
    : { bg: 'rgba(139,139,139,0.12)', color: 'var(--text-muted)' };
  return (
    <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 100, background: cls.bg, color: cls.color, flexShrink: 0 }}>
      {score}/100
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ScannerPage() {
  const [queue, setQueue]               = useState<QueueItem[]>([]);
  const [isDragging, setIsDragging]     = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [bankTxList, setBankTxList]     = useState<any[]>([]);
  const [bankTxLoaded, setBankTxLoaded] = useState(false);

  const [multiPageMode, setMultiPageMode] = useState(false);
  const [multiPageFiles, setMultiPageFiles] = useState<MultiPageFile[]>([]);

  const isProcessingRef  = useRef(false);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraRef        = useRef<HTMLInputElement>(null);
  const fileRef          = useRef<HTMLInputElement>(null);
  const supabase         = createClient();

  // Nettoyage du timer de progression au démontage du composant
  useEffect(() => () => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
  }, []);

  // ── Queue helpers ──────────────────────────────────────────────────────────
  const setItem = useCallback((id: string, upd: Partial<QueueItem>) => {
    setQueue(prev => prev.map(i => i.id === id ? { ...i, ...upd } : i));
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const valid = Array.from(files)
      .filter(f =>
        /^(application\/pdf|image\/(jpeg|jpg|png|webp))$/.test(f.type) ||
        /\.(pdf|jpg|jpeg|png|webp)$/i.test(f.name)
      );

    if (multiPageMode) {
      // Object URL créée une seule fois à l'ajout (révoquée à la suppression/reset)
      const pages: MultiPageFile[] = valid.map(file => ({
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }));
      setMultiPageFiles(prev => [...prev, ...pages]);
    } else {
      setQueue(prev => {
        const remaining = MAX_QUEUE - prev.length;
        if (remaining <= 0) return prev;
        const sliced = valid.slice(0, remaining);
        const items: QueueItem[] = sliced.map(file => ({
          id: Math.random().toString(36).slice(2, 10),
          file, preview: null,
          status: 'pending', progress: 0, step: 'En attente...',
          result: null, error: null,
          actionTaken: false, selectedBankTxId: null,
          associe: null,
          confirmedRef: null, showCandidates: false, showManualSelector: false,
        }));
        return [...prev, ...items];
      });
    }
  }, [multiPageMode]);

  const removeItem    = useCallback((id: string) => setQueue(prev => prev.filter(i => i.id !== id)), []);
  const clearFinished = useCallback(() => setQueue(prev => prev.filter(i => !TERMINAL.includes(i.status))), []);

  // Révoque toutes les object URLs puis vide la liste multi-pages
  const resetMultiPageFiles = useCallback(() => {
    setMultiPageFiles(prev => {
      prev.forEach(p => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
      return [];
    });
  }, []);

  const removeMultiPageFile = useCallback((idx: number) => {
    setMultiPageFiles(prev => prev.filter((p, i) => {
      if (i !== idx) return true;
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return false;
    }));
  }, []);

  // ── Processing ─────────────────────────────────────────────────────────────
  const processItem = useCallback(async (item: QueueItem) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setProcessingId(item.id);

    const upd = (u: Partial<QueueItem>) =>
      setQueue(prev => prev.map(i => i.id === item.id ? { ...i, ...u } : i));

    try {
      // Step 1 — read
      let bases: any[] = [];
      let preview: string | null = null;

      if (item.files && item.files.length > 0) {
        upd({ status: 'reading', progress: 8, step: `Lecture de ${item.files.length} pages...` });
        const filePromises = item.files.map(async f => {
          const { base64, preview: prev } = await readBase64(f);
          if (prev && !preview) preview = prev;
          return { fileBase64: base64, mimeType: f.type, filename: f.name };
        });
        bases = await Promise.all(filePromises);
        upd({ preview, progress: 18 });
      } else {
        upd({ status: 'reading', progress: 8, step: 'Lecture du fichier...' });
        const { base64, preview: prev } = await readBase64(item.file);
        preview = prev;
        upd({ preview, progress: 18 });
        bases = [{ fileBase64: base64, mimeType: item.file.type, filename: item.file.name }];
      }

      // Step 2 — upload indicator
      upd({ status: 'uploading', progress: 22, step: 'Envoi vers le serveur...' });

      // Step 3 — AI analysis (animated bar)
      upd({ status: 'analyzing', progress: 28, step: 'Analyse OCR par l\'IA...' });
      let fp = 28;
      progressTimerRef.current = setInterval(() => {
        fp = Math.min(fp + Math.random() * 4 + 1, 82);
        setQueue(prev => prev.map(i => i.id === item.id ? { ...i, progress: Math.round(fp) } : i));
      }, 380);

      const payload = item.files && item.files.length > 0
        ? { files: bases, filename: item.file.name }
        : { fileBase64: bases[0].fileBase64, mimeType: bases[0].mimeType, filename: bases[0].filename };

      const res  = await fetch('/api/scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `Erreur ${res.status}`);

      // Step 4 — matching
      upd({ status: 'matching', progress: 90, step: 'Recherche de rapprochement bancaire...' });

      // Step 5 — result
      if (data.is_duplicate) {
        upd({ status: 'duplicate', progress: 100, step: '⚠️ Doublon détecté', result: data });
      } else {
        const lbl =
          data.match_confidence === 'high'          ? '✅ Transaction trouvée' :
          (data.bank_candidates?.length ?? 0) > 0  ? '🔍 Correspondances possibles' :
          '📋 Aucune transaction bancaire';
        upd({ status: 'complete', progress: 100, step: lbl, result: data });
      }
    } catch (e: any) {
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      upd({ status: 'error', progress: 100, step: 'Erreur', error: e?.message || 'Erreur analyse IA' });
    } finally {
      isProcessingRef.current = false;
      setProcessingId(null);
    }
  }, []);

  // Auto-trigger next pending item
  useEffect(() => {
    if (isProcessingRef.current) return;
    const next = queue.find(i => i.status === 'pending');
    if (next) processItem(next);
  }, [queue, processItem]);

  // ── Confirm action ─────────────────────────────────────────────────────────
  const confirmAction = useCallback(async (
    itemId: string,
    bankId: string | null,
    pm: 'bank' | 'cash' | 'card_perso',
    associe: 'justine' | 'yohan' | undefined,
    confirmations: string[],
  ) => {
    const item = queue.find(i => i.id === itemId);
    if (!item?.result) return;
    setItem(itemId, { step: 'Enregistrement...', progress: 96 });
    try {
      const res  = await fetch('/api/scanner/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extracted:      item.result.extracted,
          file_url:       item.result.file_url,
          bank_tx_id:     bankId,
          payment_method: pm,
          associe:        associe,
          confirmations,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setItem(itemId, {
          actionTaken: true, confirmedRef: data.accounting_ref,
          selectedBankTxId: bankId, paymentMethod: pm,
          associe: associe || null,
          step: '✅ Facture enregistrée', progress: 100,
        });
        // La transaction vient d'être liée : on la retire de la liste locale
        // pour ne plus la proposer aux éléments suivants de la file.
        if (bankId) setBankTxList(prev => prev.filter(tx => tx.id !== bankId));
      } else {
        alert('Erreur : ' + (data.error || 'Inconnu'));
        setItem(itemId, { step: 'Erreur enregistrement', progress: 100 });
      }
    } catch {
      alert('Erreur réseau lors de l\'enregistrement.');
    }
  }, [queue, setItem]);

  // ── Load bank tx list (lazy) ───────────────────────────────────────────────
  const loadBankTx = useCallback(async () => {
    if (bankTxLoaded) return;
    const { data } = await supabase
      .from('bank_transactions')
      .select('id, date, description, amount, status')
      .in('status', ['pending_invoice', 'facture_ok'])
      .order('date', { ascending: false })
      .limit(60);
    setBankTxList(data || []);
    setBankTxLoaded(true);
  }, [bankTxLoaded, supabase]);

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop      = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); };

  // ── Derived KPIs ───────────────────────────────────────────────────────────
  const total         = queue.length;
  const done          = queue.filter(i => TERMINAL.includes(i.status)).length;
  const matched       = queue.filter(i => i.actionTaken && i.selectedBankTxId).length;
  const needsAction   = queue.filter(i => i.status === 'complete' && !i.actionTaken).length;
  const canAdd        = total < MAX_QUEUE;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
        .scanner-drop {
          border: 2px dashed var(--border);
          border-radius: 20px;
          padding: 40px 24px;
          text-align: center;
          transition: all .2s;
          background: linear-gradient(135deg, white 0%, var(--cream-light) 100%);
          cursor: default;
        }
        .scanner-drop.drag-over {
          border-color: var(--teal);
          background: rgba(42,125,123,.06);
          transform: scale(1.01);
        }
        @media (max-width: 640px) {
          .scanner-drop { padding: 28px 16px; }
        }
      `}} />

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 12,
            background: 'linear-gradient(135deg, var(--teal), var(--teal-dark))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white',
            boxShadow: '0 4px 14px rgba(42,125,123,.3)',
          }}>
            <ScanLine size={20} />
          </div>
          <div>
            <h2 style={{ margin: 0 }}>Scanner IA</h2>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              OCR · Détection doublons · Rapprochement bancaire automatique
            </p>
          </div>
        </div>
        <ClaudeStatusIndicator />
      </div>

      <div className="page-body">

        {/* ── KPI strip ───────────────────────────────────────────────── */}
        {total > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="File d'attente" value={`${done}/${total}`} sub="analysés" />
            <KpiCard label="Rapprochés"  value={String(matched)}   sub="transactions liées"  accent="var(--green)" />
            {needsAction > 0 && (
              <KpiCard label="Décision requise" value={String(needsAction)} sub="en attente" accent="var(--orange)" />
            )}
            {queue.filter(i => i.status === 'duplicate').length > 0 && (
              <KpiCard label="Doublons" value={String(queue.filter(i => i.status === 'duplicate').length)} sub="ignorés" accent="#D97706" />
            )}
          </div>
        )}

        {/* ── Multi-page mode panel ── */}
        <div style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 16,
          marginBottom: 20,
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="multiPageToggle"
                type="checkbox"
                checked={multiPageMode}
                onChange={e => {
                  setMultiPageMode(e.target.checked);
                  if (!e.target.checked) resetMultiPageFiles();
                }}
                style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--teal)' }}
              />
              <label htmlFor="multiPageToggle" style={{ fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                📑 Activer le Mode Multi-Pages <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>(pour les factures sur 2 ou 3 pages)</span>
              </label>
            </div>
            {multiPageMode && multiPageFiles.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={resetMultiPageFiles}
                style={{ fontSize: 12, color: 'var(--red)', border: 'none', background: 'none', cursor: 'pointer' }}
              >
                Tout réinitialiser
              </button>
            )}
          </div>

          {multiPageMode && (
            <div style={{
              background: 'var(--cream-light)',
              border: '1.5px dashed var(--teal)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}>
              {/* Etape 1 section */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--teal-dark)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: 'var(--teal)', color: 'white', fontSize: 11, fontWeight: 'bold' }}>1</span>
                  Ajoutez les pages dans l'ordre (une par une ou plusieurs à la fois) :
                </div>
                
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: 12, cursor: 'pointer' }}
                    onClick={() => cameraRef.current?.click()}
                  >
                    <Camera size={14} /> Prendre une photo (page {multiPageFiles.length + 1})
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: 12, cursor: 'pointer' }}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload size={14} /> Importer des pages/photos
                  </button>
                </div>
              </div>

              {/* Pages captured display */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>
                  Pages prêtes ({multiPageFiles.length}) :
                </div>
                {multiPageFiles.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', background: 'white', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    Aucune page ajoutée pour le moment. Cliquez sur un des boutons ci-dessus pour commencer.
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', background: 'white', padding: 12, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    {multiPageFiles.map((page, idx) => {
                      return (
                        <div key={idx} style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-light)' }}>
                          {page.previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- blob local, incompatible next/image
                            <img src={page.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <div style={{ width: '100%', height: '100%', background: 'var(--cream-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold', color: 'var(--text-muted)' }}>
                              PDF
                            </div>
                          )}
                          <span style={{ position: 'absolute', bottom: 2, left: 2, background: 'rgba(0,0,0,0.7)', color: 'white', fontSize: 9, padding: '2px 4px', borderRadius: 4, fontWeight: 'bold' }}>
                            page {idx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeMultiPageFile(idx)}
                            style={{
                              position: 'absolute', top: 2, right: 2,
                              background: 'rgba(220, 38, 38, 0.95)', color: 'white',
                              border: 'none', borderRadius: '50%',
                              width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 10, cursor: 'pointer', fontWeight: 'bold', padding: 0
                            }}
                            title="Supprimer cette page"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Etape 2 section */}
              {multiPageFiles.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Toutes les pages sont bien dans l'ordre ? Passez à l'étape suivante.
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={!canAdd}
                    style={{ padding: '10px 20px', fontSize: 13, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', boxShadow: '0 4px 12px rgba(42,125,123,.25)' }}
                    onClick={() => {
                      if (queue.length >= MAX_QUEUE) {
                        alert(`File pleine (${MAX_QUEUE}/${MAX_QUEUE}) — terminez ou retirez des fichiers pour en ajouter de nouveaux.`);
                        return;
                      }
                      const queueItem: QueueItem = {
                        id: Math.random().toString(36).slice(2, 10),
                        file: multiPageFiles[0].file,
                        files: multiPageFiles.map(p => p.file),
                        preview: null,
                        status: 'pending',
                        progress: 0,
                        step: 'En attente...',
                        result: null,
                        error: null,
                        actionTaken: false,
                        selectedBankTxId: null,
                        associe: null,
                        confirmedRef: null,
                        showCandidates: false,
                        showManualSelector: false,
                      };
                      setQueue(prev => [...prev, queueItem]);
                      resetMultiPageFiles();
                    }}
                  >
                    <Sparkles size={15} /> Étape 2 : Lancer l'analyse combinée ({multiPageFiles.length} page{multiPageFiles.length > 1 ? 's' : ''})
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Drop zone ────────────────────────────────────────────────── */}
        {canAdd && !multiPageMode && (
          <div
            className={`scanner-drop ${isDragging ? 'drag-over' : ''}`}
            onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
            style={{ marginBottom: 24 }}
          >
            <div style={{
              width: 68, height: 68, borderRadius: 18, margin: '0 auto 18px',
              background: 'linear-gradient(135deg, var(--teal), var(--teal-dark))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', boxShadow: '0 6px 20px rgba(42,125,123,.35)',
            }}>
              <ScanLine size={30} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Scanner une facture ou un ticket</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 22, lineHeight: 1.6 }}>
              Glissez un fichier ici, prenez une photo ou importez jusqu'à {MAX_QUEUE} fichiers<br />
              <strong style={{ color: 'var(--text-secondary)' }}>
                PDF, JPG, PNG, WEBP — {MAX_QUEUE - total} emplacement{MAX_QUEUE - total > 1 ? 's' : ''} disponible{MAX_QUEUE - total > 1 ? 's' : ''}
              </strong>
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px' }}
                onClick={() => cameraRef.current?.click()}
              >
                <Camera size={18} /> Prendre une photo
              </button>
              <button
                className="btn btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px' }}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={18} /> Importer {MAX_QUEUE - total > 1 ? `jusqu'à ${MAX_QUEUE - total} fichiers` : 'un fichier'}
              </button>
          </div>
        </div>
      )}

        {/* Hidden inputs always available for camera/file triggers */}
        <input ref={cameraRef} type="file" accept="image/*"
          // @ts-ignore
          capture="environment"
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />
        <input ref={fileRef} type="file" accept=".pdf,image/jpeg,image/png,image/webp" multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        />

        {/* Full queue banner (replace drop zone when full) */}
        {!canAdd && (
          <div style={{
            background: 'rgba(232,155,62,.08)', border: '1.5px solid rgba(232,155,62,.3)',
            borderRadius: 12, padding: '12px 16px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#B45309', fontWeight: 600,
          }}>
            <AlertCircle size={16} />
            File pleine ({MAX_QUEUE}/{MAX_QUEUE}) — terminez ou retirez des fichiers pour en ajouter de nouveaux.
          </div>
        )}

        {/* ── Queue ────────────────────────────────────────────────────── */}
        {total > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 800 }}>File de traitement</span>
                <span style={{
                  background: processingId ? 'rgba(232,155,62,.15)' : 'rgba(139,139,139,.1)',
                  color: processingId ? '#B45309' : 'var(--text-muted)',
                  fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 100,
                }}>
                  {done}/{total}
                </span>
                {processingId && (
                  <span style={{ fontSize: 12, color: 'var(--orange)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Analyse en cours...
                  </span>
                )}
              </div>
              {done > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={clearFinished}
                  style={{ fontSize: 12, color: 'var(--text-muted)' }}
                >
                  Effacer terminés
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {queue.map(item => (
                <QueueCard
                  key={item.id}
                  item={item}
                  isActive={item.id === processingId}
                  onRemove={() => removeItem(item.id)}
                  onConfirm={confirmAction}
                  onToggleCandidates={() => setItem(item.id, { showCandidates: !item.showCandidates })}
                  onToggleManual={async () => {
                    await loadBankTx();
                    setItem(item.id, { showManualSelector: !item.showManualSelector });
                  }}
                  bankTxList={bankTxList}
                />
              ))}
            </div>
          </>
        )}

        {/* ── Empty state ───────────────────────────────────────────────── */}
        {total === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0 50px', color: 'var(--text-muted)' }}>
            <Sparkles size={42} style={{ opacity: .25, marginBottom: 14 }} />
            <p style={{ fontSize: 14 }}>Scannez votre première facture pour démarrer</p>
          </div>
        )}
      </div>
    </>
  );
}

// ── Mini KPI card ──────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      borderRadius: 14, padding: '12px 16px', boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent || 'var(--text-primary)', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sub}</div>
    </div>
  );
}
