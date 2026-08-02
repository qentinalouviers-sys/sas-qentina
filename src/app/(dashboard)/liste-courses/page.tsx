'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, CATEGORY_LABELS } from '@/lib/utils';
import {
  ShoppingCart, Search, Plus, Trash2, Check, X, ChevronDown,
  ChevronUp, Package, RefreshCw, Building2,
  ClipboardList, Star, Copy, List
} from 'lucide-react';
import type { Supplier, InvoiceLineCategory } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CatalogProduct {
  designation: string;
  unit: string | null;
  unit_price_ht: number | null;
  category: InvoiceLineCategory | null;
  supplier_id: string | null;
  supplier_name: string | null;
  last_date: string | null;
  order_count: number;
}

interface ListItem {
  id: string;
  designation: string;
  unit: string;
  quantity: number;
  unit_price_ht: number | null;
  category: InvoiceLineCategory | null;
  supplier_id: string | null;
  supplier_name: string | null;
  checked: boolean;
  is_custom: boolean;
  note: string;
}

interface ShoppingList {
  id: string;
  name: string;
  created_at: string;
  items: ListItem[];
}

const RAYON_CONFIG: Record<InvoiceLineCategory | 'autre', { label: string; emoji: string; color: string }> = {
  alimentaire: { label: 'Alimentaire', emoji: '🥗', color: '#22c55e' },
  boisson:     { label: 'Boissons', emoji: '🥤', color: '#06b6d4' },
  emballage:   { label: 'Emballages', emoji: '📦', color: '#64748b' },
  materiel:    { label: 'Matériel', emoji: '🔧', color: '#f59e0b' },
  autre:       { label: 'Autre', emoji: '📋', color: '#8b5cf6' },
};

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function ListeCoursesPage() {
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  // Lists management
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);

  // Catalog filters
  const [search, setSearch] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterCategory, setFilterCategory] = useState<InvoiceLineCategory | ''>('');
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(new Set());

  // Mobile tab state
  const [mobileTab, setMobileTab] = useState<'list' | 'catalog'>('list');

  // Add custom product modal
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customForm, setCustomForm] = useState({ designation: '', unit: 'pièce', quantity: 1, unit_price_ht: '', note: '', category: '' as InvoiceLineCategory | '', supplier_id: '' });

  // Item editing
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  // New list modal
  const [showNewListModal, setShowNewListModal] = useState(false);
  const [newListName, setNewListName] = useState('');

  const supabase = createClient();

  // ─── Load catalog from invoice lines ─────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);

    const { data: sup } = await supabase.from('suppliers').select('*').order('name');
    setSuppliers(sup || []);

    // Aggregate invoice lines into a product catalog
    const { data: lines } = await supabase
      .from('invoice_lines')
      .select('designation, unit, unit_price_ht, category, created_at, invoice:invoices(supplier_id, supplier:suppliers(id, name), date)')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (lines) {
      // Build catalog: deduplicate by designation (normalized), keep latest price + count occurrences
      const map: Record<string, CatalogProduct> = {};
      lines.forEach((l: any) => {
        const key = (l.designation || '').trim().toLowerCase();
        if (!key) return;
        const supplierId = l.invoice?.supplier_id || null;
        const supplierName = l.invoice?.supplier?.name || null;
        const date = l.invoice?.date || null;

        if (!map[key]) {
          map[key] = {
            designation: (l.designation || '').trim(),
            unit: l.unit,
            unit_price_ht: l.unit_price_ht,
            category: l.category,
            supplier_id: supplierId,
            supplier_name: supplierName,
            last_date: date,
            order_count: 1,
          };
        } else {
          map[key].order_count++;
          // Keep most recent price
          if (date && map[key].last_date && date > map[key].last_date!) {
            map[key].unit_price_ht = l.unit_price_ht;
            map[key].unit = l.unit;
            map[key].last_date = date;
            map[key].supplier_id = supplierId;
            map[key].supplier_name = supplierName;
          }
        }
      });

      const products = Object.values(map)
        .sort((a, b) => b.order_count - a.order_count); // Most ordered first
      setCatalog(products);
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  // ─── Persist lists to localStorage ──────────────────────────────────────

  useEffect(() => {
    const saved = localStorage.getItem('qentina_shopping_lists');
    if (saved) {
      try {
        const parsed: ShoppingList[] = JSON.parse(saved);
        setLists(parsed);
        if (parsed.length > 0) setActiveListId(parsed[0].id);
      } catch { /* ignore */ }
    } else {
      // Create default list
      const defaultList: ShoppingList = {
        id: genId(),
        name: 'Liste du ' + new Date().toLocaleDateString('fr-FR'),
        created_at: new Date().toISOString(),
        items: [],
      };
      setLists([defaultList]);
      setActiveListId(defaultList.id);
    }
  }, []);

  const saveLists = (newLists: ShoppingList[]) => {
    setLists(newLists);
    localStorage.setItem('qentina_shopping_lists', JSON.stringify(newLists));
  };

  // ─── List operations ──────────────────────────────────────────────────────

  const activeList = lists.find(l => l.id === activeListId) || null;

  const updateList = (updatedList: ShoppingList) => {
    saveLists(lists.map(l => l.id === updatedList.id ? updatedList : l));
  };

  const createList = () => {
    if (!newListName.trim()) return;
    const newList: ShoppingList = {
      id: genId(),
      name: newListName.trim(),
      created_at: new Date().toISOString(),
      items: [],
    };
    const updated = [newList, ...lists];
    saveLists(updated);
    setActiveListId(newList.id);
    setNewListName('');
    setShowNewListModal(false);
  };

  const deleteList = (id: string) => {
    if (!confirm('Supprimer cette liste ?')) return;
    const updated = lists.filter(l => l.id !== id);
    saveLists(updated);
    if (activeListId === id) setActiveListId(updated[0]?.id || null);
  };

  const addToList = (product: CatalogProduct) => {
    if (!activeList) return;
    // Check if already in list
    const exists = activeList.items.find(
      i => i.designation.toLowerCase() === product.designation.toLowerCase()
    );
    if (exists) {
      // Increment quantity
      const updated: ShoppingList = {
        ...activeList,
        items: activeList.items.map(i =>
          i.id === exists.id ? { ...i, quantity: i.quantity + 1 } : i
        ),
      };
      updateList(updated);
      return;
    }
    const newItem: ListItem = {
      id: genId(),
      designation: product.designation,
      unit: product.unit || 'u.',
      quantity: 1,
      unit_price_ht: product.unit_price_ht,
      category: product.category,
      supplier_id: product.supplier_id,
      supplier_name: product.supplier_name,
      checked: false,
      is_custom: false,
      note: '',
    };
    updateList({ ...activeList, items: [...activeList.items, newItem] });
  };

  const addCustomItem = () => {
    if (!activeList || !customForm.designation.trim()) return;
    const newItem: ListItem = {
      id: genId(),
      designation: customForm.designation.trim(),
      unit: customForm.unit,
      quantity: customForm.quantity,
      unit_price_ht: customForm.unit_price_ht ? parseFloat(customForm.unit_price_ht) : null,
      category: customForm.category || null,
      supplier_id: customForm.supplier_id || null,
      supplier_name: suppliers.find(s => s.id === customForm.supplier_id)?.name || null,
      checked: false,
      is_custom: true,
      note: customForm.note,
    };
    updateList({ ...activeList, items: [...activeList.items, newItem] });
    setCustomForm({ designation: '', unit: 'pièce', quantity: 1, unit_price_ht: '', note: '', category: '', supplier_id: '' });
    setShowCustomModal(false);
  };

  const toggleCheck = (itemId: string) => {
    if (!activeList) return;
    updateList({
      ...activeList,
      items: activeList.items.map(i => i.id === itemId ? { ...i, checked: !i.checked } : i),
    });
  };

  const removeItem = (itemId: string) => {
    if (!activeList) return;
    updateList({ ...activeList, items: activeList.items.filter(i => i.id !== itemId) });
  };

  const updateItemQty = (itemId: string, qty: number) => {
    if (!activeList || qty < 0) return;
    updateList({
      ...activeList,
      items: activeList.items.map(i => i.id === itemId ? { ...i, quantity: qty } : i),
    });
  };

  const clearChecked = () => {
    if (!activeList) return;
    updateList({ ...activeList, items: activeList.items.filter(i => !i.checked) });
  };

  // ─── Catalog filtering ────────────────────────────────────────────────────

  const filteredCatalog = useMemo(() => {
    return catalog.filter(p => {
      if (search && !p.designation.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterSupplier && p.supplier_id !== filterSupplier) return false;
      if (filterCategory && p.category !== filterCategory) return false;
      return true;
    });
  }, [catalog, search, filterSupplier, filterCategory]);

  // Group by supplier for catalog
  const catalogBySupplier = useMemo(() => {
    const groups: Record<string, { name: string; products: CatalogProduct[] }> = {};
    filteredCatalog.forEach(p => {
      const key = p.supplier_id || '__none__';
      const name = p.supplier_name || 'Fournisseur inconnu';
      if (!groups[key]) groups[key] = { name, products: [] };
      groups[key].products.push(p);
    });
    return Object.entries(groups).sort(([, a], [, b]) => b.products.length - a.products.length);
  }, [filteredCatalog]);

  // List stats
  const listStats = useMemo(() => {
    if (!activeList) return { total: 0, checked: 0, totalPrice: 0 };
    const checked = activeList.items.filter(i => i.checked).length;
    const totalPrice = activeList.items.reduce((s, i) => s + (i.unit_price_ht || 0) * i.quantity, 0);
    return { total: activeList.items.length, checked, totalPrice };
  }, [activeList]);

  // List grouped by supplier
  const listBySupplier = useMemo(() => {
    if (!activeList) return [];
    const groups: Record<string, { name: string; items: ListItem[] }> = {};
    activeList.items.forEach(item => {
      const key = item.supplier_id || '__none__';
      const name = item.supplier_name || 'Non assigné';
      if (!groups[key]) groups[key] = { name, items: [] };
      groups[key].items.push(item);
    });
    return Object.entries(groups).map(([id, g]) => ({ id, ...g }));
  }, [activeList]);

  // Export list as text
  const exportList = () => {
    if (!activeList) return;
    let text = `📋 ${activeList.name}\n\n`;
    listBySupplier.forEach(({ name, items }) => {
      text += `🏪 ${name}\n`;
      items.forEach(i => {
        text += `  ${i.checked ? '✅' : '⬜'} ${i.designation} × ${i.quantity} ${i.unit}`;
        if (i.unit_price_ht) text += ` (${formatCurrency(i.unit_price_ht)} HT/u)`;
        if (i.note) text += ` — ${i.note}`;
        text += '\n';
      });
      text += '\n';
    });
    text += `\nTotal estimé HT : ${formatCurrency(listStats.totalPrice)}`;
    navigator.clipboard.writeText(text).then(() => alert('Liste copiée dans le presse-papier ! 📋'));
  };

  const isInList = (designation: string) =>
    !!activeList?.items.find(i => i.designation.toLowerCase() === designation.toLowerCase());

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="page-header">
        <h2>Liste de courses</h2>
        <div className="page-header-actions">
          <button className="btn btn-secondary btn-sm" onClick={exportList} disabled={!activeList || activeList.items.length === 0}>
            <Copy size={15} /> Copier la liste
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowCustomModal(true)}>
            <Plus size={16} /> Produit personnalisé
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewListModal(true)}>
            <ClipboardList size={18} /> Nouvelle liste
          </button>
        </div>
      </div>

      <div className="page-body" style={{ padding: 0 }}>

        {/* ── Mobile Tab Bar ──────────────────────────────────────────── */}
        <div className="mobile-tabs">
          <div className="mobile-tab-bar">
            <button
              className={`mobile-tab ${mobileTab === 'list' ? 'active' : ''}`}
              onClick={() => setMobileTab('list')}
            >
              <ShoppingCart size={15} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle' }} />
              Ma liste ({listStats.total})
            </button>
            <button
              className={`mobile-tab ${mobileTab === 'catalog' ? 'active' : ''}`}
              onClick={() => setMobileTab('catalog')}
            >
              <Package size={15} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle' }} />
              Catalogue ({catalog.length})
            </button>
          </div>
        </div>

        <div style={{ padding: '16px 14px' }}>
        <div
          className={`shopping-grid ${mobileTab === 'catalog' ? 'show-catalog' : ''}`}
        >

          {/* LEFT PANEL — Shopping List */}
          <div className="list-panel" style={{ display: 'flex', flexDirection: 'column', gap: 0, overflow: 'hidden' }}>

            {/* List selector tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 4, flexShrink: 0 }}>
              {lists.map(list => (
                <button
                  key={list.id}
                  onClick={() => setActiveListId(list.id)}
                  style={{
                    padding: '7px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600,
                    border: activeListId === list.id ? '2px solid var(--teal)' : '2px solid var(--border)',
                    background: activeListId === list.id ? 'var(--teal-bg)' : 'white',
                    color: activeListId === list.id ? 'var(--teal)' : 'var(--text-secondary)',
                    cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.2s',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <ShoppingCart size={13} />
                  {list.name}
                  <span style={{
                    background: activeListId === list.id ? 'var(--teal)' : 'var(--border)',
                    color: activeListId === list.id ? 'white' : 'var(--text-muted)',
                    borderRadius: 99, fontSize: 11, padding: '1px 6px',
                  }}>
                    {list.items.length}
                  </span>
                  {lists.length > 1 && (
                    <span
                      style={{ marginLeft: 2, opacity: 0.5 }}
                      onClick={e => { e.stopPropagation(); deleteList(list.id); }}
                    >
                      <X size={11} />
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* List card */}
            <div style={{
              background: 'white',
              border: '1.5px solid var(--border)',
              borderRadius: 14,
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
              flex: 1,
              boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
            }}>
              {/* List header */}
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-light)',
                background: 'var(--cream-light)',
                flexShrink: 0,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {activeList?.name || 'Aucune liste'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {listStats.checked}/{listStats.total} articles • Total estimé :{' '}
                      <strong style={{ color: 'var(--teal)' }}>{formatCurrency(listStats.totalPrice)} HT</strong>
                    </div>
                  </div>
                  {listStats.checked > 0 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 12, color: 'var(--red)' }}
                      onClick={clearChecked}
                    >
                      <Trash2 size={13} /> Retirer cochés
                    </button>
                  )}
                </div>

                {/* Progress bar */}
                {listStats.total > 0 && (
                  <div style={{ marginTop: 10, height: 5, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 99, transition: 'width 0.4s',
                      width: `${(listStats.checked / listStats.total) * 100}%`,
                      background: listStats.checked === listStats.total
                        ? 'linear-gradient(90deg, var(--green), #4ade80)'
                        : 'linear-gradient(90deg, var(--teal), var(--teal-light))',
                    }} />
                  </div>
                )}
              </div>

              {/* List items */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
                {!activeList || activeList.items.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                    <ShoppingCart size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                    <div style={{ fontSize: 14 }}>Votre liste est vide</div>
                    <div style={{ fontSize: 12, marginTop: 6 }}>Ajoutez des produits depuis le catalogue →</div>
                  </div>
                ) : (
                  listBySupplier.map(({ id: supId, name: supName, items }) => (
                    <div key={supId}>
                      {/* Supplier separator */}
                      <div style={{
                        padding: '8px 18px',
                        background: 'var(--cream-light)',
                        borderBottom: '1px solid var(--border-light)',
                        display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: 12, fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: 0.5,
                      }}>
                        <Building2 size={12} />
                        {supName}
                        <span style={{ marginLeft: 'auto', fontWeight: 400, textTransform: 'none' }}>
                          {formatCurrency(items.reduce((s, i) => s + (i.unit_price_ht || 0) * i.quantity, 0))} HT
                        </span>
                      </div>

                      {items.map(item => {
                        const rayConf = RAYON_CONFIG[item.category || 'autre'];
                        return (
                          <div
                            key={item.id}
                            style={{
                              padding: '10px 18px',
                              borderBottom: '1px solid var(--border-light)',
                              background: item.checked ? '#f0fdf4' : 'white',
                              display: 'flex', gap: 10, alignItems: 'center',
                              transition: 'background 0.2s',
                            }}
                          >
                            {/* Checkbox */}
                            <button
                              onClick={() => toggleCheck(item.id)}
                              style={{
                                width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                                border: item.checked ? '2px solid var(--green)' : '2px solid var(--border)',
                                background: item.checked ? 'var(--green)' : 'white',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'all 0.2s',
                              }}
                            >
                              {item.checked && <Check size={13} style={{ color: 'white' }} />}
                            </button>

                            {/* Category dot */}
                            <div style={{
                              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: rayConf.color, opacity: 0.7,
                            }} />

                            {/* Content */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontWeight: 600, fontSize: 13,
                                color: item.checked ? 'var(--text-muted)' : 'var(--text-primary)',
                                textDecoration: item.checked ? 'line-through' : 'none',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {item.designation}
                                {item.is_custom && (
                                  <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>✏️ personnalisé</span>
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                                {item.unit_price_ht ? `${formatCurrency(item.unit_price_ht)} HT/u` : 'Prix inconnu'}
                                {item.note && <span style={{ marginLeft: 8, fontStyle: 'italic' }}>— {item.note}</span>}
                              </div>
                            </div>

                            {/* Quantity control */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                              <button
                                style={{ width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--cream)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700 }}
                                onClick={() => updateItemQty(item.id, item.quantity - 1)}
                              >−</button>
                              <span style={{ fontSize: 13, fontWeight: 700, minWidth: 20, textAlign: 'center' }}>{item.quantity}</span>
                              <button
                                style={{ width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--cream)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700 }}
                                onClick={() => updateItemQty(item.id, item.quantity + 1)}
                              >+</button>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{item.unit}</span>
                            </div>

                            {/* Remove */}
                            <button
                              onClick={() => removeItem(item.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, opacity: 0.5, transition: 'opacity 0.2s' }}
                              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                              onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* RIGHT PANEL — Product Catalog */}
          <div className="catalog-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Catalog header */}
            <div style={{ marginBottom: 12, flexShrink: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Package size={18} style={{ color: 'var(--teal)' }} />
                Catalogue produits
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
                  ({catalog.length} produits déjà achetés)
                </span>
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={loadData} disabled={loading}>
                  <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                </button>
              </div>

              {/* Search + Filters */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    className="form-input"
                    style={{ paddingLeft: 32, width: '100%' }}
                    placeholder="Rechercher un produit..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
                <select className="form-select" style={{ maxWidth: 160 }} value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}>
                  <option value="">Tous fournisseurs</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select className="form-select" style={{ maxWidth: 140 }} value={filterCategory} onChange={e => setFilterCategory(e.target.value as any)}>
                  <option value="">Toutes catégories</option>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {(search || filterSupplier || filterCategory) && (
                  <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setFilterSupplier(''); setFilterCategory(''); }}>
                    <X size={13} /> Réinitialiser
                  </button>
                )}
              </div>

              {/* Category quick filters */}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto' }}>
                {Object.entries(RAYON_CONFIG).map(([key, conf]) => (
                  <button
                    key={key}
                    onClick={() => setFilterCategory(filterCategory === key ? '' : key as InvoiceLineCategory)}
                    style={{
                      padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600,
                      border: filterCategory === key ? `2px solid ${conf.color}` : '2px solid var(--border)',
                      background: filterCategory === key ? `${conf.color}18` : 'white',
                      color: filterCategory === key ? conf.color : 'var(--text-secondary)',
                      cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
                    }}
                  >
                    {conf.emoji} {conf.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Catalog list */}
            <div style={{
              flex: 1, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {loading ? (
                <div className="loading-page"><div className="spinner" style={{ width: 28, height: 28 }} /></div>
              ) : catalogBySupplier.length === 0 ? (
                <div className="empty-state"><Package size={40} /><p>Aucun produit trouvé</p></div>
              ) : (
                catalogBySupplier.map(([supId, { name: supName, products }]) => {
                  const isExpanded = expandedSuppliers.has(supId) || (search !== '' || filterCategory !== '');
                  return (
                    <div
                      key={supId}
                      style={{
                        background: 'white', border: '1.5px solid var(--border)',
                        borderRadius: 12, overflow: 'hidden',
                        boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
                      }}
                    >
                      {/* Supplier header */}
                      <button
                        onClick={() => setExpandedSuppliers(prev => {
                          const n = new Set(prev);
                          n.has(supId) ? n.delete(supId) : n.add(supId);
                          return n;
                        })}
                        style={{
                          width: '100%', background: 'var(--cream-light)',
                          border: 'none', borderBottom: isExpanded ? '1px solid var(--border-light)' : 'none',
                          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10,
                          cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <Building2 size={16} style={{ color: 'var(--teal)', flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{supName}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{products.length} produits référencés</div>
                        </div>
                        {/* How many already in list */}
                        {activeList && (() => {
                          const inList = products.filter(p => isInList(p.designation)).length;
                          return inList > 0 ? (
                            <span style={{ fontSize: 11, background: 'var(--teal-bg)', color: 'var(--teal)', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
                              {inList} dans la liste
                            </span>
                          ) : null;
                        })()}
                        {isExpanded ? <ChevronUp size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> : <ChevronDown size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                      </button>

                      {/* Products */}
                      {isExpanded && (
                        <div>
                          {products.map((product, idx) => {
                            const rayConf = RAYON_CONFIG[product.category || 'autre'];
                            const alreadyIn = isInList(product.designation);
                            return (
                              <div
                                key={`${product.designation}-${idx}`}
                                style={{
                                  padding: '9px 16px',
                                  borderBottom: idx < products.length - 1 ? '1px solid var(--border-light)' : 'none',
                                  display: 'flex', alignItems: 'center', gap: 10,
                                  background: alreadyIn ? '#f0fdf4' : (idx % 2 === 0 ? 'white' : '#fafafa'),
                                  transition: 'background 0.15s',
                                }}
                              >
                                {/* Category color */}
                                <div style={{
                                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                                  background: rayConf.color,
                                }} />

                                {/* Product info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{
                                    fontWeight: 600, fontSize: 13,
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    color: alreadyIn ? 'var(--green)' : 'var(--text-primary)',
                                  }}>
                                    {product.designation}
                                    {product.order_count >= 3 && (
                                      <span title="Produit récurrent" style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 6 }}>
                                        <Star size={11} style={{ color: '#f59e0b' }} />
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, display: 'flex', gap: 10 }}>
                                    {product.unit_price_ht != null ? (
                                      <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                                        {formatCurrency(product.unit_price_ht)} HT/{product.unit || 'u'}
                                      </span>
                                    ) : <span>Prix inconnu</span>}
                                    <span style={{
                                      background: `${rayConf.color}18`, color: rayConf.color,
                                      padding: '0 6px', borderRadius: 99, fontWeight: 600, fontSize: 10,
                                    }}>
                                      {rayConf.emoji} {rayConf.label}
                                    </span>
                                    {product.order_count > 1 && (
                                      <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                        commandé {product.order_count}×
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Add button */}
                                <button
                                  onClick={() => addToList(product)}
                                  style={{
                                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                    border: alreadyIn ? '2px solid var(--green)' : '2px solid var(--teal)',
                                    background: alreadyIn ? 'var(--green)' : 'var(--teal-bg)',
                                    color: alreadyIn ? 'white' : 'var(--teal)',
                                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    transition: 'all 0.2s',
                                    fontSize: 18, fontWeight: 700,
                                  }}
                                  title={alreadyIn ? 'Ajouter une unité de plus' : 'Ajouter à la liste'}
                                >
                                  {alreadyIn ? '+' : <Plus size={16} />}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* ══ New List Modal ══════════════════════════════════════════════════════ */}
      {showNewListModal && (
        <div className="modal-overlay" onClick={() => setShowNewListModal(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Nouvelle liste de courses</div>
              <button className="modal-close" onClick={() => setShowNewListModal(false)}><X size={20} /></button>
            </div>
            <div className="form-group">
              <label className="form-label">Nom de la liste</label>
              <input
                className="form-input"
                autoFocus
                placeholder="Ex: Metro lundi, Passage chez Metro..."
                value={newListName}
                onChange={e => setNewListName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createList()}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowNewListModal(false)}>Annuler</button>
              <button className="btn btn-primary" onClick={createList} disabled={!newListName.trim()}>
                <Plus size={16} /> Créer la liste
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ Custom Product Modal ════════════════════════════════════════════════ */}
      {showCustomModal && (
        <div className="modal-overlay" onClick={() => setShowCustomModal(false)}>
          <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Ajouter un produit personnalisé</div>
              <button className="modal-close" onClick={() => setShowCustomModal(false)}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">Désignation *</label>
                <input
                  className="form-input"
                  autoFocus
                  placeholder="Ex: Roquette bio, Huile d'olive AOP..."
                  value={customForm.designation}
                  onChange={e => setCustomForm(p => ({ ...p, designation: e.target.value }))}
                />
              </div>
              <div className="grid-2" style={{ gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Quantité</label>
                  <input
                    type="number" min={1} className="form-input"
                    value={customForm.quantity}
                    onChange={e => setCustomForm(p => ({ ...p, quantity: parseInt(e.target.value) || 1 }))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Unité</label>
                  <select className="form-select" value={customForm.unit} onChange={e => setCustomForm(p => ({ ...p, unit: e.target.value }))}>
                    {['pièce', 'kg', 'g', 'L', 'cL', 'barquette', 'sachet', 'boîte', 'carton', 'lot'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Prix HT estimé (€)</label>
                  <input
                    type="number" step="0.01" className="form-input"
                    placeholder="0.00"
                    value={customForm.unit_price_ht}
                    onChange={e => setCustomForm(p => ({ ...p, unit_price_ht: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Catégorie</label>
                  <select className="form-select" value={customForm.category} onChange={e => setCustomForm(p => ({ ...p, category: e.target.value as any }))}>
                    <option value="">—</option>
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Fournisseur</label>
                <select className="form-select" value={customForm.supplier_id} onChange={e => setCustomForm(p => ({ ...p, supplier_id: e.target.value }))}>
                  <option value="">— Non assigné —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Note (optionnel)</label>
                <input
                  className="form-input"
                  placeholder="Ex: marque préférée, variété..."
                  value={customForm.note}
                  onChange={e => setCustomForm(p => ({ ...p, note: e.target.value }))}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCustomModal(false)}>Annuler</button>
              <button className="btn btn-primary" onClick={addCustomItem} disabled={!customForm.designation.trim()}>
                <Plus size={16} /> Ajouter à la liste
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
