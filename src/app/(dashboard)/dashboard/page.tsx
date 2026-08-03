'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency, formatPercent, getDateRange, toISODate, formatDate,
  getParisHour, getParisDayName, FOOD_COST_TARGET,
} from '@/lib/utils';
import { computeTva } from '@/lib/tva';
import {
  isFinancialFlow, orderHtAmount, bankAmountHt, makeInvoiceMatcher,
} from '@/lib/accounting';
import {
  collectInterventionFacts, detectInterventions, type Intervention,
} from '@/lib/interventions';
import { InterventionsCard } from '@/components/Interventions';
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart,
  Users, Package, Target, Percent, AlertTriangle,
  Activity, Zap, BarChart2, CreditCard, Clock, Star,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Cell,
} from 'recharts';
import type { PeriodFilter } from '@/lib/types';
import {
  KpiCard, SectionHeader, CurrencyTooltip, ChartCard,
  Modal, PeriodSelector, LoadingPage, EmptyState, UnitToggle,
} from '@/components/ui';

// ─── Simulateur : état générique ─────────────────────────────────────────────
type SimKey = 'labor' | 'food' | 'fixed' | 'stock';
type SimMode = 'percent' | 'euro';
type SimState = Record<SimKey, { value: string; mode: SimMode }>;

const EMPTY_SIM: SimState = {
  labor: { value: '', mode: 'percent' },
  food: { value: '', mode: 'percent' },
  fixed: { value: '', mode: 'percent' },
  stock: { value: '', mode: 'percent' },
};

const SIM_LABELS: Record<SimKey, string> = {
  labor: 'Masse Salariale',
  food: 'Charges Variables (Food Cost)',
  fixed: 'Charges Fixes',
  stock: 'Stock Valorisé',
};

