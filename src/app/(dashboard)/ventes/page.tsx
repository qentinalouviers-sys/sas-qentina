'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate, downloadCSV, toISODate, getParisHour } from '@/lib/utils';
import { 
  ShoppingCart, 
  RefreshCw, 
  Download, 
  TrendingUp, 
  Flame, 
  Calendar, 
  ChevronDown, 
  ChevronUp 
} from 'lucide-react';
import type { SquareOrder, SquareItem } from '@/lib/types';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  Legend, 
  LineChart, 
  Line, 
  CartesianGrid 
} from 'recharts';
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  subDays,
  subWeeks,
  subMonths,
  parseISO,
  differenceInDays,
  addDays
} from 'date-fns';

// ─── Bornes de périodes (pilotage + comparaison LFL) ─────────────────────────
// Fonction pure, utilisée par loadData ET par le rendu : une seule source de
// vérité pour l'arithmétique de périodes.
function computePeriods(period: 'day' | 'week' | 'month', anchorDate: string) {
  const parsedAnchor = anchorDate ? parseISO(anchorDate) : new Date();

  let currentStart: Date;
  let currentEnd: Date;       // borne LFL : jusqu'à la date pivot
  let currentPeriodEnd: Date; // fin de période complète (graphiques)
  let prevStart: Date;
  let prevEnd: Date;          // borne LFL de la période précédente
  let prevPeriodEnd: Date;    // fin de période précédente complète

  if (period === 'day') {
    currentStart = startOfDay(parsedAnchor);
    currentEnd = endOfDay(parsedAnchor);
    currentPeriodEnd = currentEnd;
    prevStart = startOfDay(subDays(parsedAnchor, 1));
    prevEnd = endOfDay(subDays(parsedAnchor, 1));
    prevPeriodEnd = prevEnd;
  } else if (period === 'week') {
    currentStart = startOfWeek(parsedAnchor, { weekStartsOn: 1 });
    currentEnd = parsedAnchor; // up to anchorDate for LFL comparison
    currentPeriodEnd = endOfWeek(parsedAnchor, { weekStartsOn: 1 });

    prevStart = startOfWeek(subWeeks(parsedAnchor, 1), { weekStartsOn: 1 });
    prevPeriodEnd = endOfWeek(subWeeks(parsedAnchor, 1), { weekStartsOn: 1 });

    // Calculate like-for-like elapsed days in week
    const daysElapsed = differenceInDays(parsedAnchor, currentStart);
    prevEnd = addDays(prevStart, daysElapsed);
  } else { // month
    currentStart = startOfMonth(parsedAnchor);
    currentEnd = parsedAnchor; // up to anchorDate for LFL comparison
    currentPeriodEnd = endOfMonth(parsedAnchor);

    prevStart = startOfMonth(subMonths(parsedAnchor, 1));
    prevPeriodEnd = endOfMonth(subMonths(parsedAnchor, 1));

    // Calculate like-for-like elapsed days in month, clampé sur la fin du mois
    // précédent (ex. pivot au 30/03 : février n'a pas 30 jours)
    const daysElapsed = parsedAnchor.getDate() - 1;
    const rawPrevEnd = addDays(prevStart, daysElapsed);
    prevEnd = rawPrevEnd > prevPeriodEnd ? prevPeriodEnd : rawPrevEnd;
  }

  return {
    currentStartISO: toISODate(currentStart),
    currentEndISO: toISODate(currentEnd),
    currentPeriodEndISO: toISODate(currentPeriodEnd),
    prevStartISO: toISODate(prevStart),
    prevEndISO: toISODate(prevEnd),
    prevPeriodEndISO: toISODate(prevPeriodEnd),
  };
}

