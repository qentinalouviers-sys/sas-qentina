'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatPercent, RECIPE_CATEGORY_LABELS, FOOD_COST_TARGET } from '@/lib/utils';
import {
  Star, TrendingDown, AlertTriangle, Flame, X, Info, Search,
  BarChart2, Grid, RefreshCw
} from 'lucide-react';
import type { Recipe, RecipeIngredient, Ingredient, RecipeCategory } from '@/lib/types';
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';

// ─── Types ──────────────────────────────────────────────────────────────────

type BCGQuadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';

interface MenuItemAnalysis {
  id: string;
  name: string;
  category: RecipeCategory;
  selling_price: number;
  food_cost_pct: number;
  marge_pct: number;
  marge_euro: number;
  cost_per_portion: number;
  qty_sold: number;
  revenue: number;
  quadrant: BCGQuadrant;
  popularity_index: number; // % vs average
  profitability_index: number; // marge vs average
}

// ─── BCG quadrant config ─────────────────────────────────────────────────────

const QUADRANT_CONFIG: Record<BCGQuadrant, {
  label: string;
  sublabel: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: React.ElementType;
  advice: string;
}> = {
  star: {
    label: '⭐ Stars',
    sublabel: 'Populaires & rentables',
    color: '#f59e0b',
    bgColor: 'rgba(245,158,11,0.1)',
    borderColor: '#f59e0b',
    icon: Star,
    advice: 'Mettez en avant ces plats, ils sont vos champions. Maintenez la qualité et la visibilité carte.',
  },
  plowhorse: {
    label: '🐂 Vaches à lait',
    sublabel: 'Populaires mais peu rentables',
    color: '#3b82f6',
    bgColor: 'rgba(59,130,246,0.1)',
    borderColor: '#3b82f6',
    icon: TrendingDown,
    advice: 'Très vendus mais marges faibles. Cherchez à réduire le coût matière ou à augmenter légèrement le prix.',
  },
  puzzle: {
    label: '❓ Puzzles',
    sublabel: 'Rentables mais peu vendus',
    color: '#8b5cf6',
    bgColor: 'rgba(139,92,246,0.1)',
    borderColor: '#8b5cf6',
    icon: AlertTriangle,
    advice: 'Bonne rentabilité mais visibilité faible. Mettez en avant via le menu, le personnel ou des promotions ciblées.',
  },
  dog: {
    label: '🐕 Dogs',
    sublabel: 'Peu vendus & peu rentables',
    color: '#ef4444',
    bgColor: 'rgba(239,68,68,0.1)',
    borderColor: '#ef4444',
    icon: Flame,
    advice: 'Candidats à la suppression du menu. Sauf si rôle stratégique (image, offre complète), envisagez de les retirer.',
  },
};

// ─── Helper: unit conversion ─────────────────────────────────────────────────

function convertQuantity(quantity: number, fromUnit: string, toUnit: string): number {
  const from = (fromUnit || '').toLowerCase().trim();
  const to = (toUnit || '').toLowerCase().trim();
  if (from === to) return quantity;
  let valInBase = quantity;
  if (from === 'g' || from === 'gr' || from === 'ml') valInBase = quantity / 1000;
  else if (from === 'cl') valInBase = quantity / 100;
  else if (from === 'kg' || from === 'l') valInBase = quantity;
  else return quantity;
  if (to === 'kg' || to === 'l') return valInBase;
  if (to === 'g' || to === 'gr' || to === 'ml') return valInBase * 1000;
  if (to === 'cl') return valInBase * 100;
  return quantity;
}

type RecipeWithIngredients = Recipe & {
  recipe_ingredients: (RecipeIngredient & { ingredient: Ingredient })[];
};

