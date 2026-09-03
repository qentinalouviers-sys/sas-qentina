'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate, downloadCSV } from '@/lib/utils';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { UNITS } from '@/lib/recipes';
import {
  Package, Search, Save, Download, CheckCircle2, Clock,
  X, RefreshCw, Layers, Zap, Flame, Edit2, Check, History
} from 'lucide-react';
import type { Ingredient } from '@/lib/types';

// ─── Audit Types ─────────────────────────────────────────────────────────────

type AnomalyType = 'conditionnement' | 'prix_aberrant' | 'unite_incorrecte' | 'quantite_absurde' | 'prix_manquant';
type Severity = 'high' | 'medium' | 'low';

interface Anomaly {
  ingredient_id: string;
  ingredient_name: string;
  type: AnomalyType;
  severity: Severity;
  current_unit: string | null;
  current_price: number | null;
  description: string;
  suggestion_unit: string | null;
  suggestion_price: number | null;
  reason: string;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Une ligne de stock = le dernier comptage physique d'un ingrédient.
 *
 * Il n'y a plus de « stock théorique » ici. Il se calculait comme tous les
 * achats depuis toujours moins toute la consommation depuis toujours, sans
 * jamais repartir d'un inventaire : il ne pouvait pas être juste, et il
 * s'affichait pourtant comme un chiffre. Le seul stock qu'on connaît est
 * celui qu'on a compté.
 */
interface StockRow {
  ingredient: Ingredient;
  stockPhysique: number | null;
  countedAt: string | null;
  valorisation: number;
}

/** Un inventaire = tous les comptages saisis le même jour. */
interface InventorySession {
  day: string;
  products: number;
  valorisation: number;
}

// Rayon configuration — each rayon maps to ingredient name keywords
const RAYONS: { id: string; label: string; emoji: string; color: string; keywords: string[] }[] = [
  { id: 'viandes', label: 'Viandes & Poissons', emoji: '🥩', color: '#ef4444', keywords: ['viande', 'boeuf', 'poulet', 'veau', 'agneau', 'porc', 'jambon', 'saumon', 'thon', 'anchois', 'merlu', 'crevette'] },
  { id: 'fromages', label: 'Fromagerie', emoji: '🧀', color: '#f59e0b', keywords: ['mozzarella', 'parmesan', 'ricotta', 'fromage', 'burrata', 'grana', 'pecorino', 'feta', 'cheddar', 'emmental', 'gorgonzola'] },
  { id: 'legumes', label: 'Fruits & Légumes', emoji: '🥦', color: '#22c55e', keywords: ['tomate', 'oignon', 'ail', 'poivron', 'basilic', 'roquette', 'salade', 'courgette', 'aubergine', 'champignon', 'olive', 'citron', 'orange', 'pomme', 'avocat', 'epinard', 'carotte'] },
  { id: 'epicerie', label: 'Épicerie sèche', emoji: '🫙', color: '#8b5cf6', keywords: ['farine', 'sucre', 'sel', 'huile', 'vinaigre', 'tomate concasse', 'sauce', 'pate', 'riz', 'lentille', 'pois', 'haricot', 'levure', 'origan', 'poivre', 'paprika', 'cumin', 'épice', 'concentré', 'câpre'] },
  { id: 'frais', label: 'Produits frais', emoji: '🥛', color: '#3b82f6', keywords: ['oeuf', 'beurre', 'crème', 'lait', 'yaourt', 'pâte'] },
  { id: 'boissons', label: 'Boissons', emoji: '🥤', color: '#06b6d4', keywords: ['eau', 'coca', 'jus', 'biere', 'vin', 'limonade', 'café', 'the', 'sirop', 'boisson'] },
  { id: 'emballages', label: 'Emballages', emoji: '📦', color: '#64748b', keywords: ['boite', 'sachet', 'barquette', 'couvercle', 'film', 'papier', 'carton', 'sac'] },
];

function getRayon(name: string): string {
  const lower = name.toLowerCase();
  for (const rayon of RAYONS) {
    if (rayon.keywords.some(kw => lower.includes(kw))) return rayon.id;
  }
  return 'autre';
}

// ─── Local UI components ─────────────────────────────────────────────────────

function SuccessBanner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div style={{ background: 'var(--green-light)', border: '1px solid var(--green)', borderRadius: 12, padding: '14px 18px', marginBottom: 24, display: 'flex', gap: 10, alignItems: 'center' }}>
      <Check size={18} style={{ color: 'var(--green)' }} />
      <span style={{ fontWeight: 600, color: 'var(--green)' }}>{text}</span>
      <button style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }} onClick={onClose}><X size={16} /></button>
    </div>
  );
}

