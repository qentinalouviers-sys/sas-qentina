'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency, formatPercent, getDateRange, toISODate,
  FOOD_COST_TARGET, formatDate,
} from '@/lib/utils';
import { computeTva } from '@/lib/tva';
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart,
  Users, Package, Target, Percent, AlertTriangle,
  ChevronUp, ChevronDown, Activity, Zap, BarChart2,
  CreditCard, Clock, Star,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
  ReferenceLine, Cell,
} from 'recharts';
import type { PeriodFilter } from '@/lib/types';

// ─── Custom Tooltip ──────────────────────────────────────────────────────────
const CurrencyTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '10px 14px',
      boxShadow: 'var(--shadow-md)',
      fontSize: 13,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{p.name}</span>
          <strong>{formatCurrency(p.value)}</strong>
        </div>
      ))}
    </div>
  );
};

// ─── Mini Trend Spark ────────────────────────────────────────────────────────
const SparkLine = ({ data, color }: { data: number[]; color: string }) => {
  const pts = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={48}>
      <AreaChart data={pts} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone" dataKey="v"
          stroke={color} strokeWidth={2}
          fill={`url(#sg-${color.replace('#', '')})`}
          dot={false} isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ─── KPI Card Component ──────────────────────────────────────────────────────
interface KpiCardProps {
  label: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  accentColor: string;
  spark?: number[];
  trend?: number; // % change vs prev period
  badge?: { text: string; type: 'good' | 'bad' | 'neutral' };
  onClick?: () => void;
}

const KpiCard = ({ label, value, subValue, icon, accentColor, spark, trend, badge, onClick }: KpiCardProps) => {
  const trendUp = trend !== undefined && trend >= 0;
  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--border)',
      borderRadius: 16,
      padding: '18px 20px',
      boxShadow: 'var(--shadow-sm)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      transition: 'all 0.2s ease',
      position: 'relative',
      overflow: 'hidden',
      cursor: onClick ? 'pointer' : 'default',
    }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
      }}
      onClick={onClick}
    >
      {/* Accent bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accentColor, borderRadius: '16px 16px 0 0' }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            {label}
          </span>
          <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.15, marginTop: 4 }}>
            {value}
          </span>
          {subValue && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{subValue}</span>
          )}
        </div>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: `${accentColor}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: accentColor, flexShrink: 0,
        }}>
          {icon}
        </div>
      </div>

      {spark && spark.length > 1 && (
        <div style={{ marginTop: 4, marginLeft: -4, marginRight: -4 }}>
          <SparkLine data={spark} color={accentColor} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        {trend !== undefined ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600,
            color: trendUp ? 'var(--green)' : 'var(--red)' }}>
            {trendUp ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {Math.abs(trend).toFixed(1)}% vs période préc.
          </div>
        ) : <div />}
        {badge && (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 100,
            background: badge.type === 'good' ? 'var(--green-light)' : badge.type === 'bad' ? 'var(--red-light)' : 'var(--cream-dark)',
            color: badge.type === 'good' ? 'var(--green)' : badge.type === 'bad' ? 'var(--red)' : 'var(--text-secondary)',
          }}>
            {badge.text}
          </span>
        )}
      </div>
    </div>
  );
};

// ─── Section Header ──────────────────────────────────────────────────────────
const SectionHeader = ({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: React.ReactNode }) => (
  <div className="section-header">
    {icon && <div style={{ color: 'var(--teal)', display: 'flex', flexShrink: 0 }}>{icon}</div>}
    <div>
      <div className="section-header-title">{title}</div>
      {subtitle && <div className="section-header-sub">{subtitle}</div>}
    </div>
  </div>
);

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodFilter>('month');
  const [loading, setLoading] = useState(true);
  const [simLabor, setSimLabor] = useState<string>('');
  const [simFood, setSimFood] = useState<string>('');
  const [simLaborMode, setSimLaborMode] = useState<'percent' | 'euro'>('percent');
  const [simFoodMode, setSimFoodMode] = useState<'percent' | 'euro'>('percent');
  const [simStock, setSimStock] = useState<string>('');
  const [simStockMode, setSimStockMode] = useState<'percent' | 'euro'>('percent');
  const [simFixed, setSimFixed] = useState<string>('');
  const [simFixedMode, setSimFixedMode] = useState<'percent' | 'euro'>('percent');
  const [chargesDetails, setChargesDetails] = useState<any[]>([]);
  const [showChargesModal, setShowChargesModal] = useState(false);

  const handleSimLaborModeChange = (newMode: 'percent' | 'euro') => {
    if (simLabor !== '' && !isNaN(parseFloat(simLabor))) {
      const val = parseFloat(simLabor);
      if (newMode === 'euro') {
        const euroVal = (val * kpis.caTotal) / 100;
        setSimLabor(euroVal.toFixed(0));
      } else {
        const pctVal = kpis.caTotal > 0 ? (val / kpis.caTotal) * 100 : 0;
        setSimLabor(pctVal.toFixed(1));
      }
    }
    setSimLaborMode(newMode);
  };

  const handleSimFoodModeChange = (newMode: 'percent' | 'euro') => {
    if (simFood !== '' && !isNaN(parseFloat(simFood))) {
      const val = parseFloat(simFood);
      if (newMode === 'euro') {
        const euroVal = (val * kpis.caTotal) / 100;
        setSimFood(euroVal.toFixed(0));
      } else {
        const pctVal = kpis.caTotal > 0 ? (val / kpis.caTotal) * 100 : 0;
        setSimFood(pctVal.toFixed(1));
      }
    }
    setSimFoodMode(newMode);
  };

  const handleSimStockModeChange = (newMode: 'percent' | 'euro') => {
    if (simStock !== '' && !isNaN(parseFloat(simStock))) {
      const val = parseFloat(simStock);
      if (newMode === 'euro') {
        const euroVal = (val * kpis.caTotal) / 100;
        setSimStock(euroVal.toFixed(0));
      } else {
        const pctVal = kpis.caTotal > 0 ? (val / kpis.caTotal) * 100 : 0;
        setSimStock(pctVal.toFixed(1));
      }
    }
    setSimStockMode(newMode);
  };

  const handleSimFixedModeChange = (newMode: 'percent' | 'euro') => {
    if (simFixed !== '' && !isNaN(parseFloat(simFixed))) {
      const val = parseFloat(simFixed);
      if (newMode === 'euro') {
        const euroVal = (val * kpis.caTotal) / 100;
        setSimFixed(euroVal.toFixed(0));
      } else {
        const pctVal = kpis.caTotal > 0 ? (val / kpis.caTotal) * 100 : 0;
        setSimFixed(pctVal.toFixed(1));
      }
    }
    setSimFixedMode(newMode);
  };

  const [kpis, setKpis] = useState({
    caTotal: 0,
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

    // TVA
    tvaNette: 0,
    tvaCollectee: 0,
    tvaDeductible: 0,

    // Trends
    caEvolution: [] as { date: string; ca: number; commandes: number }[],
    caSparkData: [] as number[],
    topProduits: [] as { name: string; quantity: number; ca: number }[],
    achatsParCategorie: [] as { name: string; value: number }[],
    achatsParFournisseur: [] as { name: string; value: number }[],
    margeParRecette: [] as { name: string; marge: number; foodCost: number; sellingPrice: number; cost: number }[],
    serviceSplit: [] as { name: string; ca: number; pct: number }[],
    // Heatmap jour × service
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

    // A. Récupérer les IDs masqués depuis app_settings
    const { data: settingsData } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'masked_items');
    
    const loadedMaskedIds: string[] = settingsData && settingsData.length > 0 && settingsData[0].value 
      ? JSON.parse(settingsData[0].value) 
      : [];

    // ── 1. Square Orders ─────────────────────────────────────────────────────
    const { data: orders } = await supabase
      .from('square_orders')
      .select('id, net_amount, service, created_at, raw_data')
      .gte('service', startStr)
      .lte('service', endStr);

    const activeOrders = orders?.filter((o: any) => !loadedMaskedIds.includes(String(o.id))) || [];
    const caTotal = activeOrders.reduce((s: number, o: any) => s + (o.net_amount || 0), 0) || 0;
    const validOrders = activeOrders.filter((o: any) => (o.net_amount || 0) > 0);
    const nbCommandes = validOrders.length;
    const ticketMoyen = nbCommandes > 0 ? caTotal / nbCommandes : 0;

    // CA + orders by date
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

    // ── Heatmap Jour × Service (midi avant 15h, soir après 15h) ────────────
    const DAYS_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    type ServiceData = { totalCa: number; nbServices: number; nbCommandes: number };
    const caByDayService: Record<string, { midi: ServiceData; soir: ServiceData }> = {};
    for (const d of DAYS_FR) {
      caByDayService[d] = {
        midi: { totalCa: 0, nbServices: 0, nbCommandes: 0 },
        soir: { totalCa: 0, nbServices: 0, nbCommandes: 0 },
      };
    }

    const dateServiceSeen: Record<string, Set<string>> = {};

    activeOrders.forEach((o: any) => {
      const amt = o.net_amount || 0;
      if (amt <= 0) return;

      const raw = o.raw_data?.created_at || o.service;
      const dt = new Date(raw);
      const hourLocal = dt.getUTCHours() + 2; // Paris local CEST
      const service: 'midi' | 'soir' = hourLocal < 15 ? 'midi' : 'soir';
      const dayName = DAYS_FR[dt.getUTCDay()];

      const dateKey = o.service || raw.substring(0, 10);
      const dsKey = `${dateKey}-${service}`;

      caByDayService[dayName][service].totalCa += amt;
      caByDayService[dayName][service].nbCommandes += 1;

      if (!dateServiceSeen[dsKey]) {
        dateServiceSeen[dsKey] = new Set();
        caByDayService[dayName][service].nbServices += 1;
      }
    });

    // ── TVA — calcul identique à l'onglet TVA (masquage inclus) ─────────────
    const { collectedTva: tvaCollectee, deductibleTva: tvaDeductible, netTva: tvaNette } =
      await computeTva(supabase, startStr, endStr);

    // ── 2. Invoices & Lines ──────────────────────────────────────────────────
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, total_ht, total_ttc, supplier:suppliers(name)')
      .gte('date', startStr)
      .lte('date', endStr);

    const invoiceIds = invoices?.map((i: any) => i.id) || [];

    let purchasesAlim = 0;
    let purchasesBoisson = 0;
    let purchasesEmballage = 0;
    let purchasesMateriel = 0;
    let purchasesAutreInvoices = 0;

    let achatsParCategorie: { name: string; value: number }[] = [];
    let achatsParFournisseur: { name: string; value: number }[] = [];
    let activeInvoiceLines: any[] = [];

    if (invoiceIds.length > 0) {
      const { data: lines } = await supabase
        .from('invoice_lines')
        .select('id, total_ht, category, designation, invoice:invoices(date, supplier:suppliers(name))')
        .in('invoice_id', invoiceIds);

      const activeLines = lines?.filter((l: any) => !loadedMaskedIds.includes(String(l.id))) || [];
      activeInvoiceLines = activeLines;

      activeLines.forEach((l: any) => {
        const amt = l.total_ht || 0;
        if (l.category === 'alimentaire') purchasesAlim += amt;
        else if (l.category === 'boisson') purchasesBoisson += amt;
        else if (l.category === 'emballage') purchasesEmballage += amt;
        else if (l.category === 'materiel') purchasesMateriel += amt;
        else purchasesAutreInvoices += amt;
      });

      // Achats par catégorie pour graphique
      const catMap: Record<string, number> = {};
      activeLines.forEach((l: any) => {
        const cat = l.category || 'autre';
        catMap[cat] = (catMap[cat] || 0) + (l.total_ht || 0);
      });
      achatsParCategorie = Object.entries(catMap)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);

      // Achats par fournisseur pour graphique
      const supMap: Record<string, number> = {};
      invoices?.forEach((i: any) => {
        const name = (i.supplier as any)?.name || 'Inconnu';
        supMap[name] = (supMap[name] || 0) + (i.total_ht || 0);
      });
      achatsParFournisseur = Object.entries(supMap)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
    }

    // ── 3. Bank Fournisseurs Unreconciled ────────────────────────────────────
    const { data: bankSuppliers } = await supabase
      .from('bank_transactions')
      .select('id, amount')
      .eq('category', 'variable_fournisseur')
      .is('invoice_id', null)
      .gte('date', startStr)
      .lte('date', endStr);

    const activeBankSuppliers = bankSuppliers?.filter((t: any) => !loadedMaskedIds.includes(String(t.id))) || [];
    const bankSuppliersUnreconciled = activeBankSuppliers.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);

    const foodCostAmt = purchasesAlim + purchasesBoisson + purchasesEmballage + bankSuppliersUnreconciled;
    const foodCost = caTotal > 0 ? (foodCostAmt / caTotal) * 100 : 0;

    // ── 4. Labor ─────────────────────────────────────────────────────────────
    // Timecards
    const { data: timecards } = await supabase
      .from('labor_timecards')
      .select('id, hours_worked, hourly_rate')
      .gte('start_at', start.toISOString())
      .lte('start_at', end.toISOString());

    const activeTimecards = timecards?.filter((t: any) => !loadedMaskedIds.includes(String(t.id))) || [];
    const laborTimecards = activeTimecards.reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);

    // Bank Salaries
    const { data: bankSalaries } = await supabase
      .from('bank_transactions')
      .select('id, amount')
      .eq('category', 'variable_salaire')
      .gte('date', startStr)
      .lte('date', endStr);

    const activeBankSalaries = bankSalaries?.filter((t: any) => !loadedMaskedIds.includes(String(t.id))) || [];
    const laborBank = activeBankSalaries.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);

    const useBankLabor = laborBank > 0;
    const totalLabor = useBankLabor ? laborBank : laborTimecards;
    const ratioSalariale = caTotal > 0 ? (totalLabor / caTotal) * 100 : 0;

    // ── 5. Fixed Charges (Rent, Insurance, Utilities, Subscriptions, Taxes, etc.) ─
    const { data: fixedTx } = await supabase
      .from('bank_transactions')
      .select('id, amount, category, description, date')
      .in('category', ['fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'impot_taxe', 'autre'])
      .gte('date', startStr)
      .lte('date', endStr);

    const activeFixedTx = fixedTx?.filter((t: any) => !loadedMaskedIds.includes(String(t.id))) || [];
    let chargesLoyer = 0;
    let chargesAssurance = 0;
    let chargesAbonnement = 0;
    let chargesImpot = 0;
    let chargesAutreBank = 0;

    activeFixedTx.forEach((t: any) => {
      const amt = Math.abs(t.amount || 0);
      if (t.category === 'fixe_loyer') chargesLoyer += amt;
      else if (t.category === 'fixe_assurance') chargesAssurance += amt;
      else if (t.category === 'fixe_abonnement') chargesAbonnement += amt;
      else if (t.category === 'impot_taxe') chargesImpot += amt;
      else if (t.category === 'autre') chargesAutreBank += amt;
    });

    const totalFixedCharges = chargesLoyer + chargesAssurance + chargesAbonnement + chargesImpot + chargesAutreBank + purchasesMateriel + purchasesAutreInvoices;

    // Collect charges details for modal
    const tempDetails: any[] = [];
    activeFixedTx.forEach((t: any) => {
      tempDetails.push({
        id: t.id,
        date: t.date,
        description: t.description || 'Libellé bancaire inconnu',
        amount: -Math.abs(t.amount || 0),
        type: 'Banque',
        category: t.category,
      });
    });

    if (invoiceIds.length > 0) {
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
    }
    tempDetails.sort((a, b) => b.date.localeCompare(a.date));
    setChargesDetails(tempDetails);

    // ── 6. Stock ─────────────────────────────────────────────────────────────
    const { data: inventory } = await supabase
      .from('inventory_counts')
      .select('quantity, unit_price');
    const stockValorise = inventory?.reduce((s: number, i: any) => s + (i.quantity || 0) * (i.unit_price || 0), 0) || 0;

    // ── 7. Top Products ──────────────────────────────────────────────────────
    const { data: allOrderIds } = await supabase
      .from('square_orders')
      .select('id')
      .gte('service', startStr)
      .lte('service', endStr);
    const oIds = allOrderIds?.map((o: any) => o.id) || [];
    let topProduits: { name: string; quantity: number; ca: number }[] = [];
    if (oIds.length > 0) {
      const { data: items } = await supabase
        .from('square_items')
        .select('name, quantity, gross_sales_money')
        .in('order_id', oIds);
      const prodMap: Record<string, { qty: number; ca: number }> = {};
      items?.forEach((i: any) => {
        if (i.name) {
          if (!prodMap[i.name]) prodMap[i.name] = { qty: 0, ca: 0 };
          prodMap[i.name].qty += i.quantity || 0;
          prodMap[i.name].ca += (i.gross_sales_money || 0) / 100;
        }
      });
      topProduits = Object.entries(prodMap)
        .sort(([, a], [, b]) => b.qty - a.qty)
        .slice(0, 8)
        .map(([name, v]) => ({ name, quantity: v.qty, ca: v.ca }));
    }

    // ── 8. Margin on recipes ─────────────────────────────────────────────────
    interface RecipeIngredientRow { quantity: number | null; ingredient: { last_unit_price: number | null } | null; }
    interface RecipeRow { id: string; name: string; selling_price: number | null; portions: number; recipe_ingredients: RecipeIngredientRow[]; }
    const { data: recipes } = await supabase
      .from('recipes')
      .select('id, name, selling_price, portions, recipe_ingredients(quantity, ingredient:ingredients(last_unit_price))')
      .not('selling_price', 'is', null);
    const margeParRecette = ((recipes || []) as unknown as RecipeRow[]).map(r => {
      const totalCost = r.recipe_ingredients?.reduce((s, ri) => s + (ri.quantity || 0) * (ri.ingredient?.last_unit_price || 0), 0) || 0;
      const costPerPortion = r.portions > 0 ? totalCost / r.portions : totalCost;
      const sp = r.selling_price || 0;
      const marge = sp > 0 ? ((sp - costPerPortion) / sp) * 100 : 0;
      const fc = sp > 0 ? (costPerPortion / sp) * 100 : 0;
      return { name: r.name, marge, foodCost: fc, sellingPrice: sp, cost: costPerPortion };
    }).sort((a, b) => b.marge - a.marge);

    // ── 9. EBE (Excédent Brut d'Exploitation) ────────────────────────────────
    const margeNetteAmt = caTotal - foodCostAmt - totalLabor - totalFixedCharges;
    const margeNette = caTotal > 0 ? (margeNetteAmt / caTotal) * 100 : 0;

    setKpis({
      caTotal, nbCommandes, ticketMoyen,
      foodCost, foodCostAmt,
      ratioSalariale, totalLabor,
      totalFixedCharges,
      stockValorise, margeNette, margeNetteAmt,
      tvaNette, tvaCollectee, tvaDeductible,
      caEvolution, caSparkData,
      topProduits, achatsParCategorie, achatsParFournisseur,
      margeParRecette, serviceSplit: [], caByDayService,
    });
    setLoading(false);
  }, [period]);

  useEffect(() => { loadKPIs(); }, [loadKPIs]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'square_orders' }, () => loadKPIs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_lines' }, () => loadKPIs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_transactions' }, () => loadKPIs())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadKPIs]);

  // ─── Simulation calculations ───────────────────────────────────────────────
  const activeSimLabor = simLabor !== '' && !isNaN(parseFloat(simLabor)) ? parseFloat(simLabor) : null;
  const activeSimFood = simFood !== '' && !isNaN(parseFloat(simFood)) ? parseFloat(simFood) : null;
  const activeSimStock = simStock !== '' && !isNaN(parseFloat(simStock)) ? parseFloat(simStock) : null;
  const activeSimFixed = simFixed !== '' && !isNaN(parseFloat(simFixed)) ? parseFloat(simFixed) : null;
  const isSimulationActive = activeSimLabor !== null || activeSimFood !== null || activeSimStock !== null || activeSimFixed !== null;

  let displayLaborRatio = kpis.ratioSalariale;
  let displayLaborAmt = kpis.totalLabor;

  if (activeSimLabor !== null) {
    if (simLaborMode === 'percent') {
      displayLaborRatio = activeSimLabor;
      displayLaborAmt = (kpis.caTotal * activeSimLabor) / 100;
    } else {
      displayLaborAmt = activeSimLabor;
      displayLaborRatio = kpis.caTotal > 0 ? (activeSimLabor / kpis.caTotal) * 100 : 0;
    }
  }

  let displayFoodRatio = kpis.foodCost;
  let displayFoodAmt = kpis.foodCostAmt;

  if (activeSimFood !== null) {
    if (simFoodMode === 'percent') {
      displayFoodRatio = activeSimFood;
      displayFoodAmt = (kpis.caTotal * activeSimFood) / 100;
    } else {
      displayFoodAmt = activeSimFood;
      displayFoodRatio = kpis.caTotal > 0 ? (activeSimFood / kpis.caTotal) * 100 : 0;
    }
  }

  let displayStockRatio = kpis.caTotal > 0 ? (kpis.stockValorise / kpis.caTotal) * 100 : 0;
  let displayStockAmt = kpis.stockValorise;

  if (activeSimStock !== null) {
    if (simStockMode === 'percent') {
      displayStockRatio = activeSimStock;
      displayStockAmt = (kpis.caTotal * activeSimStock) / 100;
    } else {
      displayStockAmt = activeSimStock;
      displayStockRatio = kpis.caTotal > 0 ? (activeSimStock / kpis.caTotal) * 100 : 0;
    }
  }

  let displayFixedRatio = kpis.caTotal > 0 ? (kpis.totalFixedCharges / kpis.caTotal) * 100 : 0;
  let displayFixedAmt = kpis.totalFixedCharges;

  if (activeSimFixed !== null) {
    if (simFixedMode === 'percent') {
      displayFixedRatio = activeSimFixed;
      displayFixedAmt = (kpis.caTotal * activeSimFixed) / 100;
    } else {
      displayFixedAmt = activeSimFixed;
      displayFixedRatio = kpis.caTotal > 0 ? (activeSimFixed / kpis.caTotal) * 100 : 0;
    }
  }

  // Stock variation impact on Food Cost amount:
  // A higher simulated stock means less food consumed, so lower food cost amount.
  const stockChange = displayStockAmt - kpis.stockValorise;
  const adjustedFoodAmt = displayFoodAmt - stockChange;
  const adjustedFoodRatio = kpis.caTotal > 0 ? (adjustedFoodAmt / kpis.caTotal) * 100 : 0;

  const displayFoodRatioToUse = activeSimFood !== null || activeSimStock !== null ? adjustedFoodRatio : kpis.foodCost;
  const displayFoodAmtToUse = activeSimFood !== null || activeSimStock !== null ? adjustedFoodAmt : kpis.foodCostAmt;

  const displayPrimeCost = displayFoodRatioToUse + displayLaborRatio;

  const displayMargeNetteAmt = kpis.caTotal - (adjustedFoodAmt + displayLaborAmt + displayFixedAmt);
  const displayMargeNetteRatio = kpis.caTotal > 0 ? (displayMargeNetteAmt / kpis.caTotal) * 100 : 0;

  const fcBad = displayFoodRatioToUse > FOOD_COST_TARGET;
  const tvaBad = kpis.tvaNette > 0;

  // Chart gradient colors
  const CAT_COLORS = ['#2A7D7B', '#E89B3E', '#7C3AED', '#2D8F5E', '#D94F4F', '#1A5AA0'];

  return (
    <>
      {/* ── Page Header ─────────────────────────────────────────────────────── */}
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
        <div className="period-selector">
          {(['today', 'week', 'month', 'year'] as PeriodFilter[]).map(p => (
            <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
              {p === 'today' ? "Aujourd'hui" : p === 'week' ? 'Semaine' : p === 'month' ? 'Mois' : 'Année'}
            </button>
          ))}
        </div>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="loading-page">
            <div className="spinner" style={{ width: 36, height: 36 }} />
            <p>Chargement du tableau de bord...</p>
          </div>
        ) : (
          <>
            {/* ── Alertes critiques ────────────────────────────────────────── */}
            {(fcBad || tvaBad) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {fcBad && (
                  <div className="alert alert-danger" style={{ gap: 10 }}>
                    <AlertTriangle size={16} />
                    Food cost à <strong>{formatPercent(kpis.foodCost)}</strong> — dépasse l'objectif de {FOOD_COST_TARGET}%.
                    {kpis.caTotal > 0 && ` Soit ${formatCurrency(kpis.foodCostAmt)} sur ${formatCurrency(kpis.caTotal)} de CA.`}
                  </div>
                )}
                {tvaBad && (
                  <div className="alert alert-warning" style={{ gap: 10 }}>
                    <Percent size={16} />
                    TVA nette à payer estimée : <strong>{formatCurrency(kpis.tvaNette)}</strong> —
                    pensez à provisionner avant votre déclaration.
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════════════════════════════
                SECTION 1 — KPIs ACTIVITÉ
            ══════════════════════════════════════════════════════════════ */}
            <SectionHeader title="Performance commerciale" subtitle="Ventes & activité" icon={<TrendingUp size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label="Chiffre d'affaires"
                value={formatCurrency(kpis.caTotal)}
                subValue={`${kpis.nbCommandes} commandes`}
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

            {/* ══════════════════════════════════════════════════════════════
                SECTION 2 — KPIs COÛTS
            ══════════════════════════════════════════════════════════════ */}
            <SectionHeader title="Contrôle des coûts" subtitle="Food cost, masse salariale & stocks" icon={<Target size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label="Food Cost"
                value={formatPercent(displayFoodRatioToUse)}
                subValue={`${formatCurrency(displayFoodAmtToUse)} matières / ${formatCurrency(kpis.caTotal)} CA`}
                icon={<Target size={20} />}
                accentColor={fcBad ? '#D94F4F' : '#2D8F5E'}
                badge={{
                  text: (activeSimFood !== null || activeSimStock !== null) ? '🧪 Simulé' : fcBad ? `⚠ +${(displayFoodRatioToUse - FOOD_COST_TARGET).toFixed(1)}% cible` : `✓ Cible 28-32%`,
                  type: (activeSimFood !== null || activeSimStock !== null) ? 'neutral' : fcBad ? 'bad' : 'good',
                }}
              />
              <KpiCard
                label="Masse salariale"
                value={formatPercent(displayLaborRatio)}
                subValue={`${formatCurrency(displayLaborAmt)} en coût total`}
                icon={<Users size={20} />}
                accentColor={displayLaborRatio > 35 ? '#D94F4F' : '#E89B3E'}
                badge={{
                  text: activeSimLabor !== null ? '🧪 Simulé' : displayLaborRatio > 35 ? '⚠ Élevée' : displayLaborRatio > 0 ? 'Normal' : 'Pas de données',
                  type: activeSimLabor !== null ? 'neutral' : displayLaborRatio > 35 ? 'bad' : 'neutral',
                }}
              />
              <KpiCard
                label="Stock valorisé"
                value={formatCurrency(displayStockAmt)}
                subValue={activeSimStock !== null ? "🧪 Valeur de stock simulée" : "Valeur du stock actuel"}
                icon={<Package size={20} />}
                accentColor="#1A5AA0"
                badge={activeSimStock !== null ? { text: '🧪 Simulé', type: 'neutral' } : undefined}
              />
              <KpiCard
                label="Charges Fixes & Ops"
                value={formatCurrency(displayFixedAmt)}
                subValue={kpis.caTotal > 0 ? `${displayFixedRatio.toFixed(1)}% du CA` : "0% du CA"}
                icon={<CreditCard size={20} />}
                accentColor="#7C3AED"
                badge={activeSimFixed !== null ? { text: '🧪 Simulé', type: 'neutral' } : undefined}
                onClick={() => setShowChargesModal(true)}
              />
              <KpiCard
                label="Prime Cost"
                value={formatPercent(displayPrimeCost)}
                subValue={`Food cost + Masse salariale`}
                icon={<Zap size={20} />}
                accentColor={displayPrimeCost > 65 ? '#D94F4F' : '#2D8F5E'}
                badge={{
                  text: isSimulationActive ? '🧪 Simulé' : displayPrimeCost > 65 ? '⚠ > 65%' : '✓ < 65%',
                  type: isSimulationActive ? 'neutral' : displayPrimeCost > 65 ? 'bad' : 'good',
                }}
              />
            </div>

            {/* ─── Simulation Widget ─── */}
            <div className="card" style={{
              marginBottom: 24,
              border: isSimulationActive ? '1.5px solid var(--orange)' : '1px solid var(--border)',
              background: 'linear-gradient(135deg, white 0%, var(--cream-light) 100%)',
              padding: 20,
              boxShadow: isSimulationActive ? 'var(--shadow-md)' : 'var(--shadow-sm)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Zap size={20} style={{ color: isSimulationActive ? 'var(--orange)' : 'var(--teal)' }} />
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Simulateur de Marge Opérationnelle (EBE)</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Ajustez les charges et les stocks pour voir l'impact en temps réel sur vos marges</p>
                </div>
                {isSimulationActive && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--red)', minHeight: '32px' }}
                    onClick={() => {
                      setSimLabor('');
                      setSimFood('');
                      setSimStock('');
                      setSimFixed('');
                      setSimLaborMode('percent');
                      setSimFoodMode('percent');
                      setSimStockMode('percent');
                      setSimFixedMode('percent');
                    }}
                  >
                    Réinitialiser
                  </button>
                )}
              </div>

              <div className="grid-2-1" style={{ gap: 20 }}>
                {/* Inputs */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Masse Salariale */}
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        Masse Salariale
                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
                          (Réel: {simLaborMode === 'percent' ? `${kpis.ratioSalariale.toFixed(1)}%` : formatCurrency(kpis.totalLabor)})
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 4, background: 'var(--border-light)', padding: 2, borderRadius: 6 }}>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simLaborMode === 'percent' ? 'white' : 'transparent',
                            color: simLaborMode === 'percent' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simLaborMode === 'percent' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimLaborModeChange('percent')}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simLaborMode === 'euro' ? 'white' : 'transparent',
                            color: simLaborMode === 'euro' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simLaborMode === 'euro' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimLaborModeChange('euro')}
                        >
                          €
                        </button>
                      </div>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        step={simLaborMode === 'percent' ? '0.1' : '100'}
                        min="0"
                        max={simLaborMode === 'percent' ? '100' : undefined}
                        className="form-input"
                        placeholder={simLaborMode === 'percent' ? kpis.ratioSalariale.toFixed(1) : kpis.totalLabor.toFixed(0)}
                        value={simLabor}
                        onChange={e => setSimLabor(e.target.value)}
                        style={{ paddingRight: 32, width: '100%' }}
                      />
                      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600 }}>
                        {simLaborMode === 'percent' ? '%' : '€'}
                      </span>
                    </div>
                  </div>

                  {/* Charges Variables (Food Cost) */}
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        Charges Variables (Food Cost)
                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
                          (Réel: {simFoodMode === 'percent' ? `${kpis.foodCost.toFixed(1)}%` : formatCurrency(kpis.foodCostAmt)})
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 4, background: 'var(--border-light)', padding: 2, borderRadius: 6 }}>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simFoodMode === 'percent' ? 'white' : 'transparent',
                            color: simFoodMode === 'percent' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simFoodMode === 'percent' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimFoodModeChange('percent')}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simFoodMode === 'euro' ? 'white' : 'transparent',
                            color: simFoodMode === 'euro' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simFoodMode === 'euro' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimFoodModeChange('euro')}
                        >
                          €
                        </button>
                      </div>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        step={simFoodMode === 'percent' ? '0.1' : '100'}
                        min="0"
                        max={simFoodMode === 'percent' ? '100' : undefined}
                        className="form-input"
                        placeholder={simFoodMode === 'percent' ? kpis.foodCost.toFixed(1) : kpis.foodCostAmt.toFixed(0)}
                        value={simFood}
                        onChange={e => setSimFood(e.target.value)}
                        style={{ paddingRight: 32, width: '100%' }}
                      />
                      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600 }}>
                        {simFoodMode === 'percent' ? '%' : '€'}
                      </span>
                    </div>
                  </div>

                  {/* Charges Fixes */}
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        Charges Fixes
                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
                          (Réel: {simFixedMode === 'percent' ? `${(kpis.caTotal > 0 ? (kpis.totalFixedCharges / kpis.caTotal) * 100 : 0).toFixed(1)}%` : formatCurrency(kpis.totalFixedCharges)})
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 4, background: 'var(--border-light)', padding: 2, borderRadius: 6 }}>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simFixedMode === 'percent' ? 'white' : 'transparent',
                            color: simFixedMode === 'percent' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simFixedMode === 'percent' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimFixedModeChange('percent')}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simFixedMode === 'euro' ? 'white' : 'transparent',
                            color: simFixedMode === 'euro' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simFixedMode === 'euro' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimFixedModeChange('euro')}
                        >
                          €
                        </button>
                      </div>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        step={simFixedMode === 'percent' ? '0.1' : '100'}
                        min="0"
                        max={simFixedMode === 'percent' ? '100' : undefined}
                        className="form-input"
                        placeholder={simFixedMode === 'percent' ? (kpis.caTotal > 0 ? (kpis.totalFixedCharges / kpis.caTotal) * 100 : 0).toFixed(1) : kpis.totalFixedCharges.toFixed(0)}
                        value={simFixed}
                        onChange={e => setSimFixed(e.target.value)}
                        style={{ paddingRight: 32, width: '100%' }}
                      />
                      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600 }}>
                        {simFixedMode === 'percent' ? '%' : '€'}
                      </span>
                    </div>
                  </div>

                  {/* Stock Valorisé */}
                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        Stock Valorisé
                        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
                          (Réel: {simStockMode === 'percent' ? `${(kpis.caTotal > 0 ? (kpis.stockValorise / kpis.caTotal) * 100 : 0).toFixed(1)}%` : formatCurrency(kpis.stockValorise)})
                        </span>
                      </span>
                      <div style={{ display: 'flex', gap: 4, background: 'var(--border-light)', padding: 2, borderRadius: 6 }}>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simStockMode === 'percent' ? 'white' : 'transparent',
                            color: simStockMode === 'percent' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simStockMode === 'percent' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimStockModeChange('percent')}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: 600,
                            background: simStockMode === 'euro' ? 'white' : 'transparent',
                            color: simStockMode === 'euro' ? 'var(--teal)' : 'var(--text-secondary)',
                            boxShadow: simStockMode === 'euro' ? 'var(--shadow-sm)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => handleSimStockModeChange('euro')}
                        >
                          €
                        </button>
                      </div>
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        step={simStockMode === 'percent' ? '0.1' : '100'}
                        min="0"
                        max={simStockMode === 'percent' ? '100' : undefined}
                        className="form-input"
                        placeholder={simStockMode === 'percent' ? (kpis.caTotal > 0 ? (kpis.stockValorise / kpis.caTotal) * 100 : 0).toFixed(1) : kpis.stockValorise.toFixed(0)}
                        value={simStock}
                        onChange={e => setSimStock(e.target.value)}
                        style={{ paddingRight: 32, width: '100%' }}
                      />
                      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600 }}>
                        {simStockMode === 'percent' ? '%' : '€'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Visual Dashboard for Sim Results */}
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
                  {/* Traffic Light Status Badge */}
                  {(() => {
                    const ebeStatus = displayMargeNetteRatio >= 20 
                      ? { label: 'EBE Excellent (Cible atteinte)', color: '#2D8F5E', bg: '#EDF7ED', dot: '#2D8F5E' }
                      : displayMargeNetteRatio >= 10
                        ? { label: 'EBE Correct (À surveiller)', color: '#E89B3E', bg: '#FFF8E1', dot: '#E89B3E' }
                        : { label: 'EBE Critique (Alerte rouge)', color: '#D94F4F', bg: '#FDECEF', dot: '#D94F4F' };

                    const progressPercent = Math.min(Math.max((displayMargeNetteRatio / 30) * 100, 0), 100);

                    return (
                      <>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: ebeStatus.bg,
                          color: ebeStatus.color,
                          padding: '10px 14px',
                          borderRadius: 12,
                          fontWeight: 750,
                          fontSize: 13.5,
                          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.02)',
                        }}>
                          <span>Statut Résultat :</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: ebeStatus.dot,
                              boxShadow: `0 0 8px ${ebeStatus.dot}`,
                              display: 'inline-block',
                            }} />
                            {ebeStatus.label}
                          </span>
                        </div>

                        {/* Colored Progress Bar */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                            <span>Taux de Marge Opérationnelle (EBE)</span>
                            <strong>{displayMargeNetteRatio.toFixed(1)}% / 30%</strong>
                          </div>
                          <div style={{ height: 10, background: 'var(--border-light)', borderRadius: 10, overflow: 'hidden', position: 'relative' }}>
                            <div style={{
                              height: '100%',
                              width: `${progressPercent}%`,
                              background: ebeStatus.dot,
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

                  {/* Summary of simulated figures */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, borderTop: '1px solid var(--border-light)', paddingTop: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Chiffre d'affaires :</span>
                      <strong style={{ color: 'var(--text-primary)' }}>{formatCurrency(kpis.caTotal)}</strong>
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

                    {/* Différence Box */}
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
                        if (diff > 0) {
                          return (
                            <span style={{ color: '#2D8F5E', fontWeight: 800 }}>
                              📈 Gain potentiel : <strong>+{formatCurrency(diff)} HT</strong> de bénéfices en plus !
                            </span>
                          );
                        } else {
                          return (
                            <span style={{ color: '#D94F4F', fontWeight: 800 }}>
                              📉 Écart de marge : <strong>-{formatCurrency(Math.abs(diff))} HT</strong> par rapport au réel.
                            </span>
                          );
                        }
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 3 — KPIs TVA
            ══════════════════════════════════════════════════════════════ */}
            <SectionHeader title="Tableau de bord TVA" subtitle="Balance fiscale estimée sur la période" icon={<Percent size={18} />} />
            <div className="kpi-grid-auto">
              <KpiCard
                label={kpis.tvaNette >= 0 ? 'TVA Nette à payer' : 'Crédit de TVA'}
                value={formatCurrency(Math.abs(kpis.tvaNette))}
                subValue={kpis.tvaNette >= 0 ? 'À reverser à l\'administration' : 'Créance récupérable'}
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
                subValue={`${kpis.caTotal > 0 ? ((kpis.tvaCollectee / kpis.caTotal) * 100).toFixed(1) : '0'}% du CA`}
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
                border: 'none', borderRadius: 16, padding: '18px 20px',
                color: 'white', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: '0 4px 20px rgba(42,125,123,0.3)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', opacity: 0.75 }}>
                  Balance TVA
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, margin: '8px 0' }}>
                  {formatCurrency(kpis.tvaCollectee)} − {formatCurrency(kpis.tvaDeductible)}
                </div>
                <div style={{ fontSize: 13, opacity: 0.85, fontWeight: 500 }}>
                  = <strong>{formatCurrency(Math.abs(kpis.tvaNette))}</strong>{' '}
                  {kpis.tvaNette >= 0 ? 'à reverser' : 'de crédit TVA'}
                </div>
                <div style={{ marginTop: 12, fontSize: 11, opacity: 0.65 }}>
                  Détail complet dans l'onglet TVA →
                </div>
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════
                SECTION 4 — GRAPHIQUES TENDANCES
            ══════════════════════════════════════════════════════════════ */}
            <SectionHeader title="Tendances & Évolution" subtitle="Visualisation de votre activité dans le temps" icon={<TrendingUp size={18} />} />

            {/* Row 1: CA Evolution full-width */}
            <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Évolution du Chiffre d'Affaires</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>CA journalier sur la période sélectionnée</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--teal)' }}>{formatCurrency(kpis.caTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total période</div>
                </div>
              </div>
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
            </div>

            {/* Row 2: Top produits + Achats par catégorie */}
            <div className="grid-2" style={{ marginBottom: 14 }}>
              {/* Top produits */}
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Top Produits</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Par quantité vendue</div>
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
                  <div className="empty-state"><p>Aucune donnée produit</p></div>
                )}
              </div>

              {/* Achats par catégorie */}
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Achats par Catégorie</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Répartition des dépenses HT</div>
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
                    {/* Legend */}
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
                  <div className="empty-state"><p>Aucune facture sur cette période</p></div>
                )}
              </div>
            </div>

            {/* Row 3: Achats par fournisseur */}
            {kpis.achatsParFournisseur.length > 0 && (
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Achats par Fournisseur</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Volume d'achats HT – Top 6</div>
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
              </div>
            )}

            {/* ══════════════════════════════════════════════════════════════
                SECTION 5 — MARGE PAR RECETTE
            ══════════════════════════════════════════════════════════════ */}
            {kpis.margeParRecette.length > 0 && (
              <>
                <SectionHeader title="Rentabilité par Recette" subtitle="Food cost et marge par plat" icon={<Star size={18} />} />
                <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 24, boxShadow: 'var(--shadow-sm)' }}>
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
                                <span style={{
                                  display: 'inline-block', padding: '2px 8px',
                                  borderRadius: 100, fontSize: 11.5, fontWeight: 700,
                                  background: fcBadRecipe ? 'var(--red-light)' : 'var(--green-light)',
                                  color: fcBadRecipe ? 'var(--red)' : 'var(--green)',
                                }}>
                                  {formatPercent(r.foodCost)}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: margeGood ? 'var(--green)' : r.marge < 60 ? 'var(--red)' : 'var(--text-primary)' }}>
                                {formatPercent(r.marge)}
                              </td>
                              <td>
                                <span style={{
                                  display: 'inline-block', padding: '2px 8px',
                                  borderRadius: 100, fontSize: 11, fontWeight: 600,
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
                </div>
              </>
            )}

            {/* ══════════════════════════════════════════════════════════════
                SECTION — HEATMAP JOURS × SERVICES
            ══════════════════════════════════════════════════════════════ */}
            {(() => {
              const ORDERED_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
              const hasDayData = ORDERED_DAYS.some(d => {
                const ds = kpis.caByDayService[d];
                return ds && (ds.midi.nbServices > 0 || ds.soir.nbServices > 0);
              });

              if (!hasDayData) return null;

              // Max CA moyen pour la scale de couleur
              let maxAvg = 0;
              ORDERED_DAYS.forEach(d => {
                const ds = kpis.caByDayService[d];
                if (!ds) return;
                const mMidi = ds.midi.nbServices > 0 ? ds.midi.totalCa / ds.midi.nbServices : 0;
                const mSoir = ds.soir.nbServices > 0 ? ds.soir.totalCa / ds.soir.nbServices : 0;
                if (mMidi > maxAvg) maxAvg = mMidi;
                if (mSoir > maxAvg) maxAvg = mSoir;
              });

              // Convertit une intensité [0,1] en couleur teal avec opacité
              const heatColor = (intensity: number) => {
                if (intensity === 0) return 'var(--cream-light)';
                const alpha = 0.12 + intensity * 0.7;
                return `rgba(42, 125, 123, ${alpha.toFixed(2)})`;
              };
              const textColor = (intensity: number) =>
                intensity > 0.55 ? 'white' : intensity > 0.15 ? 'var(--teal-dark)' : 'var(--text-muted)';

              return (
                <>
                  <SectionHeader
                    title="Tendances CA par Jour & Service"
                    subtitle="Moyenne de chiffre d'affaires par service — midi (avant 15h) vs soir (après 15h)"
                    icon={<BarChart2 size={18} />}
                  />
                  <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>

                    {/* Légende */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                        <div style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(42,125,123,0.15)' }} />
                        <span>Faible CA</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                        <div style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(42,125,123,0.55)' }} />
                        <span>CA moyen</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                        <div style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(42,125,123,0.82)' }} />
                        <span>Fort CA</span>
                      </div>
                      <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                        Basé sur {Object.values(kpis.caByDayService).reduce((s, d) => s + d.midi.nbServices + d.soir.nbServices, 0)} services sur la période
                      </div>
                    </div>

                    {/* Grid heatmap — scrollable horizontally on mobile */}
                    <div className="scroll-x">
                    <div className="heatmap-grid">
                      {/* Header jours */}
                      <div />
                      {ORDERED_DAYS.map(d => (
                        <div key={d} className="heatmap-day-header">
                          {d.substring(0, 3).toUpperCase()}
                        </div>
                      ))}

                      {/* Ligne MIDI */}
                      <div className="heatmap-label">🌤 Midi</div>
                      {ORDERED_DAYS.map(d => {
                        const ds = kpis.caByDayService[d];
                        const avg = ds && ds.midi.nbServices > 0 ? ds.midi.totalCa / ds.midi.nbServices : 0;
                        const intensity = maxAvg > 0 ? avg / maxAvg : 0;
                        return (
                          <div
                            key={d}
                            className="heatmap-cell"
                            style={{ background: heatColor(intensity) }}
                            title={ds ? `${d} Midi — ${ds.midi.nbServices} service(s), ${ds.midi.nbCommandes} commandes` : ''}
                          >
                            {avg > 0 ? (
                              <>
                                <div style={{ fontSize: 13, fontWeight: 800, color: textColor(intensity), lineHeight: 1 }}>
                                  {formatCurrency(avg, 0)}
                                </div>
                                <div style={{ fontSize: 10, color: textColor(intensity), opacity: 0.8, marginTop: 3 }}>
                                  {ds?.midi.nbServices ?? 0}×
                                </div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.5 }}>—</div>
                            )}
                          </div>
                        );
                      })}

                      {/* Ligne SOIR */}
                      <div className="heatmap-label">🌙 Soir</div>
                      {ORDERED_DAYS.map(d => {
                        const ds = kpis.caByDayService[d];
                        const avg = ds && ds.soir.nbServices > 0 ? ds.soir.totalCa / ds.soir.nbServices : 0;
                        const intensity = maxAvg > 0 ? avg / maxAvg : 0;
                        return (
                          <div
                            key={d}
                            className="heatmap-cell"
                            style={{ background: heatColor(intensity) }}
                            title={ds ? `${d} Soir — ${ds.soir.nbServices} service(s), ${ds.soir.nbCommandes} commandes` : ''}
                          >
                            {avg > 0 ? (
                              <>
                                <div style={{ fontSize: 13, fontWeight: 800, color: textColor(intensity), lineHeight: 1 }}>
                                  {formatCurrency(avg, 0)}
                                </div>
                                <div style={{ fontSize: 10, color: textColor(intensity), opacity: 0.8, marginTop: 3 }}>
                                  {ds?.soir.nbServices ?? 0}×
                                </div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.5 }}>—</div>
                            )}
                          </div>
                        );
                      })}

                      {/* Ligne TOTAL JOUR */}
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
                    </div>{/* end scroll-x */}

                    {/* Barchart horizontal pour comparaison rapide */}
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
                  </div>
                </>
              );
            })()}

            {/* ── Footer summary ───────────────────────────────────────────── */}
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
              <div style={{ display: 'flex', gap: 20 }}>
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

      {/* ── Details Charges Modal ── */}
      {showChargesModal && (
        <div className="modal-overlay" onClick={() => setShowChargesModal(false)}>
          <div className="modal-content modal-lg" onClick={e => e.stopPropagation()} style={{
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontWeight: 800 }}>Détail des Charges Fixes & Opérationnelles</h3>
              <button className="btn-close" onClick={() => setShowChargesModal(false)} style={{ border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer' }}>&times;</button>
            </div>
            
            <div style={{ padding: '0 24px 20px', overflowY: 'auto', flex: 1 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Voici la liste des transactions bancaires et factures de fonctionnement comptabilisées comme charges fixes & opérationnelles sur la période (<strong>{period === 'today' ? "Aujourd'hui" : period === 'week' ? 'Cette semaine' : period === 'month' ? 'Ce mois' : 'Cette année'}</strong>).
              </p>

              {chargesDetails.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                  Aucune charge sur cette période.
                </div>
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
                          fixe_abonnement: 'Abonnements',
                          impot_taxe: 'Impôts & Taxes',
                          materiel: 'Matériel',
                          autre: 'Autre charge bank',
                        };
                        
                        return (
                          <tr key={item.id || idx}>
                            <td style={{ whiteSpace: 'nowrap' }}>{formatDate(item.date)}</td>
                            <td style={{ fontWeight: 600 }}>{item.description}</td>
                            <td>
                              <span style={{
                                fontSize: 11,
                                padding: '2px 8px',
                                borderRadius: 100,
                                background: item.type === 'Banque' ? 'rgba(42, 125, 123, 0.12)' : 'rgba(124, 58, 237, 0.12)',
                                color: item.type === 'Banque' ? 'var(--teal-dark)' : 'var(--purple-dark)',
                                fontWeight: 600,
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
            </div>
            
            <div className="modal-footer" style={{ borderTop: '1px solid var(--border-light)', padding: 16, display: 'flex', justifyContent: 'flex-end', background: 'var(--cream-light)' }}>
              <button className="btn btn-secondary" onClick={() => setShowChargesModal(false)}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
