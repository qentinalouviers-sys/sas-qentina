'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Plus, Trash2, Save, Settings, Flame, RefreshCw, Stethoscope, KeyRound, Merge, Link2 } from 'lucide-react';
import AiSettingsPanel from '@/components/AiSettingsPanel';
import { formatCurrency } from '@/lib/utils';
import { UNITS } from '@/lib/recipes';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { unmatchedDesignations, cleanName, type UnmatchedDesignation } from '@/lib/referentiel';
import type { Supplier, Ingredient } from '@/lib/types';

const DEFAULT_OPENING_HOURS: Record<string, { Midi: boolean; Soir: boolean }> = {
  Lun: { Midi: true, Soir: true }, Mar: { Midi: true, Soir: true },
  Mer: { Midi: true, Soir: true }, Jeu: { Midi: true, Soir: true },
  Ven: { Midi: true, Soir: true }, Sam: { Midi: true, Soir: true },
  Dim: { Midi: true, Soir: true },
};

export default function ReglagesPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [newSupplier, setNewSupplier] = useState('');
  const [newIngredient, setNewIngredient] = useState({ name: '', unit: 'kg', last_unit_price: 0 });
  type Tab = 'suppliers' | 'ingredients' | 'ia' | 'services' | 'moteurs';
  const isTab = (v: string | null): v is Tab =>
    v !== null && ['suppliers', 'ingredients', 'ia', 'services', 'moteurs'].includes(v);
  // Onglet demandé par l'URL : les interventions de l'accueil y renvoient.
  // Lu à l'initialisation plutôt que dans un effet : le premier rendu
  // affiche un spinner des deux côtés, il n'y a donc rien à réconcilier.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'ingredients';
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return isTab(wanted) ? wanted : 'ingredients';
  });
  // Nombre de factures par fournisseur : pour choisir la fiche à conserver
  // lors d'une fusion, et repérer une fiche vide.
  const [invoiceCounts, setInvoiceCounts] = useState<Record<string, number>>({});
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  // Désignations de factures qui ne mettent à jour aucun prix.
  const [orphans, setOrphans] = useState<UnmatchedDesignation[]>([]);
  const [orphanChoice, setOrphanChoice] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState<string | null>(null);
  const [fuegoContext, setFuegoContext] = useState('');
  const [savingContext, setSavingContext] = useState(false);
  const [openingHours, setOpeningHours] = useState<Record<string, { Midi: boolean; Soir: boolean }>>({ ...DEFAULT_OPENING_HOURS });
  const [savingHours, setSavingHours] = useState(false);
  const [syncDays, setSyncDays] = useState(365);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostic, setDiagnostic] = useState<any | null>(null);

  /**
   * Compare ce que Square contient à ce que la base contient.
   *
   * Relancer une reprise ne sert à rien si la cause est ailleurs — une
   * boutique Square non configurée ne se rattrape pas, elle se configure.
   * Lecture seule : rien n'est écrit ni corrigé.
   */
  const runDiagnostic = async () => {
    setDiagnosing(true);
    setDiagnostic(null);
    try {
      const res = await fetch(`/api/square/diagnostic?days=${syncDays}`);
      const data = await res.json();
      setDiagnostic(res.ok ? data : { error: data.error || 'Diagnostic impossible' });
    } catch (e: any) {
      setDiagnostic({ error: `Diagnostic impossible : ${e.message}` });
    } finally {
      setDiagnosing(false);
    }
  };

  const supabase = createClient();

  /**
   * Reprise de l'historique Square.
   *
   * La route rend la main avant que la plateforme ne la coupe et renvoie son
   * curseur : on la relance jusqu'à ce qu'elle annonce avoir fini. Sans cette
   * boucle, une partie des commandes resterait dehors et le chiffre d'affaires
   * serait minoré en affichant un succès.
   */
  const runHistorySync = async () => {
    setSyncing(true);
    setSyncReport(null);
    try {
      let cursor: string | undefined;
      let orders = 0;
      let items = 0;
      let zero = 0;
      let passes = 0;

      while (passes < 40) {
        const res = await fetch('/api/square/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor ? { cursor, days: syncDays } : { days: syncDays }),
        });
        const data = await res.json();

        if (!data.success) {
          setSyncReport(`Erreur : ${data.error || 'cause inconnue'}`);
          return;
        }

        orders += data.synced?.orders || 0;
        items += data.synced?.items || 0;
        zero += data.synced?.zeroAmountOrders || 0;
        passes++;

        if (data.complete) {
          setSyncReport(
            `${orders} commandes et ${items} articles reprises sur les ${syncDays} derniers jours.`
            + (zero > 0
              ? ` Attention : ${zero} commande(s) sans montant exploitable côté Square.`
              : '')
          );
          return;
        }
        cursor = data.cursor;
        if (!cursor) break;
      }
      setSyncReport(
        `Reprise interrompue après ${orders} commandes (trop de reprises successives). `
        + `Relance pour continuer — aucun doublon ne sera créé.`
      );
    } catch {
      setSyncReport('Erreur : la reprise a échoué. Vérifie ta connexion.');
    } finally {
      setSyncing(false);
    }
  };

  const loadSuppliers = useCallback(async () => {
    const [{ data }, invoices] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      fetchAllRows<{ supplier_id: string | null }>((f0, f1) =>
        supabase.from('invoices').select('supplier_id').range(f0, f1)),
    ]);
    setSuppliers(data || []);
    const counts: Record<string, number> = {};
    for (const inv of invoices) if (inv.supplier_id) counts[inv.supplier_id] = (counts[inv.supplier_id] || 0) + 1;
    setInvoiceCounts(counts);
  }, [supabase]);

  /** Fusionne la fiche `sourceId` dans `targetId` : ses factures y passent, elle disparaît. */
  const mergeSuppliers = async (sourceId: string, targetId: string) => {
    const source = suppliers.find(s => s.id === sourceId);
    const target = suppliers.find(s => s.id === targetId);
    if (!source || !target) return;
    if (!confirm(`Fusionner « ${source.name} » (${invoiceCounts[sourceId] || 0} facture(s)) dans « ${target.name} » ?\nLa fiche « ${source.name} » sera supprimée. Cette action est définitive.`)) return;
    setMerging(true);
    try {
      const res = await fetch('/api/suppliers/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fusion impossible');
      setMergeSource(null);
      await loadSuppliers();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  };

  const loadIngredients = useCallback(async () => {
    const [{ data }, { data: aliases }, lines] = await Promise.all([
      supabase.from('ingredients').select('*').order('name'),
      supabase.from('ingredient_aliases').select('alias, ingredient_id'),
      fetchAllRows<{ designation: string | null; unit: string | null; unit_price_ht: number | null }>((f0, f1) =>
        supabase.from('invoice_lines')
          .select('designation, unit, unit_price_ht')
          .in('category', ['alimentaire', 'boisson'])
          .range(f0, f1)),
    ]);
    setIngredients(data || []);
    setOrphans(unmatchedDesignations(lines, data || [], aliases || []));
  }, [supabase]);

  /** Rattache une désignation de facture à un ingrédient existant. */
  const linkDesignation = async (orphan: UnmatchedDesignation, ingredientId: string) => {
    setLinking(orphan.key);
    const { error } = await supabase
      .from('ingredient_aliases')
      .upsert({ alias: orphan.key, ingredient_id: ingredientId });
    setLinking(null);
    if (error) { alert(`Rattachement impossible : ${error.message}`); return; }
    loadIngredients();
  };

  /** Crée l'ingrédient au nom de la désignation — un geste humain, plus jamais automatique. */
  const createFromDesignation = async (orphan: UnmatchedDesignation) => {
    setLinking(orphan.key);
    const { error } = await supabase.from('ingredients').insert({
      name: cleanName(orphan.designation),
      unit: orphan.unit && (UNITS as readonly string[]).includes(orphan.unit) ? orphan.unit : 'kg',
      last_unit_price: orphan.lastPrice ?? 0,
      last_updated: new Date().toISOString(),
    });
    setLinking(null);
    if (error) { alert(`Création impossible : ${error.message}`); return; }
    loadIngredients();
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    const [, , { data: settings }] = await Promise.all([
      loadSuppliers(),
      loadIngredients(),
      supabase.from('app_settings').select('key, value').in('key', ['fuego_context', 'opening_hours']),
    ]);
    const ctx = settings?.find((s: any) => s.key === 'fuego_context');
    if (ctx?.value) setFuegoContext(ctx.value);
    const hours = settings?.find((s: any) => s.key === 'opening_hours');
    if (hours?.value) {
      try {
        const parsed = JSON.parse(hours.value);
        // Spread des défauts d'abord : évite les objets partiels
        setOpeningHours({ ...DEFAULT_OPENING_HOURS, ...parsed });
      } catch {
        // Valeur corrompue → on conserve les horaires par défaut
      }
    }
    setLoading(false);
  }, [supabase, loadSuppliers, loadIngredients]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveOpeningHours = async () => {
    setSavingHours(true);
    const { error } = await supabase.from('app_settings').upsert({ key: 'opening_hours', value: JSON.stringify(openingHours), updated_at: new Date().toISOString() });
    setSavingHours(false);
    if (!error) alert('Horaires sauvegardés avec succès !');
    else alert('Erreur lors de la sauvegarde.');
  };

  const addSupplier = async () => {
    if (!newSupplier.trim()) return;
    await supabase.from('suppliers').insert({ name: newSupplier.trim() });
    setNewSupplier('');
    loadSuppliers();
  };

  const deleteSupplier = async (id: string) => {
    if (!confirm('Supprimer ce fournisseur ?')) return;
    await supabase.from('suppliers').delete().eq('id', id);
    loadSuppliers();
  };

  const addIngredient = async () => {
    if (!newIngredient.name.trim()) return;
    await supabase.from('ingredients').insert({
      name: newIngredient.name.trim(),
      unit: newIngredient.unit,
      last_unit_price: newIngredient.last_unit_price,
      last_updated: new Date().toISOString(),
    });
    setNewIngredient({ name: '', unit: 'kg', last_unit_price: 0 });
    loadIngredients();
  };

  const deleteIngredient = async (id: string) => {
    if (!confirm('Supprimer cet ingrédient ? Il sera aussi retiré de toutes les fiches techniques et son historique d\'inventaire sera effacé.')) return;
    await supabase.from('ingredients').delete().eq('id', id);
    loadIngredients();
  };

  const updateIngredientPrice = async (id: string, price: number) => {
    const current = ingredients.find(i => i.id === id);
    if (current && (current.last_unit_price ?? 0) === price) return; // valeur inchangée → pas d'update
    const { error } = await supabase.from('ingredients').update({ last_unit_price: price, last_updated: new Date().toISOString() }).eq('id', id);
    if (error) {
      alert('Erreur lors de la mise à jour du prix.');
      return;
    }
    loadIngredients();
  };

  const saveFuegoContext = async () => {
    setSavingContext(true);
    const { error } = await supabase.from('app_settings').upsert({ key: 'fuego_context', value: fuegoContext, updated_at: new Date().toISOString() });
    setSavingContext(false);
    if (!error) alert('Contexte sauvegardé avec succès !');
    else alert('Erreur lors de la sauvegarde.');
  };

  return (
    <>
      <div className="page-header">
        <h2>Réglages</h2>
        <Settings size={22} style={{ color: 'var(--text-muted)' }} />
      </div>
      <div className="page-body">
        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : (
        <>
        {/* Tabs */}
        <div className="period-selector" style={{ marginBottom: 24 }}>
          <button className={`period-btn ${tab === 'ingredients' ? 'active' : ''}`} onClick={() => setTab('ingredients')}>Ingrédients</button>
          <button className={`period-btn ${tab === 'suppliers' ? 'active' : ''}`} onClick={() => setTab('suppliers')}>Fournisseurs</button>
          <button className={`period-btn ${tab === 'services' ? 'active' : ''}`} onClick={() => setTab('services')}>Horaires & Services</button>
          <button className={`period-btn ${tab === 'ia' ? 'active' : ''}`} onClick={() => setTab('ia')}><Flame size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: 'text-bottom' }} /> Fuego IA</button>
          <button className={`period-btn ${tab === 'moteurs' ? 'active' : ''}`} onClick={() => setTab('moteurs')}><KeyRound size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: 'text-bottom' }} /> Moteurs IA</button>
        </div>

        {tab === 'moteurs' && <AiSettingsPanel />}

        {tab === 'services' && (
          <div className="card">
            <div className="card-header"><div className="card-title">Jours et Services d'Ouverture</div></div>
            <div style={{ padding: '16px 0 0' }}>
              <p style={{ marginBottom: 16, color: 'var(--text-muted)', fontSize: 14 }}>
                Configurez les services (Midi / Soir) où votre établissement est ouvert. Ces données seront utilisées pour affiner l'analyse de l'IA et vos statistiques de ventes.
              </p>
              <div className="table-container">
                <table>
                  <thead>
                    <tr><th>Jour</th><th style={{ textAlign: 'center' }}>Midi</th><th style={{ textAlign: 'center' }}>Soir</th></tr>
                  </thead>
                  <tbody>
                    {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(day => (
                      <tr key={day}>
                        <td style={{ fontWeight: 600 }}>{day}</td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={openingHours[day]?.Midi ?? true} onChange={e => setOpeningHours(p => ({ ...p, [day]: { ...p[day], Midi: e.target.checked } }))} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={openingHours[day]?.Soir ?? true} onChange={e => setOpeningHours(p => ({ ...p, [day]: { ...p[day], Soir: e.target.checked } }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn btn-primary" onClick={saveOpeningHours} disabled={savingHours}>
                  <Save size={18} /> {savingHours ? 'Sauvegarde...' : 'Sauvegarder'}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'suppliers' && (
          <div className="card">
            <div className="card-header"><div className="card-title">Fournisseurs</div></div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input className="form-input" value={newSupplier} onChange={e => setNewSupplier(e.target.value)} placeholder="Nom du fournisseur" onKeyDown={e => e.key === 'Enter' && addSupplier()} />
              <button className="btn btn-primary" onClick={addSupplier}><Plus size={18} /></button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
              Un même fournisseur sous deux orthographes répartit ses achats entre deux fiches : aucun
              total n&apos;est alors exploitable. <strong>Fusionner</strong> déplace les factures d&apos;une fiche
              vers l&apos;autre, puis supprime la fiche vidée.
            </p>
            <div className="table-container">
              <table>
                <thead><tr><th>Nom</th><th style={{ textAlign: 'right' }}>Factures</th><th></th></tr></thead>
                <tbody>
                  {suppliers.map(s => {
                    const broken = /[ÃÂ�]/.test(s.name);
                    return (
                    <tr key={s.id} style={broken ? { background: 'rgba(232,155,62,0.08)' } : undefined}>
                      <td style={{ fontWeight: 600 }}>
                        {s.name}
                        {broken && <span style={{ marginLeft: 8, fontSize: 11, color: '#92400E', fontWeight: 700 }}>encodage cassé</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{invoiceCounts[s.id] || 0}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {mergeSource === s.id ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <select
                              className="form-select"
                              style={{ minHeight: 34, padding: '4px 8px', fontSize: 13 }}
                              defaultValue=""
                              disabled={merging}
                              onChange={e => { if (e.target.value) mergeSuppliers(s.id, e.target.value); }}
                            >
                              <option value="">Fusionner dans…</option>
                              {suppliers.filter(t => t.id !== s.id).map(t => (
                                <option key={t.id} value={t.id}>{t.name} ({invoiceCounts[t.id] || 0})</option>
                              ))}
                            </select>
                            <button className="btn btn-ghost btn-sm" onClick={() => setMergeSource(null)}>Annuler</button>
                          </span>
                        ) : (
                          <>
                            <button className="btn btn-ghost btn-sm" title="Fusionner dans une autre fiche" onClick={() => setMergeSource(s.id)}>
                              <Merge size={16} />
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              title={invoiceCounts[s.id] ? 'Cette fiche porte des factures : fusionne-la plutôt que de la supprimer' : 'Supprimer'}
                              disabled={!!invoiceCounts[s.id]}
                              onClick={() => deleteSupplier(s.id)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'ingredients' && orphans.length > 0 && (
          <div className="card" style={{ marginBottom: 20, borderLeft: '3px solid var(--orange, #E89B3E)' }}>
            <div className="card-header">
              <div>
                <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Link2 size={18} style={{ color: 'var(--orange, #E89B3E)' }} />
                  {orphans.length} désignation{orphans.length > 1 ? 's' : ''} de factures à rattacher
                </div>
                <div className="card-subtitle">
                  Ces libellés achetés ne correspondent à aucun ingrédient : leurs prix ne mettent rien à jour,
                  et le coût des fiches techniques date. Rattache chacun à son ingrédient, ou crée-le.
                  Les plus achetés d&apos;abord.
                </div>
              </div>
            </div>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Désignation sur la facture</th>
                    <th style={{ textAlign: 'right' }}>Lignes</th>
                    <th style={{ textAlign: 'right' }}>Dernier prix</th>
                    <th>Ingrédient</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orphans.slice(0, 40).map(o => (
                    <tr key={o.key}>
                      <td style={{ fontWeight: 600 }}>{o.designation}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{o.count}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {o.lastPrice != null ? `${formatCurrency(o.lastPrice)}${o.unit ? ` / ${o.unit}` : ''}` : '—'}
                      </td>
                      <td>
                        <select
                          className="form-select"
                          style={{ minHeight: 34, padding: '4px 8px', fontSize: 13, minWidth: 180 }}
                          value={orphanChoice[o.key] || ''}
                          disabled={linking === o.key}
                          onChange={e => setOrphanChoice(c => ({ ...c, [o.key]: e.target.value }))}
                        >
                          <option value="">Choisir…</option>
                          {ingredients.map(i => <option key={i.id} value={i.id}>{i.name}{i.unit ? ` (${i.unit})` : ''}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!orphanChoice[o.key] || linking === o.key}
                          onClick={() => linkDesignation(o, orphanChoice[o.key])}
                        >
                          <Link2 size={14} /> Rattacher
                        </button>{' '}
                        <button
                          className="btn btn-secondary btn-sm"
                          title="Créer un ingrédient portant ce nom"
                          disabled={linking === o.key}
                          onClick={() => createFromDesignation(o)}
                        >
                          <Plus size={14} /> Créer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {orphans.length > 40 && (
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                  {orphans.length - 40} autres désignations moins fréquentes apparaîtront au fur et à mesure.
                </p>
              )}
            </div>
          </div>
        )}

        {tab === 'ingredients' && (
          <div className="card">
            <div className="card-header"><div className="card-title">Référentiel ingrédients</div></div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <input className="form-input" style={{ flex: 2, minWidth: 150 }} value={newIngredient.name} onChange={e => setNewIngredient(p => ({ ...p, name: e.target.value }))} placeholder="Nom ingrédient" />
              <select className="form-select" style={{ minWidth: 90, flex: '0 1 auto' }} value={newIngredient.unit} onChange={e => setNewIngredient(p => ({ ...p, unit: e.target.value }))}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              <input type="number" step="0.01" className="form-input" style={{ minWidth: 90, flex: '0 1 auto' }} value={newIngredient.last_unit_price} onChange={e => setNewIngredient(p => ({ ...p, last_unit_price: parseFloat(e.target.value) || 0 }))} placeholder="Prix/unité" />
              <button className="btn btn-primary" onClick={addIngredient}><Plus size={18} /></button>
            </div>
            <div className="table-container">
              <table>
                <thead><tr><th>Nom</th><th>Unité</th><th>Dernier prix</th><th></th></tr></thead>
                <tbody>
                  {ingredients.map(i => (
                    <tr key={i.id}>
                      <td style={{ fontWeight: 600 }}>{i.name}</td>
                      <td>{i.unit || '—'}</td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          className="form-input"
                          style={{ width: 90, minHeight: 36, padding: '4px 8px' }}
                          defaultValue={i.last_unit_price ?? 0}
                          onBlur={e => updateIngredientPrice(i.id, parseFloat(e.target.value) || 0)}
                        /> €
                      </td>
                      <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => deleteIngredient(i.id)}><Trash2 size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'ia' && (
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Flame size={20} color="var(--orange)" />
                  Cerveau de Fuego (Contexte IA)
                </div>
                <div className="card-subtitle">
                  Donnez à Fuego le maximum d'informations sur votre restaurant pour qu'il vous conseille au mieux (votre concept, vos objectifs, l'histoire du resto, etc.)
                </div>
              </div>
            </div>
            <div style={{ padding: '16px 0 0' }}>
              <textarea
                className="form-input"
                style={{ width: '100%', minHeight: 200, resize: 'vertical', marginBottom: 16 }}
                placeholder="Ex: Nous sommes une pizzeria napolitaine ouverte en 2024. Notre cible : 28% de food cost..."
                value={fuegoContext}
                onChange={(e) => setFuegoContext(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={saveFuegoContext} disabled={savingContext}>
                  <Save size={18} /> {savingContext ? 'Sauvegarde...' : 'Sauvegarder'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Rattrapage de l'historique Square ─────────────────────────────
            La synchronisation courante tourne chaque nuit et couvre les 45
            derniers jours. Cette action-ci sert au cas ponctuel : reprendre un
            historique plus profond. Elle n'a pas sa place dans le geste
            quotidien, d'où sa présence ici et non sur la page Ventes. */}
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RefreshCw size={20} color="var(--teal)" />
                Historique Square
              </div>
              <div className="card-subtitle">
                La caisse se synchronise automatiquement chaque nuit sur les 45 derniers
                jours — rien à faire au quotidien. Ce bouton sert uniquement à remonter
                plus loin, par exemple pour compléter un exercice.
              </div>
            </div>
          </div>
          <div style={{ padding: '16px 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Profondeur à reprendre</label>
                <select
                  className="form-select"
                  value={syncDays}
                  onChange={e => setSyncDays(Number(e.target.value))}
                  style={{ minWidth: 180 }}
                >
                  <option value={90}>3 derniers mois</option>
                  <option value={180}>6 derniers mois</option>
                  <option value={365}>12 derniers mois</option>
                </select>
              </div>
              <button className="btn btn-primary" onClick={runHistorySync} disabled={syncing || diagnosing}>
                <RefreshCw size={18} className={syncing ? 'spinning' : ''} />
                {syncing ? 'Reprise en cours…' : 'Reprendre l’historique'}
              </button>
              {/* Avant de relancer une reprise, savoir si la reprise est bien
                  en cause : une boutique Square non importée ne se rattrape
                  pas, elle se configure. */}
              <button className="btn btn-secondary" onClick={runDiagnostic} disabled={syncing || diagnosing}>
                <Stethoscope size={18} />
                {diagnosing ? 'Analyse…' : 'Diagnostiquer l’écart'}
              </button>
            </div>

            {diagnostic && (
              <div
                className={`alert ${diagnostic.error ? 'alert-warning' : 'alert-success'}`}
                style={{
                  marginTop: 16, alignItems: 'flex-start', flexDirection: 'column',
                  gap: 8, background: diagnostic.error ? undefined : 'var(--cream-light)',
                  color: diagnostic.error ? undefined : 'var(--text-primary)',
                  borderColor: diagnostic.error ? undefined : 'var(--border)',
                }}
              >
                {diagnostic.error ? (
                  <span>{diagnostic.error}</span>
                ) : (
                  <>
                    <strong>
                      Comparaison sur {diagnostic.days} jours (depuis le {diagnostic.since})
                    </strong>
                    <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontWeight: 500 }}>
                      {diagnostic.findings.map((f: string, i: number) => <li key={i}>{f}</li>)}
                    </ul>
                    {diagnostic.locations.length > 1 && (
                      <div style={{ marginTop: 4, fontSize: 12.5 }}>
                        <strong>Boutiques du compte Square :</strong>
                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                          {diagnostic.locations.map((l: any) => (
                            <li key={l.id}>
                              {l.name} — {l.completed.count} commandes,{' '}
                              {formatCurrency(l.completed.amountTtc)}{' '}
                              {l.configured
                                ? <strong style={{ color: 'var(--green)' }}>(importée)</strong>
                                : <strong style={{ color: 'var(--red)' }}>(ignorée)</strong>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {syncReport && (
              <div
                className={`alert ${syncReport.startsWith('Erreur') ? 'alert-warning' : 'alert-success'}`}
                style={{ marginTop: 16 }}
              >
                <span>{syncReport}</span>
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
              L&apos;opération est rejouable sans risque : une commande déjà importée n&apos;est
              jamais dupliquée. Si elle ne va pas au bout d&apos;un coup, elle reprend d&apos;elle-même
              là où elle s&apos;est arrêtée.
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </>
  );
}