function RayonPill({ label, emoji, count, active, color, activeBg, completed, onClick }: {
  label: string;
  emoji?: string;
  count: number | string;
  active: boolean;
  color: string;
  activeBg?: string;
  completed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 16px',
        borderRadius: 99,
        border: active ? `2px solid ${color}` : completed ? '2px solid var(--green)' : '2px solid var(--border)',
        background: active ? (activeBg || `${color}18`) : completed ? 'var(--green-light)' : 'white',
        color: active ? color : completed ? 'var(--green)' : 'var(--text-secondary)',
        fontWeight: 600, fontSize: 13, cursor: 'pointer',
        transition: 'all 0.2s',
        whiteSpace: 'nowrap',
      }}
    >
      {emoji ? `${emoji} ${label}` : label}
      <span style={{
        background: active ? color : completed ? 'var(--green)' : 'var(--border)',
        color: (active || completed) ? 'white' : 'var(--text-muted)',
        borderRadius: 99, fontSize: 11, fontWeight: 700,
        padding: '1px 7px', minWidth: 20, textAlign: 'center',
      }}>{count}</span>
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function StockPage() {
  const [stockData, setStockData] = useState<StockRow[]>([]);
  const [history, setHistory] = useState<InventorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Inventory mode
  const [mode, setMode] = useState<'view' | 'inventory'>('view');
  const [inventoryInputs, setInventoryInputs] = useState<Record<string, string>>({});
  const [activeRayon, setActiveRayon] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showOnlyUncounted, setShowOnlyUncounted] = useState(false);

  // Detail modal
  const [selectedRow, setSelectedRow] = useState<StockRow | null>(null);

  // AI Audit state
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditDone, setAuditDone] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [showAuditPanel, setShowAuditPanel] = useState(true);

  // Fix modal
  const [fixingAnomaly, setFixingAnomaly] = useState<Anomaly | null>(null);
  const [fixUnit, setFixUnit] = useState('');
  const [fixPrice, setFixPrice] = useState('');
  const [fixSaving, setFixSaving] = useState(false);

  const supabase = createClient();

  // ─── Load Data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);

    const [{ data: ingredients }, inventoryCounts] = await Promise.all([
      supabase.from('ingredients').select('*').order('name'),
      // Les comptages s'accumulent à chaque inventaire : paginé, comme toute
      // lecture dont le volume grandit avec le temps.
      fetchAllRows<{ ingredient_id: string; quantity: number; unit_price: number | null; counted_at: string }>(
        (f0, f1) => supabase.from('inventory_counts')
          .select('ingredient_id, quantity, unit_price, counted_at')
          .order('counted_at', { ascending: false })
          .range(f0, f1)),
    ]);
    if (!ingredients) { setLoading(false); return; }

    // Dernier comptage par ingrédient (la liste est triée du plus récent au plus ancien)
    const latest: Record<string, { quantity: number; unit_price: number; counted_at: string }> = {};
    for (const ic of inventoryCounts) {
      if (!latest[ic.ingredient_id]) {
        latest[ic.ingredient_id] = { quantity: ic.quantity, unit_price: ic.unit_price || 0, counted_at: ic.counted_at };
      }
    }

    const rows: StockRow[] = ingredients.map((ing: Ingredient) => {
      const last = latest[ing.id];
      const physique = last?.quantity ?? null;
      const price = ing.last_unit_price || last?.unit_price || 0;
      return {
        ingredient: ing,
        stockPhysique: physique,
        countedAt: last?.counted_at ?? null,
        valorisation: (physique ?? 0) * price,
      };
    });

    // Historique : un inventaire par jour de comptage, valorisé au prix saisi ce jour-là
    const byDay = new Map<string, InventorySession>();
    for (const ic of inventoryCounts) {
      const day = String(ic.counted_at).slice(0, 10);
      const session = byDay.get(day) ?? { day, products: 0, valorisation: 0 };
      session.products++;
      session.valorisation += (ic.quantity || 0) * (ic.unit_price || 0);
      byDay.set(day, session);
    }
    setHistory([...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)));

    setStockData(rows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  // ─── Save inventory ──────────────────────────────────────────────────────────

  const handleSaveInventory = async () => {
    setSaving(true);
    const entries = Object.entries(inventoryInputs).filter(([, v]) => v !== '' && !isNaN(parseFloat(v)));
    const rows = entries.map(([ingredientId, value]) => {
      const ing = stockData.find(s => s.ingredient.id === ingredientId);
      return {
        ingredient_id: ingredientId,
        quantity: parseFloat(value),
        unit_price: ing?.ingredient.last_unit_price || 0,
      };
    });
    if (rows.length > 0) {
      await supabase.from('inventory_counts').insert(rows);
    }
    setMode('view');
    setInventoryInputs({});
    setSaving(false);
    loadData();
  };

  // ─── AI Audit ────────────────────────────────────────────────────────────────

  const runAudit = async () => {
    setAuditLoading(true);
    setAuditDone(false);
    setAnomalies([]);
    setDismissedIds(new Set());
    setShowAuditPanel(true);
    try {
      const res = await fetch('/api/ai/stock-audit', { method: 'POST' });
      const data = await res.json();
      if (data.anomalies) {
        setAnomalies(data.anomalies);
        setAuditDone(true);
      } else {
        alert('Erreur : ' + (data.error || 'Inconnu'));
      }
    } catch {
      alert('Erreur de connexion à l\'API');
    }
    setAuditLoading(false);
  };

  const openFix = (anomaly: Anomaly) => {
    setFixingAnomaly(anomaly);
    setFixUnit(anomaly.suggestion_unit || anomaly.current_unit || '');
    setFixPrice(anomaly.suggestion_price != null ? String(anomaly.suggestion_price) : anomaly.current_price != null ? String(anomaly.current_price) : '');
  };

  const handleFix = async () => {
    if (!fixingAnomaly) return;
    setFixSaving(true);
    const updates: Record<string, unknown> = {};
    if (fixUnit) updates.unit = fixUnit;
    if (fixPrice !== '' && !isNaN(parseFloat(fixPrice))) updates.last_unit_price = parseFloat(fixPrice);
    if (Object.keys(updates).length > 0) {
      await supabase.from('ingredients').update(updates).eq('id', fixingAnomaly.ingredient_id);
    }
    // Dismiss anomaly
    setDismissedIds(prev => new Set([...prev, fixingAnomaly.ingredient_id + fixingAnomaly.type]));
    setFixSaving(false);
    setFixingAnomaly(null);
    loadData();
  };

  const dismissAnomaly = (anomaly: Anomaly) => {
    setDismissedIds(prev => new Set([...prev, anomaly.ingredient_id + anomaly.type]));
  };

  // ─── Derived data ────────────────────────────────────────────────────────────

  const totalValo = stockData.reduce((s, r) => s + r.valorisation, 0);
  const countedCount = Object.keys(inventoryInputs).filter(k => inventoryInputs[k] !== '').length;
  const progressPct = stockData.length > 0 ? Math.round((countedCount / stockData.length) * 100) : 0;

  // Group by rayon
  const rayonGroups = useMemo(() => {
    const groups: Record<string, StockRow[]> = { autre: [] };
    RAYONS.forEach(r => { groups[r.id] = []; });
    stockData.forEach(row => {
      const rayonId = getRayon(row.ingredient.name);
      if (groups[rayonId] !== undefined) groups[rayonId].push(row);
      else groups['autre'].push(row);
    });
    return groups;
  }, [stockData]);

  // Rayon counts for badge
  const rayonCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.entries(rayonGroups).forEach(([id, rows]) => {
      counts[id] = rows.length;
    });
    counts['all'] = stockData.length;
    return counts;
  }, [rayonGroups, stockData]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    let rows = activeRayon === 'all' ? stockData : (rayonGroups[activeRayon] || []);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.ingredient.name.toLowerCase().includes(q));
    }
    if (mode === 'inventory' && showOnlyUncounted) {
      rows = rows.filter(r => inventoryInputs[r.ingredient.id] === '' || inventoryInputs[r.ingredient.id] === undefined);
    }
    return rows;
  }, [stockData, rayonGroups, activeRayon, search, mode, showOnlyUncounted, inventoryInputs]);

  // Grouped filtered rows for inventory mode
  const groupedFiltered = useMemo(() => {
    if (activeRayon !== 'all') return { [activeRayon]: filteredRows };
    const groups: Record<string, StockRow[]> = {};
    filteredRows.forEach(row => {
      const id = getRayon(row.ingredient.name);
      if (!groups[id]) groups[id] = [];
      groups[id].push(row);
    });
    return groups;
  }, [filteredRows, activeRayon]);

  const exportCSV = () => {
    downloadCSV(stockData.map(r => ({
      Ingrédient: r.ingredient.name,
      Rayon: RAYONS.find(ray => ray.id === getRayon(r.ingredient.name))?.label || 'Autre',
      Unité: r.ingredient.unit || '',
      'Stock physique': r.stockPhysique ?? '',
      'Compté le': r.countedAt ? String(r.countedAt).slice(0, 10) : '',
      'Prix unitaire': r.ingredient.last_unit_price ?? '',
      'Valorisation (€)': r.valorisation.toFixed(2),
    })), 'stock-qentina');
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="page-header">
        <h2>Stock & Inventaire</h2>
        <div className="page-header-actions">
          {mode === 'view' ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={exportCSV}><Download size={16} /> CSV</button>
              <button
                className="btn btn-primary"
                style={{ background: 'var(--orange)', borderColor: 'var(--orange)' }}
                onClick={runAudit}
                disabled={auditLoading}
              >
                <Flame size={18} className={auditLoading ? 'spinning' : ''} />
                {auditLoading ? 'Analyse en cours...' : 'Audit Fuego IA'}
              </button>
              <button className="btn btn-primary" onClick={() => { setMode('inventory'); setInventoryInputs({}); }}>
                <Layers size={18} /> Faire l'inventaire
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, color: 'var(--teal)', fontSize: 15 }}>{countedCount}/{stockData.length}</span> produits comptés
              </div>
              <button className="btn btn-secondary" onClick={() => { setMode('view'); setInventoryInputs({}); }}>
                <X size={16} /> Annuler
              </button>
              <button className="btn btn-primary" onClick={handleSaveInventory} disabled={saving || countedCount === 0}>
                <Save size={16} /> {saving ? 'Enregistrement...' : `Valider (${countedCount})`}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="page-body">
        {/* ── AI Audit Panel ─────────────────────────────────────────── */}
        {auditDone && anomalies.length > 0 && showAuditPanel && (() => {
          const visible = anomalies.filter(a => !dismissedIds.has(a.ingredient_id + a.type));
          const highCount = visible.filter(a => a.severity === 'high').length;
          const SEVERITY_CONFIG = {
            high:   { label: 'Critique',  color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: '#ef4444' },
            medium: { label: 'Moyen',     color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: '#f59e0b' },
            low:    { label: 'Faible',    color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', border: '#8b5cf6' },
          };
          const TYPE_LABELS: Record<AnomalyType, string> = {
            conditionnement: '📦 Conditionnement',
            prix_aberrant:   '💸 Prix aberrant',
            unite_incorrecte:'📐 Unité incorrecte',
            quantite_absurde:'📊 Quantité absurde',
            prix_manquant:   '❓ Prix manquant',
          };
          if (visible.length === 0) return (
            <SuccessBanner text="Toutes les anomalies ont été traitées ✅" onClose={() => setShowAuditPanel(false)} />
          );
          return (
            <div style={{ marginBottom: 24 }}>
              {/* Header */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(249,115,22,0.08), rgba(239,68,68,0.05))',
                border: '1.5px solid var(--orange)',
                borderRadius: '12px 12px 0 0',
                padding: '14px 18px',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <Flame size={20} style={{ color: 'var(--orange)' }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--orange)' }}>Fuego IA — Audit référentiel produits</span>
                  <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 10 }}>
                    {visible.length} anomalie{visible.length > 1 ? 's' : ''} détectée{visible.length > 1 ? 's' : ''}
                    {highCount > 0 && <span style={{ color: '#ef4444', fontWeight: 700, marginLeft: 6 }}>({highCount} critique{highCount > 1 ? 's' : ''})</span>}
                  </span>
                </div>
                <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setShowAuditPanel(false)}><X size={18} /></button>
              </div>

              {/* Anomaly cards */}
              <div style={{
                border: '1.5px solid var(--orange)',
                borderTop: 'none',
                borderRadius: '0 0 12px 12px',
                overflow: 'hidden',
                background: 'white',
              }}>
                {visible.map((anomaly, idx) => {
                  const sc = SEVERITY_CONFIG[anomaly.severity];
                  return (
                    <div
                      key={anomaly.ingredient_id + anomaly.type}
                      style={{
                        padding: '14px 18px',
                        borderBottom: idx < visible.length - 1 ? '1px solid var(--border-light)' : 'none',
                        background: idx % 2 === 0 ? 'white' : 'var(--cream-light)',
                        display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
                      }}
                    >
                      {/* Severity dot */}
                      <div style={{ marginTop: 2, flexShrink: 0 }}>
                        <div style={{
                          width: 10, height: 10, borderRadius: '50%',
                          background: sc.color,
                          boxShadow: `0 0 6px ${sc.color}80`,
                        }} />
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{anomaly.ingredient_name}</span>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                            background: sc.bg, color: sc.color, border: `1px solid ${sc.border}40`,
                          }}>{sc.label}</span>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                            background: 'var(--cream)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                          }}>{TYPE_LABELS[anomaly.type]}</span>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
                          {anomaly.description}
                        </div>
                        {/* Current vs Suggested */}
                        <div style={{ display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' }}>
                          {anomaly.current_unit && (
                            <span style={{ color: 'var(--text-muted)' }}>
                              Unité actuelle : <strong style={{ color: 'var(--text-secondary)' }}>{anomaly.current_unit}</strong>
                              {anomaly.suggestion_unit && anomaly.suggestion_unit !== anomaly.current_unit && (
                                <> → <strong style={{ color: 'var(--teal)' }}>{anomaly.suggestion_unit}</strong></>
                              )}
                            </span>
                          )}
                          {anomaly.current_price != null && (
                            <span style={{ color: 'var(--text-muted)' }}>
                              Prix actuel : <strong style={{ color: '#ef4444' }}>{formatCurrency(anomaly.current_price)}</strong>
                              {anomaly.suggestion_price != null && (
                                <> → <strong style={{ color: 'var(--green)' }}>{formatCurrency(anomaly.suggestion_price)}</strong></>
                              )}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ fontSize: 12 }}
                          onClick={() => openFix(anomaly)}
                        >
                          <Edit2 size={13} /> Corriger
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          title="Ignorer"
                          onClick={() => dismissAnomaly(anomaly)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── Loading audit ─────────────────────────────────────────────── */}
        {auditLoading && (
          <div style={{
            background: 'linear-gradient(135deg, rgba(249,115,22,0.06), transparent)',
            border: '1.5px solid var(--orange)', borderRadius: 12,
            padding: '20px 24px', marginBottom: 24,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <Flame size={24} className="spinning" style={{ color: 'var(--orange)' }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--orange)' }}>Fuego IA analyse vos produits...</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Claude examine les prix, unités et conditionnements. Cela prend 10 à 30 secondes.</div>
            </div>
          </div>
        )}

        {/* ── audit empty result ─────────────────────────────────────────── */}
        {auditDone && anomalies.length === 0 && (
          <SuccessBanner text="Aucune anomalie détectée — votre référentiel produits est cohérent ✅" onClose={() => setAuditDone(false)} />
        )}

        {/* ── KPI Cards ──────────────────────────────────────────────────── */}
        {mode === 'view' && (
          <div className="kpi-grid" style={{ marginBottom: 24 }}>
            <div className="kpi-card" style={{ borderLeft: '4px solid var(--teal)' }}>
              <div className="kpi-label"><Package size={16} /> Stock valorisé total</div>
              <div className="kpi-value">{formatCurrency(totalValo)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Ingrédients suivis</div>
              <div className="kpi-value">{stockData.length}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><CheckCircle2 size={16} /> Comptés</div>
              <div className="kpi-value">{stockData.filter(s => s.stockPhysique !== null).length}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><History size={16} /> Dernier inventaire</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{history[0] ? formatDate(history[0].day) : '—'}</div>
            </div>
          </div>
        )}

        {/* ── Historique des inventaires ─────────────────────────────────── */}
        {mode === 'view' && history.length > 0 && (
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <div>
                <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <History size={18} style={{ color: 'var(--teal)' }} /> Historique des inventaires
                </div>
                <div className="card-subtitle">
                  Chaque ligne est une journée de comptage, valorisée aux prix du jour. La valorisation
                  ci-dessus, elle, reprend le dernier comptage de chaque produit au prix d&apos;achat actuel.
                </div>
              </div>
            </div>
            <div className="table-container">
              <table>
                <thead>
                  <tr><th>Date</th><th style={{ textAlign: 'right' }}>Produits comptés</th><th style={{ textAlign: 'right' }}>Valorisation</th></tr>
                </thead>
                <tbody>
                  {history.slice(0, 12).map(h => (
                    <tr key={h.day}>
                      <td style={{ fontWeight: 600 }}>{formatDate(h.day)}</td>
                      <td style={{ textAlign: 'right' }}>{h.products}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatCurrency(h.valorisation)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Inventory Progress Banner ───────────────────────────────────── */}
        {mode === 'inventory' && (
          <div style={{
            background: 'white',
            borderRadius: 12,
            padding: '16px 20px',
            marginBottom: 20,
            border: '1px solid var(--border)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Zap size={18} style={{ color: 'var(--teal)' }} />
                <span style={{ fontWeight: 700, fontSize: 15 }}>Inventaire en cours</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={showOnlyUncounted}
                    onChange={e => setShowOnlyUncounted(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: 'var(--teal)' }}
                  />
                  Masquer les comptés
                </label>
                <span style={{ fontSize: 14, fontWeight: 800, color: progressPct === 100 ? 'var(--green)' : 'var(--teal)' }}>
                  {progressPct}%
                </span>
              </div>
            </div>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${progressPct}%`,
                background: progressPct === 100
                  ? 'linear-gradient(90deg, var(--green), #4ade80)'
                  : 'linear-gradient(90deg, var(--teal), var(--teal-light))',
                borderRadius: 99,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              <span>{countedCount} produits comptés</span>
              <span>{stockData.length - countedCount} restants</span>
            </div>
          </div>
        )}

        {/* ── Search + Filter Bar ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              className="form-input"
              style={{ paddingLeft: 38, width: '100%' }}
              placeholder="Rechercher un produit..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                onClick={() => setSearch('')}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={loadData} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spinning' : ''} />
          </button>
        </div>

        {/* ── Rayon Tabs ─────────────────────────────────────────────────── */}
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 8, minWidth: 'max-content', paddingBottom: 4 }}>
            {/* All tab */}
            <RayonPill
              label="Tous"
              emoji="🗂️"
              count={rayonCounts['all'] || 0}
              active={activeRayon === 'all'}
              color="var(--teal)"
              activeBg="var(--teal-bg)"
              onClick={() => setActiveRayon('all')}
            />

            {RAYONS.map(rayon => {
              const count = rayonCounts[rayon.id] || 0;
              if (count === 0) return null;
              const countedInRayon = mode === 'inventory'
                ? (rayonGroups[rayon.id] || []).filter(r => inventoryInputs[r.ingredient.id] !== '' && inventoryInputs[r.ingredient.id] !== undefined).length
                : 0;
              const allCounted = mode === 'inventory' && countedInRayon === count && count > 0;
              return (
                <RayonPill
                  key={rayon.id}
                  label={rayon.label}
                  emoji={allCounted ? '✅' : rayon.emoji}
                  count={mode === 'inventory' ? `${countedInRayon}/${count}` : count}
                  active={activeRayon === rayon.id}
                  color={rayon.color}
                  completed={allCounted}
                  onClick={() => setActiveRayon(rayon.id)}
                />
              );
            })}

            {/* Autre tab */}
            {(rayonCounts['autre'] || 0) > 0 && (
              <RayonPill
                label="Autres"
                emoji="📋"
                count={rayonCounts['autre']}
                active={activeRayon === 'autre'}
                color="#64748b"
                activeBg="#94a3b820"
                onClick={() => setActiveRayon('autre')}
              />
            )}
          </div>
        </div>

        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state"><Package size={48} /><p>Aucun produit trouvé</p></div>
        ) : (
          <>
            {/* ── VIEW MODE ─────────────────────────────────────────────── */}
            {mode === 'view' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {Object.entries(groupedFiltered).map(([rayonId, rows]) => {
                  if (rows.length === 0) return null;
                  const rayon = RAYONS.find(r => r.id === rayonId);
                  return (
                    <div key={rayonId}>
                      {activeRayon === 'all' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 20 }}>{rayon?.emoji || '📋'}</span>
                          <h3 style={{ fontSize: 15, fontWeight: 700, color: rayon?.color || '#64748b' }}>
                            {rayon?.label || 'Autres'}
                          </h3>
                          <div style={{ flex: 1, height: 1, background: `${rayon?.color || '#94a3b8'}30` }} />
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} produits</span>
                        </div>
                      )}
                      <div className="table-container">
                        <table>
                          <thead>
                            <tr>
                              <th>Produit</th>
                              <th>Unité</th>
                              <th style={{ textAlign: 'right' }}>Stock compté</th>
                              <th style={{ textAlign: 'right' }}>Compté le</th>
                              <th style={{ textAlign: 'right' }}>Prix unitaire</th>
                              <th style={{ textAlign: 'right' }}>Valorisation</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(row => (
                              <tr
                                key={row.ingredient.id}
                                style={{ cursor: 'pointer' }}
                                onClick={() => setSelectedRow(row)}
                              >
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    {row.stockPhysique !== null
                                      ? <CheckCircle2 size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
                                      : <Clock size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                    }
                                    <span style={{ fontWeight: 600 }}>{row.ingredient.name}</span>
                                  </div>
                                </td>
                                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{row.ingredient.unit || '—'}</td>
                                <td style={{ textAlign: 'right', fontWeight: 600, color: row.stockPhysique !== null ? 'var(--teal)' : 'var(--text-muted)' }}>
                                  {row.stockPhysique !== null ? row.stockPhysique.toFixed(2) : 'Non compté'}
                                </td>
                                <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                                  {row.countedAt ? formatDate(String(row.countedAt).slice(0, 10)) : '—'}
                                </td>
                                <td style={{ textAlign: 'right', fontSize: 13 }}>
                                  {row.ingredient.last_unit_price ? formatCurrency(row.ingredient.last_unit_price) : '—'}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.stockPhysique !== null ? formatCurrency(row.valorisation) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── INVENTORY MODE ─────────────────────────────────────────── */}
            {mode === 'inventory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {Object.entries(groupedFiltered).map(([rayonId, rows]) => {
                  if (rows.length === 0) return null;
                  const rayon = RAYONS.find(r => r.id === rayonId);
                  const countedInGroup = rows.filter(r => inventoryInputs[r.ingredient.id] !== '' && inventoryInputs[r.ingredient.id] !== undefined).length;
                  return (
                    <div key={rayonId}>
                      {/* Rayon Header */}
                      {activeRayon === 'all' && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                          padding: '10px 14px',
                          background: `${rayon?.color || '#94a3b8'}10`,
                          border: `1px solid ${rayon?.color || '#94a3b8'}30`,
                          borderRadius: 10,
                        }}>
                          <span style={{ fontSize: 22 }}>{rayon?.emoji || '📋'}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, fontSize: 14, color: rayon?.color || '#64748b' }}>
                              {rayon?.label || 'Autres'}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                              {countedInGroup}/{rows.length} comptés
                            </div>
                          </div>
                          {/* Mini progress */}
                          <div style={{ width: 80, height: 6, background: 'rgba(0,0,0,0.1)', borderRadius: 99, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%',
                              width: `${rows.length > 0 ? (countedInGroup / rows.length) * 100 : 0}%`,
                              background: countedInGroup === rows.length ? 'var(--green)' : (rayon?.color || '#64748b'),
                              borderRadius: 99, transition: 'width 0.3s',
                            }} />
                          </div>
                        </div>
                      )}

                      {/* Product Cards Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                        {rows.map(row => {
                          const value = inventoryInputs[row.ingredient.id];
                          const isCounted = value !== '' && value !== undefined;
                          const rayon = RAYONS.find(r => r.id === getRayon(row.ingredient.name));
                          return (
                            <div
                              key={row.ingredient.id}
                              style={{
                                background: isCounted ? 'var(--green-light)' : 'white',
                                border: isCounted ? '2px solid var(--green)' : '1.5px solid var(--border)',
                                borderRadius: 12,
                                padding: '12px 14px',
                                transition: 'all 0.2s',
                                boxShadow: isCounted ? 'none' : '0 1px 4px rgba(0,0,0,0.04)',
                              }}
                            >
                              {/* Product name + status */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: isCounted ? 'var(--green)' : 'var(--text-primary)' }}>
                                    {row.ingredient.name}
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                    {row.stockPhysique !== null
                                      ? <>Dernier comptage : <strong>{row.stockPhysique.toFixed(2)} {row.ingredient.unit || ''}</strong>{row.countedAt ? ` le ${formatDate(String(row.countedAt).slice(0, 10))}` : ''}</>
                                      : 'Jamais compté'}
                                  </div>
                                </div>
                                {isCounted
                                  ? <CheckCircle2 size={20} style={{ color: 'var(--green)', flexShrink: 0, marginLeft: 8 }} />
                                  : <Clock size={18} style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8 }} />
                                }
                              </div>

                              {/* Input row */}
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  className="form-input"
                                  style={{
                                    flex: 1,
                                    fontWeight: 700,
                                    fontSize: 16,
                                    textAlign: 'center',
                                    background: isCounted ? 'white' : undefined,
                                    borderColor: isCounted ? 'var(--green)' : undefined,
                                    color: isCounted ? 'var(--green)' : undefined,
                                  }}
                                  value={value ?? ''}
                                  onChange={e => setInventoryInputs(p => ({ ...p, [row.ingredient.id]: e.target.value }))}
                                  placeholder="0"
                                  onFocus={e => e.target.select()}
                                />
                                <span style={{
                                  fontSize: 12, fontWeight: 600,
                                  color: isCounted ? 'var(--green)' : 'var(--text-muted)',
                                  minWidth: 28,
                                }}>
                                  {row.ingredient.unit || 'u.'}
                                </span>
                                {isCounted && (
                                  <button
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
                                    onClick={() => setInventoryInputs(p => { const n = { ...p }; delete n[row.ingredient.id]; return n; })}
                                    title="Effacer"
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </div>

                              {/* Variation depuis le dernier comptage : une information, pas une alerte */}
                              {isCounted && row.stockPhysique !== null && (
                                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                                  {(() => {
                                    const delta = parseFloat(value) - row.stockPhysique;
                                    if (!Number.isFinite(delta) || Math.abs(delta) < 0.005) return 'Identique au dernier comptage';
                                    return `${delta > 0 ? '+' : ''}${delta.toFixed(2)} ${row.ingredient.unit || ''} depuis le dernier comptage`;
                                  })()}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Sticky save button at bottom */}
                {countedCount > 0 && (
                  <div style={{
                    position: 'sticky', bottom: 20,
                    display: 'flex', justifyContent: 'center',
                    zIndex: 50,
                  }}>
                    <button
                      className="btn btn-primary"
                      style={{
                        padding: '14px 36px',
                        fontSize: 15, fontWeight: 700,
                        boxShadow: '0 8px 24px rgba(42,125,123,0.35)',
                        borderRadius: 99,
                      }}
                      onClick={handleSaveInventory}
                      disabled={saving}
                    >
                      <Save size={18} />
                      {saving ? 'Enregistrement...' : `✅ Valider l'inventaire (${countedCount} produits)`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Detail Modal (view mode) ──────────────────────────────────────── */}
      {selectedRow && mode === 'view' && (
        <div className="modal-overlay" onClick={() => setSelectedRow(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{selectedRow.ingredient.name}</div>
              <button className="modal-close" onClick={() => setSelectedRow(null)}><X size={20} /></button>
            </div>

            {/* Rayon badge */}
            {(() => {
              const rayon = RAYONS.find(r => r.id === getRayon(selectedRow.ingredient.name));
              if (!rayon) return null;
              return (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: `${rayon.color}18`, color: rayon.color,
                  padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                  border: `1px solid ${rayon.color}40`, marginBottom: 16,
                }}>
                  {rayon.emoji} {rayon.label}
                </div>
              );
            })()}

            <div className="grid-2" style={{ gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Prix unitaire', value: formatCurrency(selectedRow.ingredient.last_unit_price), color: 'var(--teal)' },
                { label: 'Unité', value: selectedRow.ingredient.unit || '—', color: 'var(--text-primary)' },
                { label: 'Stock compté', value: selectedRow.stockPhysique !== null ? `${selectedRow.stockPhysique.toFixed(2)} ${selectedRow.ingredient.unit || ''}` : 'Non compté', color: selectedRow.stockPhysique !== null ? 'var(--teal)' : 'var(--text-muted)' },
                { label: 'Compté le', value: selectedRow.countedAt ? formatDate(String(selectedRow.countedAt).slice(0, 10)) : '—', color: 'var(--text-secondary)' },
              ].map(kpi => (
                <div key={kpi.label} className="card" style={{ textAlign: 'center', padding: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{kpi.label.toUpperCase()}</div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: kpi.color }}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {/* Valorisation : dernier comptage × prix d'achat actuel */}
            <div className="card" style={{ textAlign: 'center', background: 'var(--teal-bg)', border: '1px solid var(--teal)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>VALORISATION</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--teal)' }}>
                {selectedRow.stockPhysique !== null ? formatCurrency(selectedRow.valorisation) : '—'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>dernier comptage × prix d&apos;achat actuel</div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedRow(null)}>Fermer</button>
              <button className="btn btn-primary" onClick={() => {
                setSelectedRow(null);
                setMode('inventory');
                setActiveRayon('all');
                setSearch(selectedRow.ingredient.name);
                setInventoryInputs({});
              }}>
                <Layers size={16} /> Compter ce produit
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Fix Modal (AI Audit) ──────────────────────────────────────────── */}
      {fixingAnomaly && (
        <div className="modal-overlay" onClick={() => setFixingAnomaly(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Corriger : {fixingAnomaly.ingredient_name}</div>
              <button className="modal-close" onClick={() => setFixingAnomaly(null)}><X size={20} /></button>
            </div>

            {/* Problem description */}
            <div style={{
              background: 'rgba(249,115,22,0.06)',
              border: '1px solid var(--orange)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 20,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--orange)', marginBottom: 4 }}>🔥 Anomalie détectée</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{fixingAnomaly.description}</div>
              {fixingAnomaly.reason && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>{fixingAnomaly.reason}</div>
              )}
            </div>

            {/* Fix form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">
                  Unité
                  {fixingAnomaly.suggestion_unit && fixingAnomaly.suggestion_unit !== fixingAnomaly.current_unit && (
                    <span style={{ fontSize: 11, color: 'var(--teal)', marginLeft: 8, fontWeight: 400 }}>
                      Suggéré : <strong>{fixingAnomaly.suggestion_unit}</strong>
                    </span>
                  )}
                </label>
                <select
                  className="form-select"
                  value={fixUnit}
                  onChange={e => setFixUnit(e.target.value)}
                >
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">
                  Prix unitaire (€ HT)
                  {fixingAnomaly.suggestion_price != null && (
                    <span style={{ fontSize: 11, color: 'var(--teal)', marginLeft: 8, fontWeight: 400 }}>
                      Suggéré : <strong>{fixingAnomaly.suggestion_price} €</strong>
                    </span>
                  )}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    className="form-input"
                    value={fixPrice}
                    onChange={e => setFixPrice(e.target.value)}
                    placeholder="Ex: 1.30"
                    style={{ paddingRight: 32 }}
                  />
                  <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14 }}>€</span>
                </div>
                {fixingAnomaly.suggestion_price != null && (
                  <button
                    style={{ marginTop: 6, fontSize: 12, color: 'var(--teal)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                    onClick={() => setFixPrice(String(fixingAnomaly.suggestion_price))}
                  >
                    ← Appliquer le prix suggéré ({fixingAnomaly.suggestion_price} €)
                  </button>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setFixingAnomaly(null)}>Annuler</button>
              <button className="btn btn-primary" onClick={handleFix} disabled={fixSaving}>
                <Check size={16} /> {fixSaving ? 'Enregistrement...' : 'Enregistrer la correction'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