/** Champ du simulateur : input numérique + bascule %/€ + rappel du réel. */
function SimulatorField({
  simKey, sim, realPercent, realEuro, onValueChange, onModeChange,
}: {
  simKey: SimKey;
  sim: SimState[SimKey];
  realPercent: number;
  realEuro: number;
  onValueChange: (v: string) => void;
  onModeChange: (m: SimMode) => void;
}) {
  const isPct = sim.mode === 'percent';
  return (
    <div className="form-group">
      <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {SIM_LABELS[simKey]}
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
            (Réel : {isPct ? `${realPercent.toFixed(1)}%` : formatCurrency(realEuro)})
          </span>
        </span>
        <UnitToggle mode={sim.mode} onChange={onModeChange} />
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type="number"
          step={isPct ? '0.1' : '100'}
          min="0"
          max={isPct ? '100' : undefined}
          className="form-input"
          placeholder={isPct ? realPercent.toFixed(1) : realEuro.toFixed(0)}
          value={sim.value}
          onChange={e => onValueChange(e.target.value)}
          style={{ paddingRight: 32, width: '100%' }}
        />
        <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600 }}>
          {isPct ? '%' : '€'}
        </span>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodFilter>('month');
  const [loading, setLoading] = useState(true);
  const [sim, setSim] = useState<SimState>(EMPTY_SIM);
  const [chargesDetails, setChargesDetails] = useState<any[]>([]);
  const [showChargesModal, setShowChargesModal] = useState(false);

  const [interventions, setInterventions] = useState<Intervention[]>([]);

  const [kpis, setKpis] = useState({
    caTotal: 0,
    caHt: 0,
    paiementsDejaFactures: 0,
    nbCommandes: 0,
    ticketMoyen: 0,
    foodCost: 0,
    foodCostAmt: 0,
    ratioSalariale: 0,
    totalLabor: 0,
    totalFixedCharges: 0,
    stockValorise: 0,
    margeNette: 0,
    margeNetteAmt: 0,
    tvaNette: 0,
    tvaCollectee: 0,
    tvaDeductible: 0,
    caEvolution: [] as { date: string; ca: number; commandes: number }[],
    caSparkData: [] as number[],
    topProduits: [] as { name: string; quantity: number; ca: number }[],
    achatsParCategorie: [] as { name: string; value: number }[],
    achatsParFournisseur: [] as { name: string; value: number }[],
    margeParRecette: [] as { name: string; marge: number; foodCost: number; sellingPrice: number; cost: number }[],
    caByDayService: {} as Record<string, {
      midi: { totalCa: number; nbServices: number; nbCommandes: number };
      soir: { totalCa: number; nbServices: number; nbCommandes: number };
    }>,
  });

  const loadKPIs = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { start, end } = getDateRange(period);
    const startStr = toISODate(start);
    const endStr = toISODate(end);

    // Toutes les lectures indépendantes partent EN PARALLÈLE
    // (avant : 10 allers-retours en série → chargement 3-4× plus lent)
    const [
      settingsRes,
      ordersRes,
      tvaRes,
      invoicesRes,
      bankSuppliersRes,
      timecardsRes,
      bankSalariesRes,
      fixedTxRes,
      inventoryRes,
      recipesRes,
    ] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'masked_items'),
      supabase.from('square_orders')
        .select('id, net_amount, service, created_at, raw_data')
        .gte('service', startStr).lte('service', endStr),
      computeTva(supabase, startStr, endStr),
      supabase.from('invoices')
        .select('id, total_ht, total_ttc, supplier:suppliers(name)')
        .gte('date', startStr).lte('date', endStr),
      supabase.from('bank_transactions')
        .select('id, amount, description, category')
        .eq('category', 'variable_fournisseur')
        .is('invoice_id', null)
        .gte('date', startStr).lte('date', endStr),
      supabase.from('labor_timecards')
        .select('id, hours_worked, hourly_rate')
        .gte('start_at', start.toISOString()).lte('start_at', end.toISOString()),
      supabase.from('bank_transactions')
        .select('id, amount, description, category')
        .eq('category', 'variable_salaire')
        .gte('date', startStr).lte('date', endStr),
      supabase.from('bank_transactions')
        .select('id, amount, category, description, date')
        .in('category', ['fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'impot_taxe', 'investissement', 'autre'])
        .gte('date', startStr).lte('date', endStr),
      supabase.from('inventory_counts').select('quantity, unit_price'),
      supabase.from('recipes')
        .select('id, name, selling_price, portions, recipe_ingredients(quantity, ingredient:ingredients(last_unit_price))')
        .not('selling_price', 'is', null),
    ]);

    const maskedIds: string[] = settingsRes.data?.[0]?.value
      ? JSON.parse(settingsRes.data[0].value)
      : [];
    const notMasked = (row: { id?: string | number }) => !maskedIds.includes(String(row.id));

    // Prêts, apports, mouvements de compte courant : ni charge, ni recette.
    // Le même filtre qu'en P&L, sans quoi les deux écrans divergent.
    const sansFlux = (rows: any[]) =>
      rows.filter(t => !isFinancialFlow(t.description || '', t.category));

    // ── 1. Ventes Square ─────────────────────────────────────────────────────
    // Deux montants, et jamais l'un pour l'autre : le TTC est ce que le client
    // a payé (c'est le chiffre de la caisse), le HT est la seule base sur
    // laquelle un ratio de gestion se calcule.
    const activeOrders = (ordersRes.data || []).filter(notMasked);
    const caTotal = activeOrders.reduce((s: number, o: any) => s + (o.net_amount || 0), 0);
    const caHt = activeOrders.reduce((s: number, o: any) => s + orderHtAmount(o), 0);
    const validOrders = activeOrders.filter((o: any) => (o.net_amount || 0) > 0);
    const nbCommandes = validOrders.length;
    const ticketMoyen = nbCommandes > 0 ? caTotal / nbCommandes : 0;

    const caByDate: Record<string, { ca: number; commandes: number }> = {};
    activeOrders.forEach((o: any) => {
      const d = o.service;
      if (!caByDate[d]) caByDate[d] = { ca: 0, commandes: 0 };
      caByDate[d].ca += o.net_amount || 0;
      if ((o.net_amount || 0) > 0) caByDate[d].commandes += 1;
    });
    const caEvolution = Object.entries(caByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date: date.substring(5), ca: v.ca, commandes: v.commandes }));
    const caSparkData = caEvolution.map(d => d.ca);

    // ── Heatmap Jour × Service (heure de Paris, été/hiver corrects) ─────────
    const ALL_DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    type ServiceData = { totalCa: number; nbServices: number; nbCommandes: number };
    const caByDayService: Record<string, { midi: ServiceData; soir: ServiceData }> = {};
    for (const d of ALL_DAYS) {
      caByDayService[d] = {
        midi: { totalCa: 0, nbServices: 0, nbCommandes: 0 },
        soir: { totalCa: 0, nbServices: 0, nbCommandes: 0 },
      };
    }
    const dateServiceSeen = new Set<string>();
    activeOrders.forEach((o: any) => {
      const amt = o.net_amount || 0;
      if (amt <= 0) return;
      const raw = o.raw_data?.created_at || o.created_at || o.service;
      const dt = new Date(raw);
      const service: 'midi' | 'soir' = getParisHour(dt) < 15 ? 'midi' : 'soir';
      const dayName = getParisDayName(dt);
      const dsKey = `${o.service || String(raw).substring(0, 10)}-${service}`;

      caByDayService[dayName][service].totalCa += amt;
      caByDayService[dayName][service].nbCommandes += 1;
      if (!dateServiceSeen.has(dsKey)) {
        dateServiceSeen.add(dsKey);
        caByDayService[dayName][service].nbServices += 1;
      }
    });

    // ── 2. Factures & lignes ─────────────────────────────────────────────────
    const invoices = invoicesRes.data || [];
    const invoiceIds = invoices.map((i: any) => i.id);

    let purchasesAlim = 0, purchasesBoisson = 0, purchasesEmballage = 0;
    let purchasesMateriel = 0, purchasesAutreInvoices = 0;
    let achatsParCategorie: { name: string; value: number }[] = [];
    let achatsParFournisseur: { name: string; value: number }[] = [];
    let activeInvoiceLines: any[] = [];

    if (invoiceIds.length > 0) {
      const { data: lines } = await supabase
        .from('invoice_lines')
        .select('id, total_ht, category, designation, invoice:invoices(date, supplier:suppliers(name))')
        .in('invoice_id', invoiceIds);

      activeInvoiceLines = (lines || []).filter(notMasked);

      const catMap: Record<string, number> = {};
      activeInvoiceLines.forEach((l: any) => {
        const amt = l.total_ht || 0;
        if (l.category === 'alimentaire') purchasesAlim += amt;
        else if (l.category === 'boisson') purchasesBoisson += amt;
        else if (l.category === 'emballage') purchasesEmballage += amt;
        else if (l.category === 'materiel') purchasesMateriel += amt;
        else purchasesAutreInvoices += amt;

        const cat = l.category || 'autre';
        catMap[cat] = (catMap[cat] || 0) + amt;
      });
      achatsParCategorie = Object.entries(catMap)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);

      const supMap: Record<string, number> = {};
      invoices.forEach((i: any) => {
        const name = (i.supplier as any)?.name || 'Inconnu';
        supMap[name] = (supMap[name] || 0) + (i.total_ht || 0);
      });
      achatsParFournisseur = Object.entries(supMap)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
    }

    // ── 3. Dépenses fournisseurs non rapprochées (banque) ───────────────────
    // Deux précautions, identiques au P&L :
    //  - un paiement égal au centime au TTC d'une facture de la période est
    //    déjà compté par cette facture (sinon l'achat compte double) ;
    //  - les montants bancaires sont TTC, les lignes de facture HT : on ramène
    //    les premiers en HT pour que le ratio veuille dire quelque chose.
    const matcher = makeInvoiceMatcher(invoices as any[]);
    const bankSuppliersUnreconciled = sansFlux(bankSuppliersRes.data || [])
      .filter(notMasked)
      .filter((t: any) => !matcher.alreadyInvoiced(t))
      .reduce((s: number, t: any) => s + bankAmountHt(t, 'variable_fournisseur'), 0);

    const foodCostAmt = purchasesAlim + purchasesBoisson + purchasesEmballage + bankSuppliersUnreconciled;
    const foodCost = caHt > 0 ? (foodCostAmt / caHt) * 100 : 0;

    // ── 4. Masse salariale ───────────────────────────────────────────────────
    const laborTimecards = (timecardsRes.data || [])
      .filter(notMasked)
      .reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);
    const laborBank = sansFlux(bankSalariesRes.data || [])
      .filter(notMasked)
      .reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);

    const totalLabor = laborBank > 0 ? laborBank : laborTimecards;
    const ratioSalariale = caHt > 0 ? (totalLabor / caHt) * 100 : 0;

    // ── 5. Charges fixes ─────────────────────────────────────────────────────
    const activeFixedTx = sansFlux(fixedTxRes.data || [])
      .filter(notMasked)
      .filter((t: any) => !matcher.alreadyInvoiced(t));
    const fixedFromBank = activeFixedTx.reduce((s: number, t: any) => s + bankAmountHt(t), 0);
    const totalFixedCharges = fixedFromBank + purchasesMateriel + purchasesAutreInvoices;

    // Détails pour la modale
    const tempDetails: any[] = activeFixedTx.map((t: any) => ({
      id: t.id,
      date: t.date,
      description: t.description || 'Libellé bancaire inconnu',
      amount: -Math.abs(t.amount || 0),
      type: 'Banque',
      category: t.category,
    }));
    activeInvoiceLines.forEach((l: any) => {
      if (l.category !== 'alimentaire' && l.category !== 'boisson' && l.category !== 'emballage') {
        tempDetails.push({
          id: l.id,
          date: l.invoice?.date || startStr,
          description: `${l.invoice?.supplier?.name || 'Fournisseur inconnu'} - ${l.designation || 'Facture'}`,
          amount: -(l.total_ht || 0),
          type: 'Facture',
          category: l.category,
        });
      }
    });
    tempDetails.sort((a, b) => b.date.localeCompare(a.date));
    setChargesDetails(tempDetails);

    // ── 6. Stock valorisé ────────────────────────────────────────────────────
    const stockValorise = (inventoryRes.data || [])
      .reduce((s: number, i: any) => s + (i.quantity || 0) * (i.unit_price || 0), 0);

    // ── 7. Top produits (sur les commandes déjà chargées) ───────────────────
    const oIds = (ordersRes.data || []).map((o: any) => o.id);
    let topProduits: { name: string; quantity: number; ca: number }[] = [];
    if (oIds.length > 0) {
      const { data: items } = await supabase
        .from('square_items')
        .select('name, quantity, total_price')
        .in('order_id', oIds);
      const prodMap: Record<string, { qty: number; ca: number }> = {};
      (items || []).forEach((i: any) => {
        if (!i.name) return;
        if (!prodMap[i.name]) prodMap[i.name] = { qty: 0, ca: 0 };
        prodMap[i.name].qty += i.quantity || 0;
        prodMap[i.name].ca += i.total_price || 0;
      });
      topProduits = Object.entries(prodMap)
        .sort(([, a], [, b]) => b.qty - a.qty)
        .slice(0, 8)
        .map(([name, v]) => ({ name, quantity: v.qty, ca: v.ca }));
    }

    // ── 8. Marge par recette ─────────────────────────────────────────────────
    interface RecipeIngredientRow { quantity: number | null; ingredient: { last_unit_price: number | null } | null; }
    interface RecipeRow { id: string; name: string; selling_price: number | null; portions: number; recipe_ingredients: RecipeIngredientRow[]; }
    const margeParRecette = (((recipesRes.data || []) as unknown) as RecipeRow[]).map(r => {
      const totalCost = r.recipe_ingredients?.reduce((s, ri) => s + (ri.quantity || 0) * (ri.ingredient?.last_unit_price || 0), 0) || 0;
      const costPerPortion = r.portions > 0 ? totalCost / r.portions : totalCost;
      const sp = r.selling_price || 0;
      const marge = sp > 0 ? ((sp - costPerPortion) / sp) * 100 : 0;
      const fc = sp > 0 ? (costPerPortion / sp) * 100 : 0;
      return { name: r.name, marge, foodCost: fc, sellingPrice: sp, cost: costPerPortion };
    }).sort((a, b) => b.marge - a.marge);

    // ── 9. EBE ───────────────────────────────────────────────────────────────
    // Sur base HT : la TVA collectée n'est pas un revenu, elle est due à l'État.
    const margeNetteAmt = caHt - foodCostAmt - totalLabor - totalFixedCharges;
    const margeNette = caHt > 0 ? (margeNetteAmt / caHt) * 100 : 0;

    setKpis({
      caTotal, caHt, nbCommandes, ticketMoyen,
      foodCost, foodCostAmt,
      ratioSalariale, totalLabor,
      totalFixedCharges,
      stockValorise, margeNette, margeNetteAmt,
      tvaNette: tvaRes.netTva, tvaCollectee: tvaRes.collectedTva, tvaDeductible: tvaRes.deductibleTva,
      caEvolution, caSparkData,
      topProduits, achatsParCategorie, achatsParFournisseur,
      margeParRecette, caByDayService,
      paiementsDejaFactures: matcher.count(),
    });
    setLoading(false);

    // ── 10. Interventions ────────────────────────────────────────────────────
    // Lancé APRÈS l'affichage : le module dit ce qui empêche les chiffres
    // d'être justes, mais il ne doit pas retarder les chiffres eux-mêmes.
    try {
      const facts = await collectInterventionFacts(supabase, {
        start: startStr,
        end: endStr,
        today: toISODate(new Date()),
        foodCostPercent: caHt > 0 ? foodCost : null,
      });
      setInterventions(detectInterventions(facts));
    } catch {
      // Une base incomplète (table absente) ne doit pas casser l'accueil.
      setInterventions([]);
    }
  }, [period]);

  useEffect(() => { loadKPIs(); }, [loadKPIs]);

  // Realtime : rechargement regroupé (debounce 2 s) au lieu d'un reload par événement
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const supabase = createClient();
    const scheduleReload = () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => loadKPIs(), 2000);
    };
    const channel = supabase.channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'square_orders' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_lines' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_transactions' }, scheduleReload)
      .subscribe();
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      supabase.removeChannel(channel);
    };
  }, [loadKPIs]);

  // ─── Simulateur : valeurs réelles de référence par champ ──────────────────
  const realValues: Record<SimKey, { percent: number; euro: number }> = {
    labor: { percent: kpis.ratioSalariale, euro: kpis.totalLabor },
    food: { percent: kpis.foodCost, euro: kpis.foodCostAmt },
    fixed: { percent: kpis.caHt > 0 ? (kpis.totalFixedCharges / kpis.caHt) * 100 : 0, euro: kpis.totalFixedCharges },
    stock: { percent: kpis.caHt > 0 ? (kpis.stockValorise / kpis.caHt) * 100 : 0, euro: kpis.stockValorise },
  };

  const setSimValue = (key: SimKey, value: string) =>
    setSim(prev => ({ ...prev, [key]: { ...prev[key], value } }));

  /** Change %/€ en convertissant la valeur saisie pour garder le même montant. */
  const setSimMode = (key: SimKey, mode: SimMode) =>
    setSim(prev => {
      const cur = prev[key];
      if (cur.mode === mode) return prev;
      let value = cur.value;
      const parsed = parseFloat(cur.value);
      if (cur.value !== '' && !isNaN(parsed)) {
        value = mode === 'euro'
          ? ((parsed * kpis.caHt) / 100).toFixed(0)
          : (kpis.caHt > 0 ? (parsed / kpis.caHt) * 100 : 0).toFixed(1);
      }
      return { ...prev, [key]: { value, mode } };
    });

  /** Montant simulé en € et en % pour un champ (null si non renseigné). */
  const simulated = (key: SimKey): { percent: number; euro: number } | null => {
    const parsed = parseFloat(sim[key].value);
    if (sim[key].value === '' || isNaN(parsed)) return null;
    if (sim[key].mode === 'percent') {
      return { percent: parsed, euro: (kpis.caHt * parsed) / 100 };
    }
    return { percent: kpis.caHt > 0 ? (parsed / kpis.caHt) * 100 : 0, euro: parsed };
  };

  const simLabor = simulated('labor');
  const simFood = simulated('food');
  const simFixed = simulated('fixed');
  const simStock = simulated('stock');
  const isSimulationActive = !!(simLabor || simFood || simFixed || simStock);

  const displayLaborRatio = simLabor?.percent ?? kpis.ratioSalariale;
  const displayLaborAmt = simLabor?.euro ?? kpis.totalLabor;
  const displayFixedRatio = simFixed?.percent ?? realValues.fixed.percent;
  const displayFixedAmt = simFixed?.euro ?? kpis.totalFixedCharges;
  const displayStockAmt = simStock?.euro ?? kpis.stockValorise;
  const baseFoodAmt = simFood?.euro ?? kpis.foodCostAmt;

  // Un stock simulé plus haut = moins de matière consommée → food cost plus bas
  const stockChange = displayStockAmt - kpis.stockValorise;
  const adjustedFoodAmt = baseFoodAmt - stockChange;
  const adjustedFoodRatio = kpis.caHt > 0 ? (adjustedFoodAmt / kpis.caHt) * 100 : 0;

  const displayFoodRatioToUse = (simFood || simStock) ? adjustedFoodRatio : kpis.foodCost;
  const displayFoodAmtToUse = (simFood || simStock) ? adjustedFoodAmt : kpis.foodCostAmt;

  const displayPrimeCost = displayFoodRatioToUse + displayLaborRatio;
  const displayMargeNetteAmt = kpis.caHt - (adjustedFoodAmt + displayLaborAmt + displayFixedAmt);
  const displayMargeNetteRatio = kpis.caHt > 0 ? (displayMargeNetteAmt / kpis.caHt) * 100 : 0;

  const fcBad = displayFoodRatioToUse > FOOD_COST_TARGET;
  const tvaBad = kpis.tvaNette > 0;

  const chiffresFiables = !interventions.some(i => i.severity === 'critique');
  const { start: periodStart, end: periodEnd } = getDateRange(period);
  const periodLabel = `${formatDate(toISODate(periodStart))} → ${formatDate(toISODate(periodEnd))}`;

  const CAT_COLORS = ['#2A7D7B', '#E89B3E', '#7C3AED', '#2D8F5E', '#D94F4F', '#1A5AA0'];
  const ORDERED_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

  return (
    <>
      {/* ── En-tête ─────────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={20} style={{ color: 'var(--teal)' }} />
            Tableau de bord
          </h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Vue consolidée de votre restaurant — données en temps réel
          </div>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <div className="page-body">
        {loading ? (
          <LoadingPage text="Chargement du tableau de bord…" />
        ) : (
          <>
            {/* ── À faire : ce qui empêche les chiffres d'être justes ──────── */}
            <InterventionsCard items={interventions} periodLabel={periodLabel} />

            {/* ── Alertes de pilotage ──────────────────────────────────────
                Masquées tant qu'une intervention critique est ouverte :
                annoncer un food cost « au-dessus de la cible » alors que le
                chiffre d'affaires est incomplet envoie chercher un problème
                de gestion qui n'existe pas. */}
            {chiffresFiables && (fcBad || tvaBad) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {fcBad && (
                  <div className="alert alert-danger" style={{ gap: 10 }}>
                    <AlertTriangle size={16} />
                    <span>
                      Food cost à <strong>{formatPercent(kpis.foodCost)}</strong> — dépasse l&apos;objectif de {FOOD_COST_TARGET}%.
                      {kpis.caHt > 0 && ` Soit ${formatCurrency(kpis.foodCostAmt)} sur ${formatCurrency(kpis.caHt)} de CA HT.`}
                    </span>
                  </div>
                )}
                {tvaBad && (
                  <div className="alert alert-warning" style={{ gap: 10 }}>
                    <Percent size={16} />
                    <span>
                      TVA nette à payer estimée : <strong>{formatCurrency(kpis.tvaNette)}</strong> —
                      pensez à provisionner avant votre déclaration.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── SECTION 1 : Performance commerciale ─────────────────────── */}
            <SectionHeader title="Performance commerciale" subtitle="Ventes & activité" icon={<TrendingUp size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label="Chiffre d'affaires TTC"
                value={formatCurrency(kpis.caTotal)}
                subValue={`${formatCurrency(kpis.caHt)} HT · ${kpis.nbCommandes} commandes`}
                icon={<DollarSign size={20} />}
                accentColor="#2A7D7B"
                spark={kpis.caSparkData}
              />
              <KpiCard
                label="Ticket moyen"
                value={formatCurrency(kpis.ticketMoyen)}
                subValue="Par commande"
                icon={<ShoppingCart size={20} />}
                accentColor="#7C3AED"
              />
              <KpiCard
                label="Commandes"
                value={kpis.nbCommandes.toString()}
                subValue={kpis.caTotal > 0 && kpis.nbCommandes > 0
                  ? `Moy. ${formatCurrency(kpis.ticketMoyen)}/commande`
                  : 'Aucune vente'}
                icon={<BarChart2 size={20} />}
                accentColor="#2D8F5E"
              />
              <KpiCard
                label="Marge nette estimée"
                value={formatPercent(displayMargeNetteRatio)}
                subValue={formatCurrency(displayMargeNetteAmt)}
                icon={<Star size={20} />}
                accentColor={displayMargeNetteRatio >= 20 ? '#2D8F5E' : displayMargeNetteRatio >= 10 ? '#E89B3E' : '#D94F4F'}
                badge={{
                  text: isSimulationActive ? '🧪 Simulé' : displayMargeNetteRatio >= 20 ? '✓ Bonne marge' : displayMargeNetteRatio >= 10 ? 'Marge correcte' : 'Marge faible',
                  type: isSimulationActive ? 'neutral' : displayMargeNetteRatio >= 20 ? 'good' : displayMargeNetteRatio >= 10 ? 'neutral' : 'bad',
                }}
              />
            </div>

            {/* ── SECTION 2 : Contrôle des coûts ──────────────────────────── */}
            <SectionHeader title="Contrôle des coûts" subtitle="Food cost, masse salariale & stocks" icon={<Target size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label="Food Cost"
                value={formatPercent(displayFoodRatioToUse)}
                subValue={`${formatCurrency(displayFoodAmtToUse)} matières / ${formatCurrency(kpis.caHt)} CA HT`}
                icon={<Target size={20} />}
                accentColor={fcBad ? '#D94F4F' : '#2D8F5E'}
                badge={{
                  text: (simFood || simStock) ? '🧪 Simulé' : fcBad ? `⚠ +${(displayFoodRatioToUse - FOOD_COST_TARGET).toFixed(1)}% cible` : `✓ Cible 28-32%`,
                  type: (simFood || simStock) ? 'neutral' : fcBad ? 'bad' : 'good',
                }}
              />
              <KpiCard
                label="Masse salariale"
                value={formatPercent(displayLaborRatio)}
                subValue={`${formatCurrency(displayLaborAmt)} en coût total`}
                icon={<Users size={20} />}
                accentColor={displayLaborRatio > 35 ? '#D94F4F' : '#E89B3E'}
                badge={{
                  text: simLabor ? '🧪 Simulé' : displayLaborRatio > 35 ? '⚠ Élevée' : displayLaborRatio > 0 ? 'Normal' : 'Pas de données',
                  type: simLabor ? 'neutral' : displayLaborRatio > 35 ? 'bad' : 'neutral',
                }}
              />
              <KpiCard
                label="Stock valorisé"
                value={formatCurrency(displayStockAmt)}
                subValue={simStock ? '🧪 Valeur de stock simulée' : 'Valeur du stock actuel'}
                icon={<Package size={20} />}
                accentColor="#1A5AA0"
                badge={simStock ? { text: '🧪 Simulé', type: 'neutral' } : undefined}
              />
              <KpiCard
                label="Charges Fixes & Ops"
                value={formatCurrency(displayFixedAmt)}
                subValue={kpis.caHt > 0 ? `${displayFixedRatio.toFixed(1)}% du CA HT` : '0% du CA HT'}
                icon={<CreditCard size={20} />}
                accentColor="#7C3AED"
                badge={simFixed ? { text: '🧪 Simulé', type: 'neutral' } : undefined}
                onClick={() => setShowChargesModal(true)}
              />
              <KpiCard
                label="Prime Cost"
                value={formatPercent(displayPrimeCost)}
                subValue="Food cost + Masse salariale"
                icon={<Zap size={20} />}
                accentColor={displayPrimeCost > 65 ? '#D94F4F' : '#2D8F5E'}
                badge={{
                  text: isSimulationActive ? '🧪 Simulé' : displayPrimeCost > 65 ? '⚠ > 65%' : '✓ < 65%',
                  type: isSimulationActive ? 'neutral' : displayPrimeCost > 65 ? 'bad' : 'good',
                }}
              />
            </div>

            {/* ── Simulateur EBE ───────────────────────────────────────────── */}
            <div className="card" style={{
              marginBottom: 24,
              border: isSimulationActive ? '1.5px solid var(--orange)' : '1px solid var(--border)',
              background: 'linear-gradient(135deg, white 0%, var(--cream-light) 100%)',
              padding: 20,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <Zap size={20} style={{ color: isSimulationActive ? 'var(--orange)' : 'var(--teal)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Simulateur de Marge Opérationnelle (EBE)</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                    Ajustez les charges et les stocks pour voir l&apos;impact en temps réel sur vos marges
                  </p>
                </div>
                {isSimulationActive && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--red)' }}
                    onClick={() => setSim(EMPTY_SIM)}
                  >
                    Réinitialiser
                  </button>
                )}
              </div>

              <div className="grid-2-1" style={{ gap: 20 }}>
                {/* Champs de simulation */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(['labor', 'food', 'fixed', 'stock'] as SimKey[]).map(key => (
                    <SimulatorField
                      key={key}
                      simKey={key}
                      sim={sim[key]}
                      realPercent={realValues[key].percent}
                      realEuro={realValues[key].euro}
                      onValueChange={v => setSimValue(key, v)}
                      onModeChange={m => setSimMode(key, m)}
                    />
                  ))}
                </div>

                {/* Résultat visuel */}
                <div style={{
                  background: 'white',
                  border: '1px solid var(--border-light)',
                  borderRadius: 16,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  {(() => {
                    const ebeStatus = displayMargeNetteRatio >= 20
                      ? { label: 'EBE Excellent (Cible atteinte)', color: '#2D8F5E', bg: '#EDF7ED' }
                      : displayMargeNetteRatio >= 10
                        ? { label: 'EBE Correct (À surveiller)', color: '#E89B3E', bg: '#FFF8E1' }
                        : { label: 'EBE Critique (Alerte rouge)', color: '#D94F4F', bg: '#FDECEF' };
                    const progressPercent = Math.min(Math.max((displayMargeNetteRatio / 30) * 100, 0), 100);

                    return (
                      <>
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          background: ebeStatus.bg, color: ebeStatus.color,
                          padding: '10px 14px', borderRadius: 12,
                          fontWeight: 750, fontSize: 13.5, gap: 8, flexWrap: 'wrap',
                        }}>
                          <span>Statut Résultat :</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              width: 10, height: 10, borderRadius: '50%',
                              background: ebeStatus.color, boxShadow: `0 0 8px ${ebeStatus.color}`,
                              display: 'inline-block',
                            }} />
                            {ebeStatus.label}
                          </span>
                        </div>

                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                            <span>Taux de Marge Opérationnelle (EBE)</span>
                            <strong>{displayMargeNetteRatio.toFixed(1)}% / 30%</strong>
                          </div>
                          <div style={{ height: 10, background: 'var(--border-light)', borderRadius: 10, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%',
                              width: `${progressPercent}%`,
                              background: ebeStatus.color,
                              borderRadius: 10,
                              transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                            }} />
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginTop: 4, fontWeight: 500 }}>
                            <span>0% (Déficitaire)</span>
                            <span>10% (Correct)</span>
                            <span>20% (Excellent)</span>
                            <span>30%+</span>
                          </div>
                        </div>
                      </>
                    );
                  })()}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, borderTop: '1px solid var(--border-light)', paddingTop: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Chiffre d&apos;affaires :</span>
                      <strong>{formatCurrency(kpis.caTotal)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>EBE Réel (Constaté) :</span>
                      <span style={{ fontWeight: 600, color: kpis.margeNette >= 15 ? 'var(--green)' : 'var(--text-secondary)' }}>
                        {formatPercent(kpis.margeNette)} ({formatCurrency(kpis.margeNetteAmt)})
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed var(--border-light)', paddingBottom: 8 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>EBE Projeté (Simulé) :</span>
                      <span style={{ fontWeight: 800, fontSize: 14, color: displayMargeNetteRatio >= 15 ? 'var(--green)' : displayMargeNetteRatio >= 10 ? 'var(--orange)' : 'var(--red)' }}>
                        {formatPercent(displayMargeNetteRatio)} ({formatCurrency(displayMargeNetteAmt)})
                      </span>
                    </div>

                    <div style={{
                      marginTop: 6,
                      background: 'linear-gradient(135deg, var(--cream-light) 0%, white 100%)',
                      borderRadius: 12,
                      padding: '12px 14px',
                      textAlign: 'center',
                      border: '1px dashed var(--border)',
                      fontSize: 13,
                    }}>
                      {(() => {
                        const diff = displayMargeNetteAmt - kpis.margeNetteAmt;
                        if (Math.abs(diff) < 0.01) {
                          return <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Aucun écart par rapport aux chiffres réels.</span>;
                        }
                        return diff > 0 ? (
                          <span style={{ color: '#2D8F5E', fontWeight: 800 }}>
                            📈 Gain potentiel : <strong>+{formatCurrency(diff)} HT</strong> de bénéfices en plus !
                          </span>
                        ) : (
                          <span style={{ color: '#D94F4F', fontWeight: 800 }}>
                            📉 Écart de marge : <strong>-{formatCurrency(Math.abs(diff))} HT</strong> par rapport au réel.
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── SECTION 3 : TVA ──────────────────────────────────────────── */}
            <SectionHeader title="Tableau de bord TVA" subtitle="Balance fiscale estimée sur la période" icon={<Percent size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label={kpis.tvaNette >= 0 ? 'TVA Nette à payer' : 'Crédit de TVA'}
                value={formatCurrency(Math.abs(kpis.tvaNette))}
                subValue={kpis.tvaNette >= 0 ? "À reverser à l'administration" : 'Créance récupérable'}
                icon={kpis.tvaNette >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                accentColor={kpis.tvaNette >= 0 ? '#E89B3E' : '#2D8F5E'}
                badge={{
                  text: kpis.tvaNette >= 0 ? 'À provisionner' : 'Crédit TVA',
                  type: kpis.tvaNette >= 0 ? 'bad' : 'good',
                }}
              />
              <KpiCard
                label="TVA Collectée (Ventes)"
                value={formatCurrency(kpis.tvaCollectee)}
                subValue={`${kpis.caHt > 0 ? ((kpis.tvaCollectee / kpis.caHt) * 100).toFixed(1) : '0'}% du CA HT`}
                icon={<CreditCard size={20} />}
                accentColor="#2A7D7B"
              />
              <KpiCard
                label="TVA Déductible (Achats)"
                value={formatCurrency(kpis.tvaDeductible)}
                subValue="Sur factures & relevés banque"
                icon={<Clock size={20} />}
                accentColor="#7C3AED"
              />
              <div style={{
                background: 'linear-gradient(135deg, #2A7D7B 0%, #1A5D5B 100%)',
                borderRadius: 16, padding: '18px 20px',
                color: 'white', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: '0 4px 20px rgba(42,125,123,0.3)', minWidth: 0,
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', opacity: 0.75 }}>
                  Balance TVA
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, margin: '8px 0', overflowWrap: 'anywhere' }}>
                  {formatCurrency(kpis.tvaCollectee)} − {formatCurrency(kpis.tvaDeductible)}
                </div>
                <div style={{ fontSize: 13, opacity: 0.85, fontWeight: 500 }}>
                  = <strong>{formatCurrency(Math.abs(kpis.tvaNette))}</strong>{' '}
                  {kpis.tvaNette >= 0 ? 'à reverser' : 'de crédit TVA'}
                </div>
                <div style={{ marginTop: 12, fontSize: 11, opacity: 0.65 }}>
                  Détail complet dans l&apos;onglet TVA →
                </div>
              </div>
            </div>

            {/* ── SECTION 4 : Tendances ────────────────────────────────────── */}
            <SectionHeader title="Tendances & Évolution" subtitle="Visualisation de votre activité dans le temps" icon={<TrendingUp size={18} />} />

            <ChartCard
              title="Évolution du Chiffre d'Affaires"
              subtitle="CA journalier sur la période sélectionnée"
              headerRight={
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--teal)' }}>{formatCurrency(kpis.caTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total période</div>
                </div>
              }
            >
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={kpis.caEvolution} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="caGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2A7D7B" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#2A7D7B" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} tickFormatter={v => `${v}€`} />
                    <Tooltip content={<CurrencyTooltip />} />
                    <Area type="monotone" dataKey="ca" name="CA (€)" fill="url(#caGradient)" stroke="#2A7D7B" strokeWidth={2.5} dot={false} />
                    {kpis.caTotal > 0 && (
                      <ReferenceLine
                        y={kpis.caTotal / Math.max(kpis.caEvolution.length, 1)}
                        stroke="var(--orange)"
                        strokeDasharray="4 4"
                        label={{ value: 'Moy.', position: 'right', fill: 'var(--orange)', fontSize: 11 }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <div className="grid-2" style={{ marginBottom: 14 }}>
              <ChartCard title="Top Produits" subtitle="Par quantité vendue" style={{ marginBottom: 0 }}>
                {kpis.topProduits.length > 0 ? (
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={kpis.topProduits} layout="vertical" margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                        <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                        <Tooltip />
                        <Bar dataKey="quantity" name="Qté vendue" fill="#2A7D7B" radius={[0, 6, 6, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState text="Aucune donnée produit" />
                )}
              </ChartCard>

              <ChartCard title="Achats par Catégorie" subtitle="Répartition des dépenses HT" style={{ marginBottom: 0 }}>
                {kpis.achatsParCategorie.length > 0 ? (
                  <>
                    <div style={{ height: 180 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={kpis.achatsParCategorie} margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                          <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} tickFormatter={v => `${v}€`} />
                          <Tooltip formatter={(v: any) => formatCurrency(v)} />
                          <Bar dataKey="value" name="Montant HT" radius={[6, 6, 0, 0]}>
                            {kpis.achatsParCategorie.map((_, i) => (
                              <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      {kpis.achatsParCategorie.map((c, i) => {
                        const total = kpis.achatsParCategorie.reduce((s, x) => s + x.value, 0);
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                            <div style={{ width: 10, height: 10, borderRadius: 3, background: CAT_COLORS[i % CAT_COLORS.length] }} />
                            <span style={{ color: 'var(--text-secondary)' }}>{c.name}</span>
                            <strong>{total > 0 ? ((c.value / total) * 100).toFixed(0) : 0}%</strong>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <EmptyState text="Aucune facture sur cette période" />
                )}
              </ChartCard>
            </div>

            {kpis.achatsParFournisseur.length > 0 && (
              <ChartCard title="Achats par Fournisseur" subtitle="Volume d'achats HT – Top 6">
                <div style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={kpis.achatsParFournisseur} layout="vertical" margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} tickFormatter={v => `${v}€`} />
                      <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v: any) => formatCurrency(v)} />
                      <Bar dataKey="value" name="Achats HT" fill="#E89B3E" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>
            )}

            {/* ── SECTION 5 : Marge par recette ───────────────────────────── */}
            {kpis.margeParRecette.length > 0 && (
              <>
                <SectionHeader title="Rentabilité par Recette" subtitle="Food cost et marge par plat" icon={<Star size={18} />} />
                <ChartCard title="Marges brutes" subtitle="Basées sur les fiches techniques et les derniers prix d'achat" style={{ marginBottom: 24 }}>
                  <div className="table-container" style={{ border: 'none' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Recette</th>
                          <th style={{ textAlign: 'right' }}>Prix vente</th>
                          <th style={{ textAlign: 'right' }}>Coût matière</th>
                          <th style={{ textAlign: 'right' }}>Food cost</th>
                          <th style={{ textAlign: 'right' }}>Marge brute</th>
                          <th>Statut</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpis.margeParRecette.map(r => {
                          const fcBadRecipe = r.foodCost > FOOD_COST_TARGET;
                          const margeGood = r.marge >= 68;
                          return (
                            <tr key={r.name}>
                              <td style={{ fontWeight: 600 }}>{r.name}</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(r.sellingPrice)}</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(r.cost)}</td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="badge" style={{
                                  background: fcBadRecipe ? 'var(--red-light)' : 'var(--green-light)',
                                  color: fcBadRecipe ? 'var(--red)' : 'var(--green)',
                                  fontWeight: 700,
                                }}>
                                  {formatPercent(r.foodCost)}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: margeGood ? 'var(--green)' : r.marge < 60 ? 'var(--red)' : 'var(--text-primary)' }}>
                                {formatPercent(r.marge)}
                              </td>
                              <td>
                                <span className="badge" style={{
                                  background: margeGood ? 'var(--green-light)' : r.marge < 60 ? 'var(--red-light)' : 'var(--orange-light)',
                                  color: margeGood ? 'var(--green)' : r.marge < 60 ? 'var(--red)' : '#9A6B1F',
                                }}>
                                  {margeGood ? '⭐ Star' : r.marge < 60 ? '⚠ À revoir' : 'Correct'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </ChartCard>
              </>
            )}

            {/* ── SECTION 6 : Heatmap jours × services ────────────────────── */}
            {(() => {
              const hasDayData = ORDERED_DAYS.some(d => {
                const ds = kpis.caByDayService[d];
                return ds && (ds.midi.nbServices > 0 || ds.soir.nbServices > 0);
              });
              if (!hasDayData) return null;

              let maxAvg = 0;
              ORDERED_DAYS.forEach(d => {
                const ds = kpis.caByDayService[d];
                if (!ds) return;
                const mMidi = ds.midi.nbServices > 0 ? ds.midi.totalCa / ds.midi.nbServices : 0;
                const mSoir = ds.soir.nbServices > 0 ? ds.soir.totalCa / ds.soir.nbServices : 0;
                maxAvg = Math.max(maxAvg, mMidi, mSoir);
              });

              const heatColor = (intensity: number) =>
                intensity === 0 ? 'var(--cream-light)' : `rgba(42, 125, 123, ${(0.12 + intensity * 0.7).toFixed(2)})`;
              const textColor = (intensity: number) =>
                intensity > 0.55 ? 'white' : intensity > 0.15 ? 'var(--teal-dark)' : 'var(--text-muted)';

              const renderServiceRow = (label: string, service: 'midi' | 'soir') => (
                <>
                  <div className="heatmap-label">{label}</div>
                  {ORDERED_DAYS.map(d => {
                    const ds = kpis.caByDayService[d];
                    const sd = ds?.[service];
                    const avg = sd && sd.nbServices > 0 ? sd.totalCa / sd.nbServices : 0;
                    const intensity = maxAvg > 0 ? avg / maxAvg : 0;
                    return (
                      <div
                        key={d}
                        className="heatmap-cell"
                        style={{ background: heatColor(intensity) }}
                        title={ds ? `${d} ${label} — ${sd?.nbServices ?? 0} service(s), ${sd?.nbCommandes ?? 0} commandes` : ''}
                      >
                        {avg > 0 ? (
                          <>
                            <div style={{ fontSize: 13, fontWeight: 800, color: textColor(intensity), lineHeight: 1 }}>
                              {formatCurrency(avg, 0)}
                            </div>
                            <div style={{ fontSize: 10, color: textColor(intensity), opacity: 0.8, marginTop: 3 }}>
                              {sd?.nbServices ?? 0}×
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.5 }}>—</div>
                        )}
                      </div>
                    );
                  })}
                </>
              );

              return (
                <>
                  <SectionHeader
                    title="Tendances CA par Jour & Service"
                    subtitle="Moyenne de chiffre d'affaires par service — midi (avant 15h) vs soir (après 15h)"
                    icon={<BarChart2 size={18} />}
                  />
                  <ChartCard
                    title="Heatmap hebdomadaire"
                    subtitle={`Basé sur ${Object.values(kpis.caByDayService).reduce((s, d) => s + d.midi.nbServices + d.soir.nbServices, 0)} services sur la période`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                      {[
                        { alpha: 0.15, label: 'Faible CA' },
                        { alpha: 0.55, label: 'CA moyen' },
                        { alpha: 0.82, label: 'Fort CA' },
                      ].map(({ alpha, label }) => (
                        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                          <div style={{ width: 16, height: 16, borderRadius: 4, background: `rgba(42,125,123,${alpha})` }} />
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>

                    <div className="scroll-x">
                      <div className="heatmap-grid">
                        <div />
                        {ORDERED_DAYS.map(d => (
                          <div key={d} className="heatmap-day-header">{d.substring(0, 3).toUpperCase()}</div>
                        ))}
                        {renderServiceRow('🌤 Midi', 'midi')}
                        {renderServiceRow('🌙 Soir', 'soir')}

                        {/* Total par jour */}
                        <div className="heatmap-label" style={{ color: 'var(--teal)', fontWeight: 800 }}>∑ Total</div>
                        {ORDERED_DAYS.map(d => {
                          const ds = kpis.caByDayService[d];
                          const totalCa = (ds?.midi.totalCa || 0) + (ds?.soir.totalCa || 0);
                          const totalServices = (ds?.midi.nbServices || 0) + (ds?.soir.nbServices || 0);
                          const avgTotal = totalServices > 0 ? totalCa / totalServices : 0;
                          return (
                            <div key={d} style={{ borderTop: '1px solid var(--border-light)', paddingTop: 6, textAlign: 'center' }}>
                              {avgTotal > 0 ? (
                                <>
                                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--teal)' }}>
                                    {formatCurrency(avgTotal, 0)}
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>moy/svc</div>
                                </>
                              ) : (
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.5 }}>—</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{ marginTop: 20, borderTop: '1px solid var(--border-light)', paddingTop: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Comparaison CA moyen par jour
                      </div>
                      <div style={{ height: 160 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={ORDERED_DAYS.map(d => {
                              const ds = kpis.caByDayService[d];
                              return {
                                name: d.substring(0, 3),
                                Midi: ds && ds.midi.nbServices > 0 ? Math.round(ds.midi.totalCa / ds.midi.nbServices) : 0,
                                Soir: ds && ds.soir.nbServices > 0 ? Math.round(ds.soir.totalCa / ds.soir.nbServices) : 0,
                              };
                            })}
                            margin={{ top: 0, right: 10, bottom: 0, left: 0 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                            <XAxis dataKey="name" tick={{ fontSize: 12, fontWeight: 600 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" axisLine={false} tickLine={false} tickFormatter={v => `${v}€`} />
                            <Tooltip
                              formatter={(v: any, name: any) => [formatCurrency(Number(v) || 0), name === 'Midi' ? '🌤 Midi' : '🌙 Soir'] as any}
                              contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', fontSize: 13 }}
                            />
                            <Bar dataKey="Midi" name="Midi" fill="#3A9D9B" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="Soir" name="Soir" fill="#1A5D5B" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </ChartCard>
                </>
              );
            })()}

            {/* ── Résumé de bas de page ────────────────────────────────────── */}
            <div style={{
              background: 'linear-gradient(135deg, var(--teal-bg) 0%, rgba(42,125,123,0.04) 100%)',
              border: '1px solid var(--border-light)',
              borderRadius: 16, padding: '16px 20px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: 12,
            }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
                Données synchronisées en temps réel · Square POS + Relevés bancaires + Fiches recettes
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {[
                  { label: 'CA Période', value: formatCurrency(kpis.caTotal) },
                  { label: 'TVA à payer', value: formatCurrency(Math.max(0, kpis.tvaNette)) },
                  { label: 'Prime Cost', value: formatPercent(kpis.foodCost + kpis.ratioSalariale) },
                ].map(({ label, value }) => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--teal)' }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Modale : détail des charges ─────────────────────────────────────── */}
      {showChargesModal && (
        <Modal
          large
          title="Détail des Charges Fixes & Opérationnelles"
          onClose={() => setShowChargesModal(false)}
          footer={
            <button className="btn btn-secondary" onClick={() => setShowChargesModal(false)}>Fermer</button>
          }
        >
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Transactions bancaires et factures de fonctionnement comptabilisées comme charges
            fixes & opérationnelles sur la période sélectionnée.
          </p>

          {chargesDetails.length === 0 ? (
            <EmptyState text="Aucune charge sur cette période." />
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Libellé</th>
                    <th>Source</th>
                    <th>Catégorie</th>
                    <th style={{ textAlign: 'right' }}>Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {chargesDetails.map((item, idx) => {
                    const catNames: Record<string, string> = {
                      fixe_loyer: 'Loyer & Charges',
                      fixe_assurance: 'Assurances',
                      fixe_abonnement: 'Abonnements & honoraires',
                      investissement: 'Équipement & travaux',
                      impot_taxe: 'Impôts & Taxes',
                      materiel: 'Matériel',
                      autre: 'Autre charge',
                    };
                    return (
                      <tr key={item.id || idx}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(item.date)}</td>
                        <td style={{ fontWeight: 600 }}>{item.description}</td>
                        <td>
                          <span className="badge" style={{
                            background: item.type === 'Banque' ? 'rgba(42, 125, 123, 0.12)' : 'rgba(124, 58, 237, 0.12)',
                            color: item.type === 'Banque' ? 'var(--teal-dark)' : '#7C3AED',
                          }}>
                            {item.type}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {catNames[item.category] || item.category}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--red)' }}>
                          {formatCurrency(item.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
