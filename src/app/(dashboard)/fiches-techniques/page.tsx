'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatPercent, RECIPE_CATEGORY_LABELS, FOOD_COST_TARGET } from '@/lib/utils';
import { Plus, ChefHat, Trash2, AlertTriangle, X, Download } from 'lucide-react';
import type { Recipe, Ingredient, RecipeCategory, RecipeIngredient } from '@/lib/types';

export default function FichesTechniquesPage() {
  const [recipes, setRecipes] = useState<(Recipe & { recipe_ingredients: (RecipeIngredient & { ingredient: Ingredient })[] })[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<RecipeCategory | ''>('');
  const [showModal, setShowModal] = useState(false);
  const [editRecipe, setEditRecipe] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState<{ name: string; category: RecipeCategory; portions: number | ''; selling_price: number | '' }>({ name: '', category: 'pizza', portions: 1, selling_price: 0 });
  const [formIngredients, setFormIngredients] = useState<{ ingredient_id?: string | null; sub_recipe_id?: string | null; quantity: number | ''; unit: string }[]>([]);

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: rec, error } = await supabase
      .from('recipes')
      .select('*, recipe_ingredients!recipe_ingredients_recipe_id_fkey(*, ingredient:ingredients(*))')
      .order('name');
    if (error) {
      console.error('Erreur chargement fiches techniques:', error);
      alert('Erreur: ' + error.message);
    }
    setRecipes((rec as typeof recipes) || []);

    const { data: ing } = await supabase.from('ingredients').select('*').order('name');
    setIngredients(ing || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  const convertQuantity = (quantity: number, fromUnit: string, toUnit: string): number => {
    const from = (fromUnit || '').toLowerCase().trim();
    const to = (toUnit || '').toLowerCase().trim();
    if (from === to) return quantity;

    // Convert input to base unit (Kg or L, assuming 1:1 density for cooking)
    let valInBase = quantity;
    if (from === 'g' || from === 'gr' || from === 'ml') valInBase = quantity / 1000;
    else if (from === 'cl') valInBase = quantity / 100;
    else if (from === 'kg' || from === 'l') valInBase = quantity;
    else return quantity; // fallback if units don't match or are 'unité'

    // Convert base unit to target unit
    if (to === 'kg' || to === 'l') return valInBase;
    if (to === 'g' || to === 'gr' || to === 'ml') return valInBase * 1000;
    if (to === 'cl') return valInBase * 100;
    
    return quantity;
  };

  const calcRecipeCost = (ri: any[], allRecipesList: any[] = recipes) => {
    return ri?.reduce((s, r) => {
      if (r.ingredient_id && r.ingredient) {
        const qtyInBaseUnit = convertQuantity(r.quantity || 0, r.unit || '', r.ingredient?.unit || '');
        return s + qtyInBaseUnit * (r.ingredient?.last_unit_price || 0);
      } else if (r.sub_recipe_id) {
        const subRec = allRecipesList.find(rec => rec.id === r.sub_recipe_id);
        if (subRec) {
          const subCost = calcRecipeCost(subRec.recipe_ingredients, allRecipesList);
          const costPerPortion = subRec.portions > 0 ? subCost / subRec.portions : subCost;
          return s + (r.quantity || 0) * costPerPortion;
        }
      }
      return s;
    }, 0) || 0;
  };



  const openNew = () => {
    setEditRecipe(null);
    setForm({ name: '', category: 'pizza', portions: 1, selling_price: 0 });
    setFormIngredients([]);
    setShowModal(true);
  };

  const openEdit = (recipe: typeof recipes[0]) => {
    setEditRecipe(recipe.id);
    setForm({
      name: recipe.name,
      category: recipe.category,
      portions: recipe.portions,
      selling_price: recipe.selling_price || 0,
    });
    setFormIngredients(
      recipe.recipe_ingredients?.map(ri => ({
        ingredient_id: ri.ingredient_id,
        sub_recipe_id: ri.sub_recipe_id,
        quantity: ri.quantity || 0,
        unit: ri.unit || '',
      })) || []
    );
    setShowModal(true);
  };

  const addIngredientRow = () => {
    setFormIngredients(prev => [...prev, { ingredient_id: null, sub_recipe_id: null, quantity: 0, unit: 'g' }]);
  };

  const removeIngredientRow = (idx: number) => {
    setFormIngredients(prev => prev.filter((_, i) => i !== idx));
  };

  const updateIngredientRow = (idx: number, field: string, value: any) => {
    setFormIngredients(prev => prev.map((item, i) => i === idx ? { ...item, [field]: value } : item));
  };

  const calcFormCost = () => {
    return formIngredients.reduce((s, fi) => {
      if (fi.ingredient_id) {
        const ing = ingredients.find(i => i.id === fi.ingredient_id);
        const qtyInBaseUnit = convertQuantity(Number(fi.quantity) || 0, fi.unit || '', ing?.unit || '');
        return s + qtyInBaseUnit * (ing?.last_unit_price || 0);
      } else if (fi.sub_recipe_id) {
        const subRec = recipes.find(rec => rec.id === fi.sub_recipe_id);
        if (subRec) {
          const subCost = calcRecipeCost(subRec.recipe_ingredients, recipes);
          const costPerPortion = subRec.portions > 0 ? subCost / subRec.portions : subCost;
          return s + (Number(fi.quantity) || 0) * costPerPortion;
        }
      }
      return s;
    }, 0);
  };

  const handleSave = async () => {
    if (!form.name) return;
    const safePortions = Number(form.portions) || 1;
    const safeSellingPrice = Number(form.selling_price) || 0;
    const safeIngredients = formIngredients.filter(fi => fi.ingredient_id || fi.sub_recipe_id).map(fi => ({
      ...fi,
      ingredient_id: fi.ingredient_id || null,
      sub_recipe_id: fi.sub_recipe_id || null,
      quantity: Number(fi.quantity) || 0
    }));

    if (editRecipe) {
      await supabase.from('recipes').update({
        name: form.name, category: form.category, portions: safePortions, selling_price: safeSellingPrice,
      }).eq('id', editRecipe);
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', editRecipe);
      if (safeIngredients.length > 0) {
        const { error } = await supabase.from('recipe_ingredients').insert(
          safeIngredients.map(fi => ({ recipe_id: editRecipe, ...fi }))
        );
        if (error) alert("Erreur d'enregistrement : " + error.message);
      }
    } else {
      const { data: newRec } = await supabase.from('recipes').insert({
        name: form.name, category: form.category, portions: safePortions, selling_price: safeSellingPrice,
      }).select('id').single();
      if (newRec && safeIngredients.length > 0) {
        const { error } = await supabase.from('recipe_ingredients').insert(
          safeIngredients.map(fi => ({ recipe_id: newRec.id, ...fi }))
        );
        if (error) alert("Erreur d'enregistrement : " + error.message);
      }
    }
    setShowModal(false);
    loadData();
  };

  const deleteRecipe = async (id: string) => {
    if (!confirm('Supprimer cette fiche technique ?')) return;
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', id);
    await supabase.from('recipes').delete().eq('id', id);
    loadData();
  };

  const [importing, setImporting] = useState(false);

  const importFromSquare = async () => {
    setImporting(true);
    try {
      const res = await fetch('/api/square/import-catalog', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(`${data.count} nouveaux articles importés avec succès !`);
        loadData();
      } else {
        alert("Erreur lors de l'import : " + data.error);
      }
    } catch (e) {
      console.error('Import error:', e);
      alert("Erreur de connexion ou route non trouvée. Pensez à redémarrer le serveur (npm run dev).");
    }
    setImporting(false);
  };

  const filteredRecipes = activeCategory ? recipes.filter(r => r.category === activeCategory) : recipes;
  const totalCostForm = calcFormCost();
  const safePortions = Number(form.portions) || 1;
  const safeSellingPrice = Number(form.selling_price) || 0;
  const costPerPortionForm = safePortions > 0 ? totalCostForm / safePortions : totalCostForm;
  const margeBruteForm = safeSellingPrice > 0 ? ((safeSellingPrice - costPerPortionForm) / safeSellingPrice) * 100 : 0;
  const foodCostForm = safeSellingPrice > 0 ? (costPerPortionForm / safeSellingPrice) * 100 : 0;

  return (
    <>
      <div className="page-header">
        <h2>Fiches techniques</h2>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={importFromSquare} disabled={importing}>
            <Download size={18} /> {importing ? 'Importation...' : 'Importer depuis Square'}
          </button>
          <button className="btn btn-primary" onClick={openNew}><Plus size={18} /> Nouvelle fiche</button>
        </div>
      </div>
      <div className="page-body">
        {/* Category filter */}
        <div className="period-selector" style={{ marginBottom: 20 }}>
          <button className={`period-btn ${activeCategory === '' ? 'active' : ''}`} onClick={() => setActiveCategory('')}>Toutes</button>
          {Object.entries(RECIPE_CATEGORY_LABELS).map(([k, v]) => (
            <button key={k} className={`period-btn ${activeCategory === k ? 'active' : ''}`} onClick={() => setActiveCategory(k as RecipeCategory)}>{v}</button>
          ))}
        </div>

        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : filteredRecipes.length === 0 ? (
          <div className="empty-state"><ChefHat size={48} /><p>Aucune fiche technique. Créez votre première recette !</p></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {filteredRecipes.map(recipe => {
              const cost = calcRecipeCost(recipe.recipe_ingredients);
              const costPortion = recipe.portions > 0 ? cost / recipe.portions : cost;
              const fc = recipe.selling_price && recipe.selling_price > 0 ? (costPortion / recipe.selling_price) * 100 : 0;
              const marge = recipe.selling_price && recipe.selling_price > 0 ? ((recipe.selling_price - costPortion) / recipe.selling_price) * 100 : 0;
              const isDanger = fc > FOOD_COST_TARGET;

              return (
                <div key={recipe.id} className="card" style={{ cursor: 'pointer', borderLeft: isDanger ? '4px solid var(--red)' : '4px solid var(--teal)' }} onClick={() => openEdit(recipe)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{recipe.name}</div>
                      <span className="badge badge-alimentaire" style={{ marginTop: 4 }}>{RECIPE_CATEGORY_LABELS[recipe.category]}</span>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); deleteRecipe(recipe.id); }}><Trash2 size={16} /></button>
                  </div>
                  <div className="grid-2" style={{ marginTop: 16, gap: 8 }}>
                    <div><div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>COÛT/PORTION</div><div style={{ fontWeight: 700 }}>{formatCurrency(costPortion, 4)}</div></div>
                    <div><div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>PRIX VENTE</div><div style={{ fontWeight: 700 }}>{formatCurrency(recipe.selling_price)}</div></div>
                    <div><div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>FOOD COST</div><div style={{ fontWeight: 700, color: isDanger ? 'var(--red)' : 'var(--green)' }}>{formatPercent(fc)} {isDanger && <AlertTriangle size={14} style={{ verticalAlign: 'middle' }} />}</div></div>
                    <div><div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>MARGE</div><div style={{ fontWeight: 700 }}>{formatPercent(marge)}</div></div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>{recipe.recipe_ingredients?.length || 0} ingrédients · {recipe.portions} portion(s)</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Modal */}
        {showModal && (
          <div className="modal-overlay">
            <div className="modal" style={{ maxWidth: 700 }}>
              <div className="modal-header">
                <div className="modal-title">{editRecipe ? 'Modifier la fiche' : 'Nouvelle fiche technique'}</div>
                <button className="modal-close" onClick={() => setShowModal(false)}><X size={20} /></button>
              </div>
              <div className="grid-2">
                <div className="form-group"><label className="form-label">Nom</label><input className="form-input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></div>
                <div className="form-group"><label className="form-label">Catégorie</label>
                  <select className="form-select" value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value as RecipeCategory }))}>
                    {Object.entries(RECIPE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="form-group"><label className="form-label">Portions</label><input type="number" className="form-input" value={form.portions === '' ? '' : form.portions} onChange={e => setForm(p => ({ ...p, portions: e.target.value === '' ? '' as any : parseInt(e.target.value) }))} min={1} /></div>
                <div className="form-group"><label className="form-label">Prix de vente (€)</label><input type="number" step="0.01" className="form-input" value={form.selling_price === '' ? '' : form.selling_price} onChange={e => setForm(p => ({ ...p, selling_price: e.target.value === '' ? '' as any : parseFloat(e.target.value) }))} /></div>
              </div>

              <div style={{ marginTop: 16, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="form-label" style={{ margin: 0 }}>Ingrédients</span>
                <button className="btn btn-secondary btn-sm" onClick={addIngredientRow}><Plus size={14} /> Ajouter</button>
              </div>
              {formIngredients.map((fi, idx) => {
                let displayValue = '';
                let displayCost = 0;
                if (fi.ingredient_id) {
                  const ing = ingredients.find(i => i.id === fi.ingredient_id);
                  if (ing) {
                    displayValue = `${ing.name} (${formatCurrency(ing.last_unit_price)}/${ing.unit})`;
                    displayCost = convertQuantity(Number(fi.quantity) || 0, fi.unit || '', ing.unit || '') * (ing.last_unit_price || 0);
                  }
                } else if (fi.sub_recipe_id) {
                  const rec = recipes.find(r => r.id === fi.sub_recipe_id);
                  if (rec) {
                    displayValue = `[Recette] ${rec.name}`;
                    const subCost = calcRecipeCost(rec.recipe_ingredients, recipes);
                    const costPerPortion = rec.portions > 0 ? subCost / rec.portions : subCost;
                    displayCost = (Number(fi.quantity) || 0) * costPerPortion;
                  }
                }

                return (
                  <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                    <div style={{ flex: 2, position: 'relative' }}>
                      <input 
                        className="form-input" 
                        style={{ width: '100%' }}
                        list={`ingredients-list-${idx}`}
                        placeholder="Rechercher un ingrédient ou recette..."
                        defaultValue={displayValue}
                        onChange={e => {
                          const val = e.target.value;
                          const matchedIng = ingredients.find(i => `${i.name} (${formatCurrency(i.last_unit_price)}/${i.unit})` === val);
                          if (matchedIng) {
                            updateIngredientRow(idx, 'ingredient_id', matchedIng.id);
                            updateIngredientRow(idx, 'sub_recipe_id', null);
                          } else {
                            const matchedRec = recipes.find(r => `[Recette] ${r.name}` === val);
                            if (matchedRec) {
                              updateIngredientRow(idx, 'sub_recipe_id', matchedRec.id);
                              updateIngredientRow(idx, 'ingredient_id', null);
                              updateIngredientRow(idx, 'unit', 'portion');
                            }
                          }
                        }}
                      />
                      <datalist id={`ingredients-list-${idx}`}>
                        {ingredients.map(i => <option key={i.id} value={`${i.name} (${formatCurrency(i.last_unit_price)}/${i.unit})`} />)}
                        {recipes.filter(r => r.id !== editRecipe).map(r => <option key={`rec-${r.id}`} value={`[Recette] ${r.name}`} />)}
                      </datalist>
                    </div>
                    <input type="number" step="0.001" className="form-input" style={{ flex: 1 }} value={fi.quantity === '' ? '' : fi.quantity} onChange={e => updateIngredientRow(idx, 'quantity', e.target.value === '' ? '' : parseFloat(e.target.value))} placeholder="Qté" />
                    <select className="form-select" style={{ flex: 0.7 }} value={fi.unit} onChange={e => updateIngredientRow(idx, 'unit', e.target.value)}>
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                      <option value="L">L</option>
                      <option value="cL">cL</option>
                      <option value="mL">mL</option>
                      <option value="unité">unité</option>
                      <option value="portion">portion</option>
                    </select>
                    <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 60, textAlign: 'right' }}>
                      {formatCurrency(displayCost, 4)}
                    </span>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeIngredientRow(idx)}><Trash2 size={14} /></button>
                  </div>
                );
              })}

              {/* Calculs */}
              <div className="card" style={{ marginTop: 16, background: foodCostForm > FOOD_COST_TARGET ? 'var(--red-light)' : 'var(--green-light)', border: 'none' }}>
                <div className="grid-4" style={{ gap: 12, textAlign: 'center' }}>
                  <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>COÛT TOTAL</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatCurrency(totalCostForm, 3)}</div></div>
                  <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>COÛT/PORTION</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatCurrency(costPerPortionForm, 4)}</div></div>
                  <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>FOOD COST</div><div style={{ fontWeight: 700, fontSize: 16, color: foodCostForm > FOOD_COST_TARGET ? 'var(--red)' : 'var(--green)' }}>{formatPercent(foodCostForm)}</div></div>
                  <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>MARGE BRUTE</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatPercent(margeBruteForm)}</div></div>
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Annuler</button>
                <button className="btn btn-primary" onClick={handleSave}>Enregistrer</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
