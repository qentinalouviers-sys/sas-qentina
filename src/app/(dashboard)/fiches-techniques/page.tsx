'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatPercent, RECIPE_CATEGORY_LABELS, FOOD_COST_TARGET } from '@/lib/utils';
import { UNITS, convertQuantity, calcRecipeCost } from '@/lib/recipes';
import { Modal } from '@/components/ui';
import { Plus, ChefHat, Trash2, AlertTriangle, Download } from 'lucide-react';
import type { Recipe, Ingredient, RecipeCategory, RecipeIngredient } from '@/lib/types';

type FormIngredient = {
  key: string; // clé React stable (les lignes peuvent être supprimées/réordonnées)
  ingredient_id?: string | null;
  sub_recipe_id?: string | null;
  quantity: number | '';
  unit: string;
  display: string; // texte affiché dans le champ de recherche (input contrôlé)
};

const newRowKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const ingredientLabel = (ing: Ingredient) => `${ing.name} (${formatCurrency(ing.last_unit_price)}/${ing.unit})`;
const recipeLabel = (rec: Recipe) => `[Recette] ${rec.name}`;

export default function FichesTechniquesPage() {
  const [recipes, setRecipes] = useState<(Recipe & { recipe_ingredients: (RecipeIngredient & { ingredient: Ingredient })[] })[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<RecipeCategory | ''>('');
  const [showModal, setShowModal] = useState(false);
  const [editRecipe, setEditRecipe] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState<{ name: string; category: RecipeCategory; portions: number | ''; selling_price: number | '' }>({ name: '', category: 'pizza', portions: 1, selling_price: 0 });
  const [formIngredients, setFormIngredients] = useState<FormIngredient[]>([]);

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

    const { data: ing, error: ingError } = await supabase.from('ingredients').select('*').order('name');
    if (ingError) {
      console.error('Erreur chargement ingrédients:', ingError);
      alert('Erreur: ' + ingError.message);
    }
    setIngredients(ing || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

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
      recipe.recipe_ingredients?.map(ri => {
        let display = '';
        if (ri.ingredient_id && ri.ingredient) {
          display = ingredientLabel(ri.ingredient);
        } else if (ri.sub_recipe_id) {
          const sub = recipes.find(r => r.id === ri.sub_recipe_id);
          if (sub) display = recipeLabel(sub);
        }
        return {
          key: newRowKey(),
          ingredient_id: ri.ingredient_id,
          sub_recipe_id: ri.sub_recipe_id,
          quantity: ri.quantity || 0,
          unit: ri.unit || '',
          display,
        };
      }) || []
    );
    setShowModal(true);
  };

  const addIngredientRow = () => {
    setFormIngredients(prev => [...prev, { key: newRowKey(), ingredient_id: null, sub_recipe_id: null, quantity: 0, unit: 'g', display: '' }]);
  };

  const removeIngredientRow = (idx: number) => {
    setFormIngredients(prev => prev.filter((_, i) => i !== idx));
  };

  const updateIngredientRow = (idx: number, patch: Partial<FormIngredient>) => {
    setFormIngredients(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item));
  };

  // Coût d'une ligne du formulaire (partagé entre le total et l'affichage par ligne)
  const lineCost = (fi: FormIngredient): number => {
    if (fi.ingredient_id) {
      const ing = ingredients.find(i => i.id === fi.ingredient_id);
      if (!ing) return 0;
      const qtyInBaseUnit = convertQuantity(Number(fi.quantity) || 0, fi.unit || '', ing.unit || '');
      return qtyInBaseUnit * (ing.last_unit_price || 0);
    }
    if (fi.sub_recipe_id) {
      const subRec = recipes.find(rec => rec.id === fi.sub_recipe_id);
      if (!subRec) return 0;
      const subCost = calcRecipeCost(subRec.recipe_ingredients, recipes);
      const costPerPortion = subRec.portions > 0 ? subCost / subRec.portions : subCost;
      return (Number(fi.quantity) || 0) * costPerPortion;
    }
    return 0;
  };

  const calcFormCost = () => formIngredients.reduce((s, fi) => s + lineCost(fi), 0);

  const handleSave = async () => {
    if (!form.name) return;
    const safePortions = Number(form.portions) || 1;
    const safeSellingPrice = Number(form.selling_price) || 0;
    const safeIngredients = formIngredients
      .filter(fi => fi.ingredient_id || fi.sub_recipe_id)
      .map(fi => ({
        ingredient_id: fi.ingredient_id || null,
        sub_recipe_id: fi.sub_recipe_id || null,
        quantity: Number(fi.quantity) || 0,
        unit: fi.unit,
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
        if (error) {
          alert("Erreur d'enregistrement : " + error.message + "\nLa recette a été vidée, ré-enregistrez vos ingrédients.");
          loadData();
          return; // la modale reste ouverte pour ré-enregistrer
        }
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
    if (!confirm('Supprimer cette fiche ? Si elle est utilisée comme sous-recette, les lignes correspondantes seront aussi supprimées.')) return;
    // recipe_ingredients est nettoyée par la cascade DB
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
      alert("Erreur de connexion ou route non trouvée.");
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
              const cost = calcRecipeCost(recipe.recipe_ingredients, recipes);
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
          <Modal
            title={editRecipe ? 'Modifier la fiche' : 'Nouvelle fiche technique'}
            onClose={() => setShowModal(false)}
            large
            footer={
              <>
                <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Annuler</button>
                <button className="btn btn-primary" onClick={handleSave}>Enregistrer</button>
              </>
            }
          >
            <div className="grid-2">
              <div className="form-group"><label className="form-label">Nom</label><input className="form-input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></div>
              <div className="form-group"><label className="form-label">Catégorie</label>
                <select className="form-select" value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value as RecipeCategory }))}>
                  {Object.entries(RECIPE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="form-group"><label className="form-label">Portions</label><input type="number" className="form-input" value={form.portions === '' ? '' : form.portions} onChange={e => setForm(p => ({ ...p, portions: e.target.value === '' ? '' as any : parseInt(e.target.value, 10) }))} min={1} /></div>
              <div className="form-group"><label className="form-label">Prix de vente (€)</label><input type="number" step="0.01" className="form-input" value={form.selling_price === '' ? '' : form.selling_price} onChange={e => setForm(p => ({ ...p, selling_price: e.target.value === '' ? '' as any : parseFloat(e.target.value) }))} /></div>
            </div>

            <div style={{ marginTop: 16, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="form-label" style={{ margin: 0 }}>Ingrédients</span>
              <button className="btn btn-secondary btn-sm" onClick={addIngredientRow}><Plus size={14} /> Ajouter</button>
            </div>
            {formIngredients.map((fi, idx) => (
              <div key={fi.key} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 2, position: 'relative', minWidth: 'min(220px, 100%)' }}>
                  <input
                    className="form-input"
                    style={{ width: '100%' }}
                    list={`ingredients-list-${fi.key}`}
                    placeholder="Rechercher un ingrédient ou recette..."
                    value={fi.display}
                    onChange={e => {
                      const val = e.target.value;
                      const matchedIng = ingredients.find(i => ingredientLabel(i) === val);
                      if (matchedIng) {
                        updateIngredientRow(idx, {
                          display: val,
                          ingredient_id: matchedIng.id,
                          sub_recipe_id: null,
                          // si on bascule depuis une sous-recette, l'unité « portion » n'a plus de sens
                          ...(fi.sub_recipe_id || fi.unit === 'portion' ? { unit: matchedIng.unit || 'g' } : {}),
                        });
                      } else {
                        const matchedRec = recipes.find(r => recipeLabel(r) === val);
                        if (matchedRec) {
                          updateIngredientRow(idx, { display: val, sub_recipe_id: matchedRec.id, ingredient_id: null, unit: 'portion' });
                        } else {
                          updateIngredientRow(idx, { display: val });
                        }
                      }
                    }}
                  />
                  <datalist id={`ingredients-list-${fi.key}`}>
                    {ingredients.map(i => <option key={i.id} value={ingredientLabel(i)} />)}
                    {recipes.filter(r => r.id !== editRecipe).map(r => <option key={`rec-${r.id}`} value={recipeLabel(r)} />)}
                  </datalist>
                </div>
                <input type="number" step="0.001" className="form-input" style={{ flex: 1 }} value={fi.quantity === '' ? '' : fi.quantity} onChange={e => updateIngredientRow(idx, { quantity: e.target.value === '' ? '' : parseFloat(e.target.value) })} placeholder="Qté" />
                <select className="form-select" style={{ flex: 0.7 }} value={fi.unit} onChange={e => updateIngredientRow(idx, { unit: e.target.value })}>
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 60, textAlign: 'right' }}>
                  {formatCurrency(lineCost(fi), 4)}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => removeIngredientRow(idx)}><Trash2 size={14} /></button>
              </div>
            ))}

            {/* Calculs */}
            <div className="card" style={{ marginTop: 16, background: foodCostForm > FOOD_COST_TARGET ? 'var(--red-light)' : 'var(--green-light)', border: 'none' }}>
              <div className="grid-4" style={{ gap: 12, textAlign: 'center' }}>
                <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>COÛT TOTAL</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatCurrency(totalCostForm, 3)}</div></div>
                <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>COÛT/PORTION</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatCurrency(costPerPortionForm, 4)}</div></div>
                <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>FOOD COST</div><div style={{ fontWeight: 700, fontSize: 16, color: foodCostForm > FOOD_COST_TARGET ? 'var(--red)' : 'var(--green)' }}>{formatPercent(foodCostForm)}</div></div>
                <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>MARGE BRUTE</div><div style={{ fontWeight: 700, fontSize: 16 }}>{formatPercent(margeBruteForm)}</div></div>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </>
  );
}
