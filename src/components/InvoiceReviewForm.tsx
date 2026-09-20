'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2, RotateCcw, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  normalizeLine, round2, toNumber,
  ACCOUNTING_CLASSES, DOCUMENT_TYPES, LINE_CATEGORIES, TVA_RATES,
  type ExtractedInvoiceData, type ExtractedLine, type TvaRateLine,
} from '@/lib/invoice-normalize';
import { formatCurrency } from '@/lib/utils';

/**
 * InvoiceReviewForm — la relecture humaine, avec le droit de corriger.
 *
 * Avant : l'écran affichait cinq pastilles (fournisseur, date, TTC, compte,
 * numéro) et un bouton « Confirmer ». Le HT et la TVA — les deux chiffres qui
 * font la déclaration — n'étaient même pas visibles, et rien n'était
 * modifiable : la « relecture » validait ce que l'OCR avait lu, faux compris.
 *
 * Ici chaque champ se corrige. Les anomalies sont recalculées à chaque frappe
 * par la même fonction que le serveur (`checkInvoice`) : corriger un HT fait
 * disparaître l'alerte qu'il causait, et fait apparaître celle qu'il crée.
 * Trois signaux visuels :
 *  - jaune : champ que l'OCR a déclaré incertain ;
 *  - rouge : champ visé par une anomalie encore ouverte ;
 *  - « corrigé » : la valeur diffère de la lecture initiale (bouton ↺ pour y revenir).
 */

interface Props {
  value: ExtractedInvoiceData;
  /** Lecture initiale de l'OCR, pour marquer et annuler les corrections. */
  original: ExtractedInvoiceData;
  onChange: (next: ExtractedInvoiceData) => void;
  /** Champs visés par des anomalies non acquittées. */
  flaggedFields: Set<string>;
  disabled?: boolean;
}

const DOC_LABELS: Record<string, string> = {
  facture: 'Facture', ticket_caisse: 'Ticket de caisse', bon_livraison: 'Bon de livraison', recu: 'Reçu CB',
};
const CLASS_LABELS: Record<string, string> = {
  '601': '601 — Matières premières', '607': '607 — Boissons', '606': '606 — Fournitures & emballages',
  '6061': '6061 — Énergie', '61': '61 — Loyer, assurances', '62': '62 — Télécom, logiciels',
  '63': '63 — Impôts & taxes', '64': '64 — Personnel', autre: 'Autre',
};
const CAT_LABELS: Record<string, string> = {
  alimentaire: 'Alimentaire', boisson: 'Boisson', emballage: 'Emballage', materiel: 'Matériel', autre: 'Autre',
};

