'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Plus, Trash2, Save, Settings, Flame, RefreshCw } from 'lucide-react';
import { UNITS } from '@/lib/recipes';
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
  const [tab, setTab] = useState<'suppliers' | 'ingredients' | 'ia' | 'services'>('ingredients');
  const [fuegoContext, setFuegoContext] = useState('');
  const [savingContext, setSavingContext] = useState(false);
  const [openingHours, setOpeningHours] = useState<Record<string, { Midi: boolean; Soir: boolean }>>({ ...DEFAULT_OPENING_HOURS });
  const [savingHours, setSavingHours] = useState(false);
  const [syncDays, setSyncDays] = useState(365);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<string | null>(null);

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
    const { data } = await supabase.from('suppliers').select('*').order('name');
    setSuppliers(data || []);
  }, [supabase]);

  const loadIngredients = useCallback(async () => {
    const { data } = await supabase.from('ingredients').select('*').order('name');
    setIngredients(data || []);
  }, [supabase]);

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
        </div>

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
            <div className="table-container">
              <table>
                <thead><tr><th>Nom</th><th></th></tr></thead>
                <tbody>
                  {suppliers.map(s => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600 }}>{s.name}</td>
                      <td style={{ textAlign: 'right' }}><button className="btn btn-ghost btn-sm" onClick={() => deleteSupplier(s.id)}><Trash2 size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <button className="btn btn-primary" onClick={runHistorySync} disabled={syncing}>
                <RefreshCw size={18} className={syncing ? 'spinning' : ''} />
                {syncing ? 'Reprise en cours…' : 'Reprendre l’historique'}
              </button>
            </div>
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
