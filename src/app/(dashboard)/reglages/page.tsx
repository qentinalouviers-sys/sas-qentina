'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Plus, Trash2, Save, Settings, Flame } from 'lucide-react';
import type { Supplier, Ingredient } from '@/lib/types';

export default function ReglagesPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [newSupplier, setNewSupplier] = useState('');
  const [newIngredient, setNewIngredient] = useState({ name: '', unit: 'kg', last_unit_price: 0 });
  const [tab, setTab] = useState<'suppliers' | 'ingredients' | 'ia' | 'services'>('ingredients');
  const [fuegoContext, setFuegoContext] = useState('');
  const [savingContext, setSavingContext] = useState(false);
  const [openingHours, setOpeningHours] = useState<Record<string, { Midi: boolean; Soir: boolean }>>({
    Lun: { Midi: true, Soir: true }, Mar: { Midi: true, Soir: true },
    Mer: { Midi: true, Soir: true }, Jeu: { Midi: true, Soir: true },
    Ven: { Midi: true, Soir: true }, Sam: { Midi: true, Soir: true },
    Dim: { Midi: true, Soir: true },
  });
  const [savingHours, setSavingHours] = useState(false);

  const supabase = createClient();

  const loadData = useCallback(async () => {
    const { data: s } = await supabase.from('suppliers').select('*').order('name');
    setSuppliers(s || []);
    const { data: i } = await supabase.from('ingredients').select('*').order('name');
    setIngredients(i || []);
    const { data: s_app } = await supabase.from('app_settings').select('value').eq('key', 'fuego_context').single();
    if (s_app && s_app.value) setFuegoContext(s_app.value);
    const { data: s_hours } = await supabase.from('app_settings').select('value').eq('key', 'opening_hours').single();
    if (s_hours && s_hours.value) setOpeningHours(JSON.parse(s_hours.value));
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  const saveOpeningHours = async () => {
    setSavingHours(true);
    const { error } = await supabase.from('app_settings').upsert({ key: 'opening_hours', value: JSON.stringify(openingHours) });
    setSavingHours(false);
    if (!error) alert('Horaires sauvegardés avec succès !');
    else alert('Erreur lors de la sauvegarde.');
  };

  const addSupplier = async () => {
    if (!newSupplier.trim()) return;
    await supabase.from('suppliers').insert({ name: newSupplier.trim() });
    setNewSupplier('');
    loadData();
  };

  const deleteSupplier = async (id: string) => {
    if (!confirm('Supprimer ce fournisseur ?')) return;
    await supabase.from('suppliers').delete().eq('id', id);
    loadData();
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
    loadData();
  };

  const deleteIngredient = async (id: string) => {
    if (!confirm('Supprimer cet ingrédient ?')) return;
    await supabase.from('ingredients').delete().eq('id', id);
    loadData();
  };

  const updateIngredientPrice = async (id: string, price: number) => {
    await supabase.from('ingredients').update({ last_unit_price: price, last_updated: new Date().toISOString() }).eq('id', id);
    loadData();
  };

  const saveFuegoContext = async () => {
    setSavingContext(true);
    const { error } = await supabase.from('app_settings').upsert({ key: 'fuego_context', value: fuegoContext });
    setSavingContext(false);
    if (!error) alert('Contexte sauvegardé avec succès !');
    else alert('Erreur. Assurez-vous que la table app_settings existe.');
  };

  return (
    <>
      <div className="page-header">
        <h2>Réglages</h2>
        <Settings size={22} style={{ color: 'var(--text-muted)' }} />
      </div>
      <div className="page-body">
        {/* Tabs */}
        <div className="period-selector" style={{ marginBottom: 24, flexWrap: 'wrap' }}>
          <button className={`period-btn ${tab === 'ingredients' ? 'active' : ''}`} onClick={() => setTab('ingredients')}>Ingrédients</button>
          <button className={`period-btn ${tab === 'suppliers' ? 'active' : ''}`} onClick={() => setTab('suppliers')}>Fournisseurs</button>
          <button className={`period-btn ${tab === 'services' ? 'active' : ''}`} onClick={() => setTab('services')}>Horaires & Services</button>
          <button className={`period-btn ${tab === 'ia' ? 'active' : ''}`} onClick={() => setTab('ia')}><Flame size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: 'text-bottom' }} /> Fuego IA</button>
        </div>

        {tab === 'services' && (
          <div className="card">
            <div className="card-header"><div className="card-title">Jours et Services d'Ouverture</div></div>
            <div style={{ padding: 24, paddingTop: 0 }}>
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
              <select className="form-select" style={{ width: 100 }} value={newIngredient.unit} onChange={e => setNewIngredient(p => ({ ...p, unit: e.target.value }))}>
                <option value="kg">kg</option><option value="L">L</option><option value="unité">unité</option><option value="g">g</option><option value="mL">mL</option>
              </select>
              <input type="number" step="0.01" className="form-input" style={{ width: 120 }} value={newIngredient.last_unit_price} onChange={e => setNewIngredient(p => ({ ...p, last_unit_price: parseFloat(e.target.value) || 0 }))} placeholder="Prix/unité" />
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
                          style={{ width: 100, padding: '4px 8px' }}
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
            <div style={{ padding: 24, paddingTop: 0 }}>
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
      </div>
    </>
  );
}