function calcRecipeCost(ri: any[], allRecipes: any[]): number {
  return ri?.reduce((s: number, r: any) => {
    if (r.ingredient_id && r.ingredient) {
      const qty = convertQuantity(r.quantity || 0, r.unit || '', r.ingredient?.unit || '');
      return s + qty * (r.ingredient?.last_unit_price || 0);
    } else if (r.sub_recipe_id) {
      const sub = allRecipes.find((rec: any) => rec.id === r.sub_recipe_id);
      if (sub) {
        const subCost = calcRecipeCost(sub.recipe_ingredients, allRecipes);
        const cpp = sub.portions > 0 ? subCost / sub.portions : subCost;
        return s + (r.quantity || 0) * cpp;
      }
    }
    return s;
  }, 0) || 0;
}

// ─── Custom Tooltip for ScatterChart ────────────────────────────────────────

function CustomScatterTooltip({ active, payload }: any) {
  if (active && payload && payload.length) {
    const d = payload[0].payload as MenuItemAnalysis;
    const qConf = QUADRANT_CONFIG[d.quadrant];
    return (
      <div style={{
        background: 'var(--card-bg)',
        border: `1px solid ${qConf.borderColor}`,
        borderRadius: 10,
        padding: '12px 16px',
        minWidth: 200,
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{d.name}</div>
        <div style={{ fontSize: 12, color: qConf.color, marginBottom: 8 }}>{qConf.label}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Qté vendue</span>
          <span style={{ fontWeight: 600 }}>{d.qty_sold}</span>
          <span style={{ color: 'var(--text-muted)' }}>Marge brute</span>
          <span style={{ fontWeight: 600, color: 'var(--green)' }}>{formatPercent(d.marge_pct)}</span>
          <span style={{ color: 'var(--text-muted)' }}>Food cost</span>
          <span style={{ fontWeight: 600, color: d.food_cost_pct > FOOD_COST_TARGET ? 'var(--red)' : 'var(--green)' }}>{formatPercent(d.food_cost_pct)}</span>
          <span style={{ color: 'var(--text-muted)' }}>Prix vente</span>
          <span style={{ fontWeight: 600 }}>{formatCurrency(d.selling_price)}</span>
          <span style={{ color: 'var(--text-muted)' }}>Coût matière</span>
          <span style={{ fontWeight: 600 }}>{formatCurrency(d.cost_per_portion)}</span>
          <span style={{ color: 'var(--text-muted)' }}>CA généré</span>
          <span style={{ fontWeight: 600 }}>{formatCurrency(d.revenue)}</span>
        </div>
      </div>
    );
  }
  return null;
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function MenuEngineeringPage() {
  const [recipes, setRecipes] = useState<RecipeWithIngredients[]>([]);
  const [salesMap, setSalesMap] = useState<Record<string, { qty: number; revenue: number }>>({});
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'matrix' | 'table'>('matrix');
  const [filterQuadrant, setFilterQuadrant] = useState<BCGQuadrant | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<RecipeCategory | ''>('');
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<MenuItemAnalysis | null>(null);
  const [period, setPeriod] = useState<'month' | 'quarter' | 'year' | 'all'>('month');

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);

    // Load recipes with ingredients
    const { data: rec } = await supabase
      .from('recipes')
      .select('*, recipe_ingredients!recipe_ingredients_recipe_id_fkey(*, ingredient:ingredients(*))')
      .order('name');
    const loadedRecipes = (rec as RecipeWithIngredients[]) || [];
    setRecipes(loadedRecipes);

    // Determine date range for sales
    const now = new Date();
    let dateFrom: string | null = null;
    if (period === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFrom = d.toISOString().split('T')[0];
    } else if (period === 'quarter') {
      const q = Math.floor(now.getMonth() / 3);
      const d = new Date(now.getFullYear(), q * 3, 1);
      dateFrom = d.toISOString().split('T')[0];
    } else if (period === 'year') {
      dateFrom = `${now.getFullYear()}-01-01`;
    }

    // Load square items (sales data)
    let query = supabase.from('square_items').select('name, quantity, total_price, order_id');
    if (dateFrom) {
      // Join with orders filtered by date
      const { data: orders } = await supabase
        .from('square_orders')
        .select('id')
        .gte('service', dateFrom);
      if (orders && orders.length > 0) {
        const orderIds = orders.map((o: any) => o.id);
        query = query.in('order_id', orderIds);
      } else {
        // No orders in period
        setSalesMap({});
        setLoading(false);
        return;
      }
    }

    const { data: items } = await query;
    const map: Record<string, { qty: number; revenue: number }> = {};
    if (items) {
      items.forEach((item: any) => {
        const name = (item.name || '').trim().toLowerCase();
        if (!map[name]) map[name] = { qty: 0, revenue: 0 };
        map[name].qty += item.quantity || 1;
        map[name].revenue += item.total_price || 0;
      });
    }
    setSalesMap(map);
    setLoading(false);
  }, [supabase, period]);

  useEffect(() => { loadData(); }, [loadData]);

  // ─── Compute BCG Matrix ────────────────────────────────────────────────────
  const analysis = useMemo<MenuItemAnalysis[]>(() => {
    // Only analyze sellable recipes (not base sauces or protocols)
    const sellable = recipes.filter(r =>
      r.selling_price && r.selling_price > 0 &&
      !['protocole_pate', 'base_sauce'].includes(r.category)
    );

    const items = sellable.map(recipe => {
      const cost = calcRecipeCost(recipe.recipe_ingredients || [], recipes);
      const cpp = recipe.portions > 0 ? cost / recipe.portions : cost;
      const price = recipe.selling_price || 0;
      const marge_euro = price - cpp;
      const marge_pct = price > 0 ? (marge_euro / price) * 100 : 0;
      const food_cost_pct = price > 0 ? (cpp / price) * 100 : 0;

      // Match sales data by name (case-insensitive)
      const nameLower = recipe.name.trim().toLowerCase();
      const salesData = salesMap[nameLower] || { qty: 0, revenue: 0 };

      return {
        id: recipe.id,
        name: recipe.name,
        category: recipe.category,
        selling_price: price,
        cost_per_portion: cpp,
        food_cost_pct,
        marge_pct,
        marge_euro,
        qty_sold: salesData.qty,
        revenue: salesData.revenue,
        quadrant: 'dog' as BCGQuadrant, // placeholder
        popularity_index: 0,
        profitability_index: 0,
      };
    });

    if (items.length === 0) return [];

    // Compute averages for BCG classification
    const totalQty = items.reduce((s, i) => s + i.qty_sold, 0);
    const avgQtyPerItem = totalQty / items.length;
    const avgMarge = items.reduce((s, i) => s + i.marge_pct, 0) / items.length;

    return items.map(item => {
      const popularity_index = avgQtyPerItem > 0 ? (item.qty_sold / avgQtyPerItem) * 100 : 0;
      const profitability_index = item.marge_pct - avgMarge; // deviation from average
      const isPopular = item.qty_sold >= avgQtyPerItem;
      const isProfitable = item.marge_pct >= avgMarge;
      let quadrant: BCGQuadrant;
      if (isPopular && isProfitable) quadrant = 'star';
      else if (isPopular && !isProfitable) quadrant = 'plowhorse';
      else if (!isPopular && isProfitable) quadrant = 'puzzle';
      else quadrant = 'dog';

      return { ...item, quadrant, popularity_index, profitability_index };
    });
  }, [recipes, salesMap]);

  // ─── Filtered items ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return analysis.filter(item => {
      if (filterQuadrant !== 'all' && item.quadrant !== filterQuadrant) return false;
      if (filterCategory && item.category !== filterCategory) return false;
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [analysis, filterQuadrant, filterCategory, search]);

  // ─── Stats per quadrant ────────────────────────────────────────────────────
  const quadrantStats = useMemo(() => {
    const stats: Record<BCGQuadrant, { count: number; revenue: number; avgMarge: number }> = {
      star: { count: 0, revenue: 0, avgMarge: 0 },
      plowhorse: { count: 0, revenue: 0, avgMarge: 0 },
      puzzle: { count: 0, revenue: 0, avgMarge: 0 },
      dog: { count: 0, revenue: 0, avgMarge: 0 },
    };
    analysis.forEach(item => {
      stats[item.quadrant].count++;
      stats[item.quadrant].revenue += item.revenue;
      stats[item.quadrant].avgMarge += item.marge_pct;
    });
    (Object.keys(stats) as BCGQuadrant[]).forEach(q => {
      if (stats[q].count > 0) stats[q].avgMarge /= stats[q].count;
    });
    return stats;
  }, [analysis]);

  // ─── Scatter data ──────────────────────────────────────────────────────────
  const scatterData = useMemo(() => {
    return analysis.map(item => ({
      ...item,
      x: item.qty_sold,      // popularity
      y: item.marge_pct,     // profitability
      z: Math.max(item.revenue, 10),  // bubble size
    }));
  }, [analysis]);

  const avgQty = analysis.length > 0 ? analysis.reduce((s, i) => s + i.qty_sold, 0) / analysis.length : 0;
  const avgMarge = analysis.length > 0 ? analysis.reduce((s, i) => s + i.marge_pct, 0) / analysis.length : 0;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="page-header">
        <h2>Menu Engineering</h2>
        <div className="page-header-actions">
          {/* Period selector */}
          <div className="period-selector">
            {(['month', 'quarter', 'year', 'all'] as const).map(p => (
              <button
                key={p}
                className={`period-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {p === 'month' ? 'Ce mois' : p === 'quarter' ? 'Ce trimestre' : p === 'year' ? 'Cette année' : 'Tout'}
              </button>
            ))}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={loadData}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 36, height: 36 }} /></div>
        ) : (
          <>
            {/* ── BCG Summary Cards ──────────────────────────────────────── */}
            <div className="grid-4" style={{ marginBottom: 24 }}>
              {(Object.keys(QUADRANT_CONFIG) as BCGQuadrant[]).map(q => {
                const conf = QUADRANT_CONFIG[q];
                const stats = quadrantStats[q];
                const Icon = conf.icon;
                return (
                  <div
                    key={q}
                    className="card"
                    style={{
                      borderLeft: `4px solid ${conf.borderColor}`,
                      background: filterQuadrant === q ? conf.bgColor : undefined,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onClick={() => setFilterQuadrant(prev => prev === q ? 'all' : q)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: conf.color }}>{conf.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{conf.sublabel}</div>
                      </div>
                      <Icon size={20} style={{ color: conf.color, opacity: 0.7 }} />
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: conf.color }}>{stats.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {formatCurrency(stats.revenue)} CA · {formatPercent(stats.avgMarge)} marge moy.
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── View Mode Toggle + Filters ─────────────────────────────── */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className={`btn btn-sm ${viewMode === 'matrix' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setViewMode('matrix')}
                >
                  <BarChart2 size={15} /> Matrice
                </button>
                <button
                  className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setViewMode('table')}
                >
                  <Grid size={15} /> Tableau
                </button>
              </div>

              {/* Category filter */}
              <select
                className="form-select"
                style={{ maxWidth: 180 }}
                value={filterCategory}
                onChange={e => setFilterCategory(e.target.value as RecipeCategory | '')}
              >
                <option value="">Toutes catégories</option>
                {Object.entries(RECIPE_CATEGORY_LABELS)
                  .filter(([k]) => !['protocole_pate', 'base_sauce'].includes(k))
                  .map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
              </select>

              {/* Search */}
              <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  className="form-input"
                  style={{ paddingLeft: 32, width: '100%' }}
                  placeholder="Rechercher un plat..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {filtered.length} plat{filtered.length !== 1 ? 's' : ''}
              </div>
            </div>

            {analysis.length === 0 ? (
              <div className="empty-state">
                <BarChart2 size={48} />
                <p>Aucune donnée. Créez des fiches techniques avec prix de vente et synchronisez vos ventes Square.</p>
              </div>
            ) : (
              <>
                {/* ── MATRIX VIEW ───────────────────────────────────────── */}
                {viewMode === 'matrix' && (
                  <div className="card" style={{ padding: '24px 24px 16px' }}>
                    <div style={{ marginBottom: 16 }}>
                      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Matrice BCG — Menu Engineering</h3>
                      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Axe X : Popularité (quantités vendues) · Axe Y : Rentabilité (% marge brute) · Taille bulle : CA généré
                      </p>
                    </div>

                    {/* Quadrant labels overlay */}
                    <div style={{ position: 'relative' }}>
                      <div style={{
                        position: 'absolute', top: 8, right: 16,
                        display: 'grid', gridTemplateColumns: '1fr 1fr',
                        gap: 4, fontSize: 11, zIndex: 10, pointerEvents: 'none',
                        width: 'calc(100% - 80px)', left: 60,
                      }}>
                        <div style={{ color: '#8b5cf6', fontWeight: 700, textAlign: 'center', opacity: 0.7 }}>❓ PUZZLES</div>
                        <div style={{ color: '#f59e0b', fontWeight: 700, textAlign: 'center', opacity: 0.7 }}>⭐ STARS</div>
                        <div style={{ color: '#ef4444', fontWeight: 700, textAlign: 'center', opacity: 0.7 }}>🐕 DOGS</div>
                        <div style={{ color: '#3b82f6', fontWeight: 700, textAlign: 'center', opacity: 0.7 }}>🐂 VACHES À LAIT</div>
                      </div>

                      <ResponsiveContainer width="100%" height={420}>
                        <ScatterChart margin={{ top: 40, right: 30, bottom: 20, left: 20 }}>
                          <XAxis
                            dataKey="x"
                            type="number"
                            name="Popularité"
                            stroke="var(--text-muted)"
                            fontSize={11}
                            tickLine={false}
                            label={{ value: 'Quantités vendues →', position: 'insideBottom', offset: -10, fontSize: 11, fill: 'var(--text-muted)' }}
                          />
                          <YAxis
                            dataKey="y"
                            type="number"
                            name="Marge"
                            stroke="var(--text-muted)"
                            fontSize={11}
                            tickLine={false}
                            tickFormatter={v => `${v.toFixed(0)}%`}
                            label={{ value: 'Marge brute →', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: 'var(--text-muted)' }}
                          />
                          <ZAxis dataKey="z" range={[40, 600]} />
                          <Tooltip content={<CustomScatterTooltip />} />
                          {/* Reference lines at averages */}
                          <ReferenceLine x={avgQty} stroke="var(--text-muted)" strokeDasharray="4 4" strokeOpacity={0.5} />
                          <ReferenceLine y={avgMarge} stroke="var(--text-muted)" strokeDasharray="4 4" strokeOpacity={0.5} />
                          <Scatter
                            data={scatterData.filter(d =>
                              (filterQuadrant === 'all' || d.quadrant === filterQuadrant) &&
                              (!filterCategory || d.category === filterCategory) &&
                              (!search || d.name.toLowerCase().includes(search.toLowerCase()))
                            )}
                            onClick={(d: any) => setSelectedItem(d)}
                            style={{ cursor: 'pointer' }}
                          >
                            {scatterData
                              .filter(d =>
                                (filterQuadrant === 'all' || d.quadrant === filterQuadrant) &&
                                (!filterCategory || d.category === filterCategory) &&
                                (!search || d.name.toLowerCase().includes(search.toLowerCase()))
                              )
                              .map((entry, index) => (
                                <Cell
                                  key={`cell-${index}`}
                                  fill={QUADRANT_CONFIG[entry.quadrant].color}
                                  fillOpacity={0.8}
                                  stroke={QUADRANT_CONFIG[entry.quadrant].borderColor}
                                  strokeWidth={2}
                                />
                              ))}
                          </Scatter>
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* ── TABLE VIEW ────────────────────────────────────────── */}
                {viewMode === 'table' && (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Plat</th>
                          <th>Catégorie</th>
                          <th>Quadrant</th>
                          <th style={{ textAlign: 'right' }}>Prix vente</th>
                          <th style={{ textAlign: 'right' }}>Coût matière</th>
                          <th style={{ textAlign: 'right' }}>Food Cost</th>
                          <th style={{ textAlign: 'right' }}>Marge brute</th>
                          <th style={{ textAlign: 'right' }}>Qté vendue</th>
                          <th style={{ textAlign: 'right' }}>CA total</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(item => {
                          const conf = QUADRANT_CONFIG[item.quadrant];
                          return (
                            <tr
                              key={item.id}
                              style={{ cursor: 'pointer' }}
                              onClick={() => setSelectedItem(item)}
                            >
                              <td style={{ fontWeight: 600 }}>{item.name}</td>
                              <td><span className="badge badge-alimentaire">{RECIPE_CATEGORY_LABELS[item.category]}</span></td>
                              <td>
                                <span style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  background: conf.bgColor,
                                  color: conf.color,
                                  padding: '2px 8px',
                                  borderRadius: 20,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  border: `1px solid ${conf.borderColor}`,
                                }}>
                                  {conf.label}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(item.selling_price)}</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(item.cost_per_portion, 3)}</td>
                              <td style={{ textAlign: 'right', color: item.food_cost_pct > FOOD_COST_TARGET ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                                {formatPercent(item.food_cost_pct)}
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatPercent(item.marge_pct)}</td>
                              <td style={{ textAlign: 'right' }}>
                                {item.qty_sold > 0
                                  ? <span style={{ fontWeight: 600 }}>{item.qty_sold}</span>
                                  : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                                }
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--teal)', fontWeight: 600 }}>
                                {item.revenue > 0 ? formatCurrency(item.revenue) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                              </td>
                              <td>
                                <button className="btn btn-ghost btn-sm">
                                  <Info size={15} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ── Quadrant Advice Cards ─────────────────────────────── */}
                <div className="grid-2" style={{ marginTop: 24 }}>
                  {(Object.keys(QUADRANT_CONFIG) as BCGQuadrant[]).map(q => {
                    const conf = QUADRANT_CONFIG[q];
                    const items = analysis.filter(i => i.quadrant === q);
                    if (items.length === 0) return null;
                    return (
                      <div
                        key={q}
                        className="card"
                        style={{
                          borderLeft: `4px solid ${conf.borderColor}`,
                          background: conf.bgColor,
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 14, color: conf.color, marginBottom: 6 }}>{conf.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                          {conf.advice}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {items.slice(0, 6).map(item => (
                            <span
                              key={item.id}
                              style={{
                                background: 'var(--card-bg)',
                                border: `1px solid ${conf.borderColor}`,
                                color: conf.color,
                                padding: '2px 10px',
                                borderRadius: 20,
                                fontSize: 12,
                                fontWeight: 500,
                                cursor: 'pointer',
                              }}
                              onClick={() => setSelectedItem(item)}
                            >
                              {item.name}
                            </span>
                          ))}
                          {items.length > 6 && (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                              +{items.length - 6} autres
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Detail Modal ─────────────────────────────────────────────────── */}
      {selectedItem && (
        <div className="modal-overlay" onClick={() => setSelectedItem(null)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{selectedItem.name}</div>
              <button className="modal-close" onClick={() => setSelectedItem(null)}><X size={20} /></button>
            </div>

            {/* Quadrant badge */}
            {(() => {
              const conf = QUADRANT_CONFIG[selectedItem.quadrant];
              return (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: conf.bgColor, color: conf.color,
                  padding: '6px 14px', borderRadius: 20, fontSize: 13,
                  fontWeight: 700, border: `1px solid ${conf.borderColor}`,
                  marginBottom: 16,
                }}>
                  {conf.label} — {conf.sublabel}
                </div>
              );
            })()}

            {/* KPI Grid */}
            <div className="grid-3" style={{ marginBottom: 16 }}>
              {[
                { label: 'Prix de vente', value: formatCurrency(selectedItem.selling_price), color: 'var(--teal)' },
                { label: 'Coût matière/portion', value: formatCurrency(selectedItem.cost_per_portion, 3), color: 'var(--text)' },
                { label: 'Marge brute', value: formatPercent(selectedItem.marge_pct), color: 'var(--green)' },
                { label: 'Food Cost', value: formatPercent(selectedItem.food_cost_pct), color: selectedItem.food_cost_pct > FOOD_COST_TARGET ? 'var(--red)' : 'var(--green)' },
                { label: 'Quantités vendues', value: selectedItem.qty_sold > 0 ? String(selectedItem.qty_sold) : 'Aucune vente', color: 'var(--text)' },
                { label: 'CA généré', value: selectedItem.revenue > 0 ? formatCurrency(selectedItem.revenue) : '—', color: 'var(--teal)' },
              ].map(kpi => (
                <div key={kpi.label} className="card" style={{ textAlign: 'center', padding: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{kpi.label.toUpperCase()}</div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: kpi.color }}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {/* Advice */}
            {(() => {
              const conf = QUADRANT_CONFIG[selectedItem.quadrant];
              return (
                <div style={{
                  background: conf.bgColor,
                  border: `1px solid ${conf.borderColor}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 16,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: conf.color, marginBottom: 4 }}>
                    💡 Recommandation
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                    {conf.advice}
                  </div>
                </div>
              );
            })()}

            {/* Improvement suggestions */}
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>
              Pistes d'optimisation
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              {selectedItem.food_cost_pct > FOOD_COST_TARGET && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--red)' }}>⚠️</span>
                  <span>Food cost trop élevé ({formatPercent(selectedItem.food_cost_pct)}). Objectif : &lt; {FOOD_COST_TARGET}%. Réduire les portions ou renégocier les prix fournisseurs.</span>
                </div>
              )}
              {selectedItem.qty_sold === 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--orange)' }}>📊</span>
                  <span>Aucune vente enregistrée sur la période. Vérifiez que le nom dans Square correspond exactement au nom de la fiche.</span>
                </div>
              )}
              {selectedItem.quadrant === 'plowhorse' && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: '#3b82f6' }}>💰</span>
                  <span>
                    Pour atteindre la marge moyenne ({formatPercent(avgMarge)}), le prix idéal serait{' '}
                    <strong>{formatCurrency(selectedItem.cost_per_portion / (avgMarge / 100))}</strong>.
                  </span>
                </div>
              )}
              {selectedItem.quadrant === 'star' && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: '#f59e0b' }}>⭐</span>
                  <span>Plat champion ! Assurez la constance de la recette et mettez-le en valeur dans la carte (encadré, photo, suggestion serveur).</span>
                </div>
              )}
              {selectedItem.quadrant === 'puzzle' && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: '#8b5cf6' }}>✨</span>
                  <span>Excellente rentabilité mais peu vendu. Testez une mise en avant dans la carte ou une suggestion en salle pour booster les ventes.</span>
                </div>
              )}
              {selectedItem.quadrant === 'dog' && selectedItem.qty_sold > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--red)' }}>🗑️</span>
                  <span>Peu vendu et peu rentable. Envisagez de retirer ce plat ou de le reformuler complètement avant la prochaine carte.</span>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedItem(null)}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