const numOrEmpty = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export default function InvoiceReviewForm({ value, original, onChange, flaggedFields, disabled }: Props) {
  const [showLines, setShowLines] = useState(false);
  const uncertain = useMemo(() => new Set(value.champs_incertains ?? []), [value.champs_incertains]);
  const unread = useMemo(() => new Set(value.champs_non_lus ?? []), [value.champs_non_lus]);

  const set = (patch: Partial<ExtractedInvoiceData>) => onChange({ ...value, ...patch });

  const ht = Number(value.total_ht) || 0;
  const tva = Number(value.tva) || 0;
  const ttc = Number(value.total_ttc) || 0;
  const ecart = round2(ht + tva - ttc);
  const vent = value.tva_ventilation ?? [];
  const ventBase = round2(vent.reduce((s, v) => s + v.base_ht, 0));
  const ventTva = round2(vent.reduce((s, v) => s + v.montant_tva, 0));
  const lignes = value.lignes ?? [];
  const lignesSum = round2(lignes.reduce((s, l) => s + (Number(l.prix_total_ht) || 0), 0));
  const ctrl = value.controle_lecture;

  const changed = (field: string): boolean => {
    switch (field) {
      case 'total_tva': return Math.abs((Number(original.tva) || 0) - tva) > 0.005;
      case 'total_ht': case 'total_ttc': return Math.abs((Number(original[field]) || 0) - (Number(value[field]) || 0)) > 0.005;
      case 'nom_entreprise_present': return !!original.nom_entreprise_present !== !!value.nom_entreprise_present;
      case 'tva_ventilation': return JSON.stringify(original.tva_ventilation ?? []) !== JSON.stringify(vent);
      case 'lignes': return JSON.stringify(original.lignes ?? []) !== JSON.stringify(lignes);
      default: {
        const a = (original as unknown as Record<string, unknown>)[field], b = (value as unknown as Record<string, unknown>)[field];
        return (a ?? '') !== (b ?? '');
      }
    }
  };

  const restore = (field: string) => {
    if (field === 'total_tva') set({ tva: original.tva });
    else if (field === 'tva_ventilation') set({ tva_ventilation: original.tva_ventilation ?? [] });
    else if (field === 'lignes') set({ lignes: original.lignes ?? [] });
    else set({ [field]: (original as unknown as Record<string, unknown>)[field] } as Partial<ExtractedInvoiceData>);
  };

  const fieldStyle = (field: string): React.CSSProperties => ({
    fontSize: 13, padding: '7px 9px',
    borderColor: flaggedFields.has(field) ? 'var(--red)' : uncertain.has(field) || unread.has(field) ? '#D97706' : undefined,
    background: flaggedFields.has(field) ? 'rgba(217,79,79,0.05)' : uncertain.has(field) || unread.has(field) ? 'rgba(217,119,6,0.07)' : undefined,
  });

  // Fonction de rendu, pas un composant : un composant défini dans le rendu
  // serait recréé à chaque frappe et perdrait le focus du champ.
  const renderLabel = (field: string, children: React.ReactNode) => (
    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      {children}
      {uncertain.has(field) && <span title="L'OCR n'était pas sûr de ce champ" style={{ color: '#B45309', fontWeight: 800 }}>?</span>}
      {unread.has(field) && <span title="Non lu par l'OCR" style={{ color: '#B45309', fontWeight: 700 }}>non lu</span>}
      {changed(field) && (
        <button type="button" onClick={() => restore(field)} disabled={disabled} title="Revenir à la lecture OCR"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--teal)', display: 'inline-flex', alignItems: 'center', gap: 2, padding: 0, fontSize: 10, fontWeight: 700 }}>
          <RotateCcw size={10} /> corrigé
        </button>
      )}
    </label>
  );

  const setVent = (next: TvaRateLine[]) => set({ tva_ventilation: next });
  const updateVent = (i: number, patch: Partial<TvaRateLine>) => setVent(vent.map((v, j) => j === i ? { ...v, ...patch } : v));

  const setLines = (next: ExtractedLine[]) => set({ lignes: next });
  const updateLine = (i: number, patch: Partial<ExtractedLine>) =>
    setLines(lignes.map((l, j) => j === i ? normalizeLine({ ...l, ...patch }) : l));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>

      {/* ── Identité du document ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, padding: 12, background: 'var(--cream-light)', borderRadius: 10 }}>
        <div>
          {renderLabel('fournisseur', 'Fournisseur')}
          <input className="form-input" style={fieldStyle('fournisseur')} disabled={disabled}
            value={value.fournisseur ?? ''} onChange={e => set({ fournisseur: e.target.value || null })} />
        </div>
        <div>
          {renderLabel('date', 'Date')}
          <input className="form-input" type="date" style={fieldStyle('date')} disabled={disabled}
            value={value.date ?? ''} onChange={e => set({ date: e.target.value || null })} />
        </div>
        <div>
          {renderLabel('numero_facture', 'N° de facture')}
          <input className="form-input" style={{ ...fieldStyle('numero_facture'), fontFamily: 'monospace' }} disabled={disabled}
            value={value.numero_facture ?? ''} onChange={e => set({ numero_facture: e.target.value || null })} />
        </div>
        <div>
          {renderLabel('type_document', 'Type')}
          <select className="form-select" style={fieldStyle('type_document')} disabled={disabled}
            value={value.type_document ?? 'facture'} onChange={e => set({ type_document: e.target.value })}>
            {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{DOC_LABELS[t]}</option>)}
          </select>
        </div>
        <div>
          {renderLabel('compte_comptable', 'Compte')}
          <select className="form-select" style={fieldStyle('compte_comptable')} disabled={disabled}
            value={value.compte_comptable ?? '601'} onChange={e => set({ compte_comptable: e.target.value })}>
            {ACCOUNTING_CLASSES.map(c => <option key={c} value={c}>{CLASS_LABELS[c]}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', paddingBottom: 8 }}>
            <input type="checkbox" disabled={disabled} checked={!!value.nom_entreprise_present}
              onChange={e => set({ nom_entreprise_present: e.target.checked })} />
            Nom de la société présent {changed('nom_entreprise_present') && <span style={{ fontSize: 10, color: 'var(--teal)', fontWeight: 700 }}>corrigé</span>}
          </label>
        </div>
      </div>

      {/* ── Totaux ───────────────────────────────────────────────────── */}
      <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
          <div>
            {renderLabel('total_ht', 'Total HT')}
            <input className="form-input" type="number" step="0.01" inputMode="decimal" style={fieldStyle('total_ht')} disabled={disabled}
              value={numOrEmpty(value.total_ht)} onChange={e => set({ total_ht: toNumber(e.target.value) ?? 0 })} />
          </div>
          <div>
            {renderLabel('total_tva', 'TVA')}
            <input className="form-input" type="number" step="0.01" inputMode="decimal" style={fieldStyle('total_tva')} disabled={disabled}
              value={numOrEmpty(value.tva)} onChange={e => set({ tva: toNumber(e.target.value) ?? 0 })} />
          </div>
          <div>
            {renderLabel('total_ttc', 'Total TTC')}
            <input className="form-input" type="number" step="0.01" inputMode="decimal" style={{ ...fieldStyle('total_ttc'), fontWeight: 800 }} disabled={disabled}
              value={numOrEmpty(value.total_ttc)} onChange={e => set({ total_ttc: toNumber(e.target.value) ?? 0 })} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontSize: 11, color: Math.abs(ecart) <= 0.05 ? 'var(--green)' : '#B45309', paddingBottom: 8 }}>
            {Math.abs(ecart) <= 0.05
              ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ShieldCheck size={13} /> HT + TVA = TTC</span>
              : <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ShieldAlert size={13} /> HT + TVA − TTC = {formatCurrency(ecart)}</span>}
            {value.tva_recoverable === false && <span style={{ color: 'var(--text-muted)' }}>TVA non déduite</span>}
          </div>
        </div>

        {/* Lecture de contrôle */}
        {ctrl ? (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>Contrôle par {ctrl.moteur} :</span>
            <Cmp label="HT" a={ht} b={ctrl.total_ht} />
            <Cmp label="TVA" a={tva} b={ctrl.total_tva} />
            <Cmp label="TTC" a={ttc} b={ctrl.total_ttc} />
            <CmpText label="date" a={value.date} b={ctrl.date} />
            <CmpText label="n°" a={value.numero_facture} b={ctrl.numero_facture} loose />
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 11, color: '#B45309' }}>
            Lue une seule fois (pas de lecture de contrôle) : compare les totaux au document avec attention.
          </div>
        )}

        {/* Ventilation par taux */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            {renderLabel('tva_ventilation', 'Ventilation TVA par taux (pied de facture)')}
            {!disabled && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px' }}
                onClick={() => setVent([...vent, { taux: 10, base_ht: 0, montant_tva: 0 }])}>
                <Plus size={11} /> Ajouter un taux
              </button>
            )}
          </div>
          {vent.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Aucune ventilation lue. La TVA déductible sera le montant « TVA » ci-dessus.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {vent.map((v, i) => {
                const attendu = round2(v.base_ht * v.taux / 100);
                const ok = Math.abs(attendu - v.montant_tva) <= 0.05 + v.base_ht * 0.001;
                return (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr auto auto', gap: 6, alignItems: 'center' }}>
                    <select className="form-select" style={{ fontSize: 12, padding: '5px 7px', borderColor: flaggedFields.has('tva_ventilation') ? 'var(--red)' : undefined }} disabled={disabled}
                      value={v.taux} onChange={e => updateVent(i, { taux: Number(e.target.value) })}>
                      {TVA_RATES.map(r => <option key={r} value={r}>{String(r).replace('.', ',')} %</option>)}
                      {!(TVA_RATES as readonly number[]).includes(v.taux) && <option value={v.taux}>{v.taux} % (inconnu)</option>}
                    </select>
                    <input className="form-input" type="number" step="0.01" inputMode="decimal" placeholder="Base HT" style={{ fontSize: 12, padding: '5px 7px' }} disabled={disabled}
                      value={numOrEmpty(v.base_ht)} onChange={e => updateVent(i, { base_ht: toNumber(e.target.value) ?? 0 })} />
                    <input className="form-input" type="number" step="0.01" inputMode="decimal" placeholder="TVA" style={{ fontSize: 12, padding: '5px 7px', borderColor: ok ? undefined : '#D97706' }} disabled={disabled}
                      value={numOrEmpty(v.montant_tva)} onChange={e => updateVent(i, { montant_tva: toNumber(e.target.value) ?? 0 })} />
                    <span style={{ fontSize: 10, color: ok ? 'var(--green)' : '#B45309', whiteSpace: 'nowrap' }} title="Base × taux">
                      {ok ? '✓' : `≠ ${formatCurrency(attendu)}`}
                    </span>
                    {!disabled && (
                      <button type="button" onClick={() => setVent(vent.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }} title="Retirer">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ color: Math.abs(ventBase - ht) <= 0.05 ? 'var(--green)' : '#B45309' }}>Σ bases {formatCurrency(ventBase)} {Math.abs(ventBase - ht) <= 0.05 ? '= HT' : `≠ HT ${formatCurrency(ht)}`}</span>
                <span style={{ color: Math.abs(ventTva - tva) <= 0.05 ? 'var(--green)' : '#B45309' }}>Σ TVA {formatCurrency(ventTva)} {Math.abs(ventTva - tva) <= 0.05 ? '= TVA' : `≠ TVA ${formatCurrency(tva)}`}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Lignes ───────────────────────────────────────────────────── */}
      <div style={{ border: `1px solid ${flaggedFields.has('lignes') ? 'var(--red)' : 'var(--border)'}`, borderRadius: 10, overflow: 'hidden' }}>
        <button type="button" onClick={() => setShowLines(s => !s)}
          style={{ width: '100%', background: 'var(--cream-light)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {lignes.length} ligne{lignes.length > 1 ? 's' : ''} · Σ {formatCurrency(lignesSum)} HT
            {uncertain.has('lignes') && <span style={{ color: '#B45309' }}>?</span>}
            {changed('lignes') && <span style={{ fontSize: 10, color: 'var(--teal)' }}>corrigé</span>}
            {ht > 0 && Math.abs(lignesSum - ht) > Math.max(1, ht * 0.01) && <span style={{ color: '#B45309', fontWeight: 600 }}>≠ HT {formatCurrency(ht)}</span>}
          </span>
          {showLines ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showLines && (
          <div style={{ padding: 10, overflowX: 'auto' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
              Quantité et conditionnement tels qu&apos;imprimés ; l&apos;unité standard et le prix unitaire sont recalculés par l&apos;outil.
            </div>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: 4 }}>Désignation</th>
                  <th style={{ padding: 4, width: 60 }}>Qté lue</th>
                  <th style={{ padding: 4, width: 90 }}>Condit.</th>
                  <th style={{ padding: 4, width: 80 }}>Total HT</th>
                  <th style={{ padding: 4, width: 100 }}>Catégorie</th>
                  <th style={{ padding: 4, whiteSpace: 'nowrap' }}>→ standard</th>
                  <th style={{ padding: 4 }}></th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-light)' }}>
                    <td style={{ padding: 3 }}>
                      <input className="form-input" style={{ fontSize: 11, padding: '4px 6px' }} disabled={disabled}
                        value={l.designation} onChange={e => updateLine(i, { designation: e.target.value })} />
                    </td>
                    <td style={{ padding: 3 }}>
                      <input className="form-input" type="number" step="any" inputMode="decimal" style={{ fontSize: 11, padding: '4px 6px' }} disabled={disabled}
                        value={numOrEmpty(l.quantite_lue ?? l.quantite)} onChange={e => updateLine(i, { quantite_lue: toNumber(e.target.value) })} />
                    </td>
                    <td style={{ padding: 3 }}>
                      <input className="form-input" style={{ fontSize: 11, padding: '4px 6px' }} placeholder="25 kg" disabled={disabled}
                        value={l.conditionnement ?? ''} onChange={e => updateLine(i, { conditionnement: e.target.value || null })} />
                    </td>
                    <td style={{ padding: 3 }}>
                      <input className="form-input" type="number" step="0.01" inputMode="decimal" style={{ fontSize: 11, padding: '4px 6px' }} disabled={disabled}
                        value={numOrEmpty(l.prix_total_ht)} onChange={e => updateLine(i, { prix_total_ht: toNumber(e.target.value) ?? 0 })} />
                    </td>
                    <td style={{ padding: 3 }}>
                      <select className="form-select" style={{ fontSize: 11, padding: '4px 6px' }} disabled={disabled}
                        value={l.categorie} onChange={e => updateLine(i, { categorie: e.target.value })}>
                        {LINE_CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: 3, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {l.quantite > 0 ? `${l.quantite} ${l.unite} · ${formatCurrency(l.prix_unitaire_ht)}/${l.unite}` : '—'}
                    </td>
                    <td style={{ padding: 3 }}>
                      {!disabled && (
                        <button type="button" onClick={() => setLines(lignes.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }} title="Retirer la ligne">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!disabled && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setLines([...lignes, normalizeLine({ designation: '', quantite_lue: 1, conditionnement: null, prix_total_ht: 0, categorie: 'alimentaire' })])}>
                <Plus size={11} /> Ajouter une ligne
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Cmp({ label, a, b }: { label: string; a: number; b: number | null }) {
  if (b === null) return <span>{label} : non lu</span>;
  const ok = Math.abs(a - b) <= 0.05;
  return <span style={{ color: ok ? 'var(--green)' : 'var(--red)', fontWeight: ok ? 500 : 700 }}>{label} {formatCurrency(b)} {ok ? '✓' : '≠'}</span>;
}

function CmpText({ label, a, b, loose }: { label: string; a: string | null | undefined; b: string | null; loose?: boolean }) {
  if (!b) return null;
  const norm = (s: string | null | undefined) => loose ? (s ?? '').toUpperCase().replace(/[\s\-_./]/g, '') : (s ?? '');
  const ok = norm(a) === norm(b);
  return <span style={{ color: ok ? 'var(--green)' : 'var(--red)', fontWeight: ok ? 500 : 700 }}>{label} {b} {ok ? '✓' : '≠'}</span>;
}