export default function VentesPage() {
  const [orders, setOrders] = useState<SquareOrder[]>([]);
  const [prevOrders, setPrevOrders] = useState<SquareOrder[]>([]);
  const [items, setItems] = useState<SquareItem[]>([]);
  const [topItems, setTopItems] = useState<{ name: string; qty: number; ca: number }[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [fuegoInsight, setFuegoInsight] = useState<string | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);
  
  // Pilotage filter states
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week');
  const [anchorDate, setAnchorDate] = useState<string>(() => toISODate(new Date()));
  const [isTableExpanded, setIsTableExpanded] = useState(false);

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);
    const { currentStartISO, currentPeriodEndISO, prevStartISO, prevPeriodEndISO } =
      computePeriods(period, anchorDate);

    // Fetch orders covering both full periods (for complete charts)
    const { data: rawOrders, error } = await supabase
      .from('square_orders')
      .select('*')
      .gte('service', prevStartISO)
      .lte('service', currentPeriodEndISO)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching orders:', error);
      setLoading(false);
      return;
    }

    const allOrders = rawOrders || [];
    
    // orders for current period (up to currentPeriodEndISO to show the whole month in charts)
    const activeOrders = allOrders.filter(
      (o: any) => o.service >= currentStartISO && o.service <= currentPeriodEndISO
    );
    // orders for previous period (up to prevPeriodEndISO to show the whole month in charts)
    const comparisonOrders = allOrders.filter(
      (o: any) => o.service >= prevStartISO && o.service <= prevPeriodEndISO
    );

    setOrders(activeOrders);
    setPrevOrders(comparisonOrders);

    // Calculate Top Products for active period
    if (activeOrders.length > 0) {
      const orderIds = activeOrders.map((o: any) => o.id);
      const { data: itemsData } = await supabase
        .from('square_items')
        .select('*')
        .in('order_id', orderIds);
        
      if (itemsData) {
        const itemMap: Record<string, { name: string; qty: number; ca: number }> = {};
        itemsData.forEach((item: any) => {
          if (!itemMap[item.name]) {
            itemMap[item.name] = { name: item.name, qty: 0, ca: 0 };
          }
          itemMap[item.name].qty += item.quantity || 1;
          itemMap[item.name].ca += item.total_price || 0;
        });
        setTopItems(
          Object.values(itemMap)
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 8)
        );
      } else {
        setTopItems([]);
      }
    } else {
      setTopItems([]);
    }

    setLoading(false);
  }, [supabase, period, anchorDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Garde l'id de la dernière commande demandée pour ignorer les réponses obsolètes
  const itemsRequestRef = useRef<string | null>(null);

  const loadItems = async (orderId: string) => {
    setSelectedOrder(orderId);
    itemsRequestRef.current = orderId;
    const { data } = await supabase.from('square_items').select('*').eq('order_id', orderId);
    if (itemsRequestRef.current !== orderId) return; // réponse obsolète : une autre commande a été demandée depuis
    setItems(data || []);
  };

  /**
   * Synchronise Square jusqu'au bout.
   *
   * La route s'arrête avant d'être coupée par la plateforme et renvoie son
   * curseur : sans cette reprise, une partie des commandes resterait dehors et
   * le chiffre d'affaires serait minoré en annonçant un succès. La caisse étant
   * la référence comptable, c'est l'exhaustivité qui compte, pas la rapidité.
   */
  const handleSync = async () => {
    setSyncing(true);
    try {
      let cursor: string | undefined;
      let orders = 0;
      let items = 0;
      let zero = 0;
      let passes = 0;

      // Garde-fou : 40 reprises couvrent largement une année de commandes.
      while (passes < 40) {
        const res = await fetch('/api/square/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor ? { cursor } : {}),
        });
        const data = await res.json();

        if (!data.success) {
          alert('Erreur : ' + (data.error || 'Inconnu'));
          break;
        }

        orders += data.synced?.orders || 0;
        items += data.synced?.items || 0;
        zero += data.synced?.zeroAmountOrders || 0;
        passes++;

        if (data.complete) {
          const alerte = zero > 0
            ? `\n\nAttention : ${zero} commande(s) sans montant exploitable côté Square.`
            : '';
          alert(`Synchronisation terminée : ${orders} commandes, ${items} articles.${alerte}`);
          break;
        }

        cursor = data.cursor;
        if (!cursor) break;
      }

      if (passes >= 40) {
        alert(`Synchronisation interrompue après ${orders} commandes (trop de reprises). Relance-la.`);
      }
      loadData();
    } catch {
      alert('Erreur de synchronisation');
    }
    setSyncing(false);
  };

  // Helper to compute HT Net amount from raw_data (excludes VAT)
  const getHtAmount = (o: any) => {
    const raw = o.raw_data || {};
    const tax = (raw.total_tax_money?.amount || raw.net_amounts?.tax_money?.amount || 0) / 100;
    return (o.net_amount || 0) - tax;
  };

  // LFL calculations (only up to anchorDate for current period and matching days elapsed in previous period)
  const { currentStartISO, currentEndISO, prevStartISO, prevEndISO } = useMemo(
    () => computePeriods(period, anchorDate),
    [period, anchorDate]
  );

  // Filter active and comparison orders strictly for LFL calculations
  const activePaidOrdersLFL = orders.filter(
    (o: any) => o.service >= currentStartISO && o.service <= currentEndISO && (o.net_amount || 0) > 0
  );
  const prevPaidOrdersLFL = prevOrders.filter(
    (o: any) => o.service >= prevStartISO && o.service <= prevEndISO && (o.net_amount || 0) > 0
  );

  // Commandes à 0 € sur la période LFL (affichées sous la liste des commandes)
  const zeroOrdersLFL = orders.filter(
    (o: any) => o.service >= currentStartISO && o.service <= currentEndISO && (o.net_amount || 0) <= 0
  ).length;

  // KPIs LFL calculations
  const totalCATTC = activePaidOrdersLFL.reduce((s: number, o: any) => s + (o.net_amount || 0), 0);
  const totalCA = activePaidOrdersLFL.reduce((s: number, o: any) => s + getHtAmount(o), 0); // Net HT CA
  const totalOrders = activePaidOrdersLFL.length;
  const ticketMoyen = totalOrders > 0 ? totalCATTC / totalOrders : 0; // Average ticket calculated in TTC like Square

  const prevTotalCATTC = prevPaidOrdersLFL.reduce((s: number, o: any) => s + (o.net_amount || 0), 0);
  const prevTotalCA = prevPaidOrdersLFL.reduce((s: number, o: any) => s + getHtAmount(o), 0);
  const prevTotalOrders = prevPaidOrdersLFL.length;
  const prevTicketMoyen = prevTotalOrders > 0 ? prevTotalCATTC / prevTotalOrders : 0;

  const exportCSV = () => {
    downloadCSV(orders.map(o => ({
      Date: formatDate(o.service),
      'ID Square': o.square_order_id,
      'Total brut': o.total_money,
      'Net': o.net_amount,
      'Net HT': getHtAmount(o),
      'Remises': o.discount_amount,
    })), 'ventes-qentina');
  };

  // Build comparison chart data (Gross sales TTC comparison)
  const getChartData = (): any[] => {
    if (period === 'day') {
      const hours = Array.from({ length: 13 }, (_, i) => i + 11);
      return hours.map(h => {
        const hourStr = `${h}h`;
        const currentSum = orders
          .filter(o => getParisHour(new Date(o.created_at)) === h)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        const prevSum = prevOrders
          .filter(o => getParisHour(new Date(o.created_at)) === h)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        return {
          name: hourStr,
          'Ce jour': Math.round(currentSum),
          'Hier': Math.round(prevSum),
        };
      });
    } else if (period === 'week') {
      const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
      const daysEnglishIndex = [1, 2, 3, 4, 5, 6, 0];
      
      return days.map((dayLabel, idx) => {
        const engDayIdx = daysEnglishIndex[idx];
        const currentSum = orders
          .filter(o => parseISO(o.service).getDay() === engDayIdx)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        const prevSum = prevOrders
          .filter(o => parseISO(o.service).getDay() === engDayIdx)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        return {
          name: dayLabel,
          'Cette semaine': Math.round(currentSum),
          'Semaine dernière': Math.round(prevSum),
        };
      });
    } else {
      const daysInMonth = Array.from({ length: 31 }, (_, i) => i + 1);
      return daysInMonth.map(d => {
        const currentSum = orders
          .filter(o => parseISO(o.service).getDate() === d)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        const prevSum = prevOrders
          .filter(o => parseISO(o.service).getDate() === d)
          .reduce((sum, o) => sum + (o.net_amount || 0), 0);

        return {
          name: String(d),
          'Ce mois': Math.round(currentSum),
          'Mois dernier': Math.round(prevSum),
        };
      });
    }
  };

  const chartData = getChartData();

  const generateInsight = async () => {
    setLoadingInsight(true);
    setFuegoInsight(null);
    try {
      const res = await fetch('/api/ai/ventes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chartData, topItems, totalCA, totalOrders })
      });
      const data = await res.json();
      if (data.insight) setFuegoInsight(data.insight);
      else if (data.error) alert(data.error);
    } catch (e) {
      alert("Erreur de génération d'analyse");
    }
    setLoadingInsight(false);
  };

  const renderGrowthBadge = (current: number, prev: number, label: string, isCurrency = false) => {
    const diff = current - prev;
    let pct = 0;
    if (prev > 0) {
      pct = (diff / prev) * 100;
    } else if (current > 0) {
      pct = 100;
    }

    const isPositive = diff >= 0;
    const badgeColor = isPositive ? 'var(--green)' : 'var(--red)';
    const badgeBg = isPositive ? 'var(--green-light)' : 'var(--red-light)';
    const sign = isPositive ? '+' : '';
    const formattedDiff = isCurrency ? formatCurrency(Math.abs(diff)) : Math.abs(diff);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
          <span style={{ 
            background: badgeBg, 
            color: badgeColor, 
            padding: '2px 8px', 
            borderRadius: 100, 
            fontSize: 12, 
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2
          }}>
            {isPositive ? '↗' : '↘'} {sign}{pct.toFixed(1)}%
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {label} ({sign}{formattedDiff})
          </span>
        </div>
      </div>
    );
  };

  const getComparisonLabel = () => {
    if (period === 'day') return 'vs hier';
    if (period === 'week') return 'vs sem. dernière (LFL)';
    return 'vs mois dernier (LFL)';
  };

  const displayedOrders = isTableExpanded ? orders : orders.slice(0, 5);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Pilotage des Ventes</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Suivi des ventes en temps réel & comparatifs de croissance (alignés avec votre caisse Square)
          </span>
        </div>
        <div className="page-header-actions">
          <div className="period-selector" style={{ marginRight: 8 }}>
            <button className={`period-btn ${period === 'day' ? 'active' : ''}`} onClick={() => { setPeriod('day'); setIsTableExpanded(false); }}>Jour</button>
            <button className={`period-btn ${period === 'week' ? 'active' : ''}`} onClick={() => { setPeriod('week'); setIsTableExpanded(false); }}>Semaine</button>
            <button className={`period-btn ${period === 'month' ? 'active' : ''}`} onClick={() => { setPeriod('month'); setIsTableExpanded(false); }}>Mois</button>
          </div>

          <button className="btn btn-primary btn-sm" onClick={generateInsight} disabled={loadingInsight} style={{ background: 'var(--orange)', borderColor: 'var(--orange)', color: 'white' }}>
            <Flame size={18} className={loadingInsight ? 'spinning' : ''} /> {loadingInsight ? 'Analyse en cours...' : 'Fuego Insights'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={exportCSV}><Download size={16} /> CSV</button>
          <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
            <RefreshCw size={18} className={syncing ? 'spinning' : ''} /> {syncing ? 'Synchro...' : 'Synchroniser'}
          </button>
        </div>
      </div>
      
      <div className="page-body">
        <div className="filter-bar" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Calendar size={18} style={{ color: 'var(--text-secondary)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Date pivot :</span>
          </div>
          <input
            type="date"
            className="form-input"
            value={anchorDate}
            onChange={e => { setAnchorDate(e.target.value); setIsTableExpanded(false); }}
          />
          {anchorDate !== toISODate(new Date()) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setAnchorDate(toISODate(new Date())); setIsTableExpanded(false); }}>
              Aujourd&apos;hui
            </button>
          )}
        </div>

        {fuegoInsight && (
          <div className="card" style={{ marginBottom: 24, borderLeft: '4px solid var(--orange)', background: 'linear-gradient(to right, rgba(249, 115, 22, 0.05), transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: 'var(--orange)' }}>
              <Flame size={20} />
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Analyse Fuego</h3>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {fuegoInsight}
            </div>
          </div>
        )}

        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : (
          <>
            <div className="kpi-grid">
              <div className="kpi-card" style={{ borderLeft: '4px solid var(--teal)' }}>
                <div className="kpi-label"><TrendingUp size={16} /> Ventes nettes (HT)</div>
                <div className="kpi-value">{formatCurrency(totalCA)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, fontWeight: 500 }}>
                  {formatCurrency(totalCATTC)} TTC (Brut)
                </div>
                {renderGrowthBadge(totalCA, prevTotalCA, getComparisonLabel(), true)}
              </div>
              <div className="kpi-card">
                <div className="kpi-label"><ShoppingCart size={16} /> Ventes (Transactions)</div>
                <div className="kpi-value">{totalOrders}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Excluant les commandes à 0 €
                </div>
                {renderGrowthBadge(totalOrders, prevTotalOrders, getComparisonLabel(), false)}
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Vente moyenne (TTC)</div>
                <div className="kpi-value">{formatCurrency(ticketMoyen)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Ticket moyen brut TTC
                </div>
                {renderGrowthBadge(ticketMoyen, prevTicketMoyen, getComparisonLabel(), true)}
              </div>
            </div>

            <div className="grid-2-1" style={{ marginBottom: 24 }}>
              <div className="card">
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                  {period === 'day' && 'Comparatif ventes heure par heure (TTC)'}
                  {period === 'week' && 'Comparatif ventes jour par jour (TTC)'}
                  {period === 'month' && 'Évolution journalière des ventes (TTC)'}
                </h3>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 16 }}>
                  {period === 'day' && 'Comparaison entre Ce Jour et Hier'}
                  {period === 'week' && 'Comparaison entre Cette Semaine et la Semaine Dernière'}
                  {period === 'month' && 'Comparaison entre Ce Mois et le Mois Dernier'}
                </span>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height="100%">
                    {period === 'month' ? (
                      <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                        <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                        <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} tickFormatter={(v) => `${v}€`} />
                        <Tooltip contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} formatter={(value: any) => formatCurrency(Number(value) || 0)} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
                        <Line type="monotone" dataKey="Ce mois" stroke="var(--teal)" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                        <Line type="monotone" dataKey="Mois dernier" stroke="var(--text-muted)" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                      </LineChart>
                    ) : (
                      <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                        <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                        <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} tickFormatter={(v) => `${v}€`} />
                        <Tooltip cursor={{ fill: 'rgba(0,0,0,0.03)' }} contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} formatter={(value: any) => formatCurrency(Number(value) || 0)} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
                        <Bar dataKey={period === 'day' ? 'Ce jour' : 'Cette semaine'} fill="var(--teal)" radius={[4, 4, 0, 0]} />
                        <Bar dataKey={period === 'day' ? 'Hier' : 'Semaine dernière'} fill="var(--border)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="card">
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Top Produits de la période</h3>
                {topItems.length === 0 ? (
                  <div style={{ display: 'flex', height: '200px', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    Aucun article vendu
                  </div>
                ) : (
                  <div className="table-container" style={{ border: 'none' }}>
                    <table style={{ minWidth: 'auto' }}>
                      <thead>
                        <tr>
                          <th style={{ background: 'none', paddingLeft: 0 }}>Produit</th>
                          <th style={{ background: 'none', textAlign: 'right' }}>Quantité</th>
                          <th style={{ background: 'none', textAlign: 'right', paddingRight: 0 }}>CA Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topItems.map((ti, i) => (
                          <tr key={i}>
                            <td style={{ padding: '8px 8px 8px 0', fontWeight: 500 }}>{ti.name}</td>
                            <td style={{ padding: '8px', textAlign: 'right' }}>{ti.qty}</td>
                            <td style={{ padding: '8px 0 8px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--teal)' }}>{formatCurrency(ti.ca)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ paddingBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 700 }}>Liste des Commandes de la période</h3>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Total : {orders.length} commande(s) (incluant {zeroOrdersLFL} commande(s) à 0 €)
                  </span>
                </div>
                {orders.length > 5 && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setIsTableExpanded(!isTableExpanded)}
                    style={{ fontSize: 12 }}
                  >
                    {isTableExpanded ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ChevronUp size={14} /> Réduire le tableau</span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ChevronDown size={14} /> Agrandir le tableau ({orders.length})</span>
                    )}
                  </button>
                )}
              </div>

              {orders.length === 0 ? (
                <div className="empty-state">
                  <ShoppingCart size={48} />
                  <p>Aucune vente enregistrée sur cette période.</p>
                </div>
              ) : (
                <>
                  <div className="table-container" style={{ marginBottom: selectedOrder ? 16 : 0 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>ID Commande</th>
                          <th>Total brut (TTC)</th>
                          <th>Remises</th>
                          <th>Net (TTC)</th>
                          <th>Net (HT)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedOrders.map(o => (
                          <tr key={o.id} onClick={() => loadItems(o.id)} style={{ cursor: 'pointer', background: selectedOrder === o.id ? 'var(--teal-bg)' : undefined }}>
                            <td>{formatDate(o.service)}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.square_order_id?.substring(0, 12)}...</td>
                            <td>{formatCurrency(o.total_money)}</td>
                            <td style={{ color: 'var(--orange)' }}>{formatCurrency(o.discount_amount)}</td>
                            <td style={{ fontWeight: 600 }}>{formatCurrency(o.net_amount)}</td>
                            <td style={{ fontWeight: 700, color: 'var(--teal)' }}>{formatCurrency(getHtAmount(o))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  
                  {orders.length > 5 && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                      <button 
                        className="btn btn-ghost btn-sm" 
                        onClick={() => setIsTableExpanded(!isTableExpanded)}
                        style={{ color: 'var(--teal)', fontWeight: 600 }}
                      >
                        {isTableExpanded ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Réduire la liste <ChevronUp size={16} /></span>
                        ) : (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Afficher toutes les {orders.length} commandes <ChevronDown size={16} /></span>
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {selectedOrder && (
              <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                  <div className="card-title">Détail commande</div>
                  <button className="btn btn-ghost btn-sm" onClick={() => { itemsRequestRef.current = null; setSelectedOrder(null); setItems([]); }}>Fermer</button>
                </div>
                {items.length === 0 ? (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    Aucun article
                  </div>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Article</th>
                          <th>Qté</th>
                          <th>Prix unit.</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map(item => (
                          <tr key={item.id}>
                            <td style={{ fontWeight: 500 }}>{item.name}</td>
                            <td>{item.quantity}</td>
                            <td>{formatCurrency(item.base_price)}</td>
                            <td style={{ fontWeight: 600 }}>{formatCurrency(item.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
