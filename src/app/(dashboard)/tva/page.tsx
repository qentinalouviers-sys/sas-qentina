'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, getDateRange, toISODate, formatDate, CATEGORY_LABELS } from '@/lib/utils';
import { getVatRate } from '@/lib/tva';
import { 
  Percent, 
  TrendingUp, 
  TrendingDown, 
  Receipt, 
  Calendar, 
  FileText, 
  ArrowUpRight,
  Eye,
  EyeOff
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import type { PeriodFilter } from '@/lib/types';

export default function TvaPage() {
  const [period, setPeriod] = useState<PeriodFilter>('month');
  const [loading, setLoading] = useState(true);
  const [maskedSuppliers, setMaskedSuppliers] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const supabase = createClient();
  
  const [data, setData] = useState({
    collectedTva: 0,
    collectedTvaBreakdown: {
      '5.5%': 0,
      '10%': 0,
      '20%': 0,
      'autre': 0
    },
    deductibleTva: 0,
    netTva: 0, // collectedTva - deductibleTva
    
    // Lists for tables
    salesList: [] as any[],
    purchasesList: [] as any[],
    suppliersTvaList: [] as any[]
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    const { start, end } = getDateRange(period);
    const startStr = toISODate(start);
    const endStr = toISODate(end);

    try {
      // Les 4 requêtes indépendantes sont exécutées en parallèle
      const [
        { data: settingsData },
        { data: orders },
        { data: invoices },
        { data: bankTx },
      ] = await Promise.all([
        // 0. Fetch masked suppliers from settings
        supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'masked_tva_suppliers'),
        // 1. Fetch Square Orders in period to compute collected VAT
        supabase
          .from('square_orders')
          .select('id, net_amount, service, square_order_id, raw_data')
          .gte('service', startStr)
          .lte('service', endStr)
          .order('service', { ascending: false }),
        // 2. Fetch Invoices in period
        supabase
          .from('invoices')
          .select('id, date, invoice_number, total_ht, total_ttc, tva_recoverable, type_document, company_name_present, supplier:suppliers(name)')
          .gte('date', startStr)
          .lte('date', endStr),
        // 3. Fetch Bank Transactions in period (expenses)
        supabase
          .from('bank_transactions')
          .select('id, date, description, amount, category, invoice_id')
          .in('category', ['variable_fournisseur', 'fixe_loyer', 'fixe_abonnement', 'fixe_assurance', 'autre'])
          .gte('date', startStr)
          .lte('date', endStr),
      ]);

      const loadedMaskedSuppliers: string[] = settingsData && settingsData.length > 0 && settingsData[0].value
        ? JSON.parse(settingsData[0].value)
        : [];

      setMaskedSuppliers(loadedMaskedSuppliers);

      const salesList = orders || [];
      
      let collectedTva = 0;
      const collectedTvaBreakdown = {
        '5.5%': 0,
        '10%': 0,
        '20%': 0,
        'autre': 0
      };

      salesList.forEach((order: any) => {
        const orderTax = order.raw_data?.total_tax_money?.amount;
        if (orderTax !== undefined) {
          const orderTaxEuro = orderTax / 100;
          collectedTva += orderTaxEuro;

          // Compute breakdown per item if line_items exist
          if (order.raw_data.line_items && Array.isArray(order.raw_data.line_items)) {
            order.raw_data.line_items.forEach((item: any) => {
              const itemTax = (item.total_tax_money?.amount || 0) / 100;
              const itemTotal = (item.total_money?.amount || 0) / 100;
              
              if (itemTax > 0) {
                const itemHt = itemTotal - itemTax;
                if (itemHt > 0) {
                  const rate = itemTax / itemHt;
                  if (rate >= 0.18 && rate <= 0.22) {
                    collectedTvaBreakdown['20%'] += itemTax;
                  } else if (rate >= 0.08 && rate <= 0.12) {
                    collectedTvaBreakdown['10%'] += itemTax;
                  } else if (rate >= 0.04 && rate <= 0.07) {
                    collectedTvaBreakdown['5.5%'] += itemTax;
                  } else {
                    collectedTvaBreakdown['autre'] += itemTax;
                  }
                } else {
                  collectedTvaBreakdown['autre'] += itemTax;
                }
              }
            });
          } else {
            collectedTvaBreakdown['10%'] += orderTaxEuro;
          }
        } else {
          const netAmt = order.net_amount || 0;
          const estimatedTax = netAmt * (0.10 / 1.10);
          collectedTva += estimatedTax;
          collectedTvaBreakdown['10%'] += estimatedTax;
        }
      });

      const invoicesList = invoices || [];
      const bankTxList = bankTx || [];

      // Set of linked invoice IDs to prevent duplicate counts
      const linkedInvoiceIds = new Set(bankTxList.map((tx: any) => tx.invoice_id).filter(Boolean));

      // Factures liées à une transaction mais hors période : UNE seule requête
      // groupée (avant : une requête par transaction — boucle N+1).
      const invoicesById = new Map<any, any>(invoicesList.map((i: any) => [i.id, i]));
      const missingInvoiceIds = [...linkedInvoiceIds].filter(id => !invoicesById.has(id));
      if (missingInvoiceIds.length > 0) {
        const { data: outerInvoices } = await supabase
          .from('invoices')
          .select('id, date, invoice_number, total_ht, total_ttc, tva_recoverable, type_document, company_name_present, supplier:suppliers(name)')
          .in('id', missingInvoiceIds);
        (outerInvoices || []).forEach((inv: any) => invoicesById.set(inv.id, inv));
      }

      const consolidatedPurchases: any[] = [];
      let deductibleTva = 0;
      const supplierMap: Record<string, { name: string; ht: number; ttc: number; tva: number; count: number }> = {};

      // A. Process paid items from Bank Transactions (boucle synchrone, aucune requête)
      for (const tx of bankTxList) {
        const amt = Math.abs(tx.amount || 0);
        let tva = 0;
        let ht = amt;
        let isLinked = false;
        let invoiceNum = '-';
        let isTvaRec = true;
        let typeDoc = null;
        let isCompanyPresent = null;

        if (tx.invoice_id) {
          const inv = invoicesById.get(tx.invoice_id);

          if (inv) {
            const ttc = inv.total_ttc || amt;
            typeDoc = inv.type_document;
            isCompanyPresent = inv.company_name_present;
            isTvaRec = inv.tva_recoverable !== false;
            
            if (isTvaRec) {
              ht = inv.total_ht || amt;
              tva = Math.max(0, ttc - ht);
            } else {
              ht = ttc;
              tva = 0;
            }
            isLinked = true;
            invoiceNum = inv.invoice_number || 'Facture liée';
          } else {
            const rate = getVatRate(tx.category);
            tva = amt * (rate / (1 + rate));
            ht = amt - tva;
          }
        } else {
          const rate = getVatRate(tx.category);
          tva = amt * (rate / (1 + rate));
          ht = amt - tva;
        }

        const supName = tx.description || 'Inconnu';
        const isMasked = loadedMaskedSuppliers.includes(supName);

        if (!isMasked) {
          deductibleTva += tva;
        }

        consolidatedPurchases.push({
          id: tx.id,
          invoiceId: tx.invoice_id,
          date: tx.date,
          supplierName: supName,
          invoiceNumber: invoiceNum,
          category: tx.category,
          ht,
          ttc: amt,
          tva,
          statusLabel: isLinked ? 'Comptabilisé (Facture liée)' : 'Validé (Relevé bancaire)',
          isLinked,
          tva_recoverable: isTvaRec,
          type_document: typeDoc,
          company_name_present: isCompanyPresent,
        });

        if (!supplierMap[supName]) {
          supplierMap[supName] = { name: supName, ht: 0, ttc: 0, tva: 0, count: 0 };
        }
        supplierMap[supName].ht += ht;
        supplierMap[supName].ttc += amt;
        supplierMap[supName].tva += tva;
        supplierMap[supName].count += 1;
      }

      // B. Process unpaid items from Invoices alone (not linked to bank transactions yet)
      const unpaidInvoices = invoicesList.filter((inv: any) => !linkedInvoiceIds.has(inv.id));
      for (const inv of unpaidInvoices) {
        const ttc = inv.total_ttc || 0;
        const isTvaRec = inv.tva_recoverable !== false;
        let ht = ttc;
        let tva = 0;

        if (isTvaRec) {
          ht = inv.total_ht || 0;
          tva = Math.max(0, ttc - ht);
        } else {
          ht = ttc;
          tva = 0;
        }
        
        const supName = inv.supplier?.name || 'Inconnu';
        const isMasked = loadedMaskedSuppliers.includes(supName);

        if (!isMasked) {
          deductibleTva += tva;
        }

        consolidatedPurchases.push({
          id: inv.id,
          invoiceId: inv.id,
          date: inv.date,
          supplierName: supName,
          invoiceNumber: inv.invoice_number || 'Facture seule',
          category: 'variable_fournisseur',
          ht,
          ttc,
          tva,
          statusLabel: 'En attente de paiement (Facture)',
          isLinked: true,
          tva_recoverable: isTvaRec,
          type_document: inv.type_document,
          company_name_present: inv.company_name_present,
        });

        if (!supplierMap[supName]) {
          supplierMap[supName] = { name: supName, ht: 0, ttc: 0, tva: 0, count: 0 };
        }
        supplierMap[supName].ht += ht;
        supplierMap[supName].ttc += ttc;
        supplierMap[supName].tva += tva;
        supplierMap[supName].count += 1;
      }

      // Sort consolidated purchases by date
      consolidatedPurchases.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      
      const suppliersTvaList = Object.values(supplierMap).sort((a, b) => b.tva - a.tva);
      const netTva = collectedTva - deductibleTva;

      setData({
        collectedTva,
        collectedTvaBreakdown,
        deductibleTva,
        netTva,
        salesList,
        purchasesList: consolidatedPurchases,
        suppliersTvaList
      });

    } catch (e) {
      console.error("Error loading VAT data:", e);
    } finally {
      setLoading(false);
    }
  }, [period, supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime update
  useEffect(() => {
    const channel = supabase.channel('tva-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'square_orders' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_transactions' }, () => loadData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadData, supabase]);

  // Toggle supplier masking — persisted in app_settings
  const toggleMaskSupplier = async (supplierName: string) => {
    let newMasked = [...maskedSuppliers];
    if (newMasked.includes(supplierName)) {
      newMasked = newMasked.filter(name => name !== supplierName);
    } else {
      newMasked.push(supplierName);
    }

    // 1. Update local state immediately (optimistic UI)
    setMaskedSuppliers(newMasked);
    setSaveStatus('saving');

    // Annule la bascule optimiste (forme fonctionnelle : pas d'état périmé)
    const revertOptimisticUpdate = () => {
      setMaskedSuppliers(prev =>
        prev.includes(supplierName)
          ? prev.filter(name => name !== supplierName)
          : [...prev, supplierName]
      );
    };

    try {
      // 2. Un seul upsert sur la clé primaire (remplace le delete + insert)
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'masked_tva_suppliers', value: JSON.stringify(newMasked) }, { onConflict: 'key' });

      if (error) {
        console.error('Error saving masked suppliers:', error);
        setSaveStatus('error');
        // Revert optimistic update
        revertOptimisticUpdate();
        return;
      }

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);

      // 3. Reload with freshly saved masked list (pass directly to avoid stale read)
      loadData();
    } catch (error) {
      console.error('Error saving masked suppliers:', error);
      setSaveStatus('error');
      revertOptimisticUpdate();
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  // Toggle invoice VAT recoverability in DB
  const toggleTvaRecoverable = async (invoiceId: string, currentVal: boolean) => {
    try {
      const { error } = await supabase
        .from('invoices')
        .update({ tva_recoverable: !currentVal })
        .eq('id', invoiceId);

      if (error) throw error;
      loadData(); // Reload VAT dashboard data
    } catch (e) {
      console.error('Error toggling VAT recoverability:', e);
      alert('Erreur lors de la modification de la récupérabilité.');
    }
  };

  // Chart data
  const chartData = [
    {
      name: 'TVA',
      'TVA Collectée': Number(data.collectedTva.toFixed(2)),
      'TVA Déductible': Number(data.deductibleTva.toFixed(2))
    }
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Déclaration & Suivi de la TVA</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Suivi des flux de TVA collectée sur les ventes et récupérée sur vos achats
          </span>
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
            <div className="spinner" style={{ width: 32, height: 32 }} />
            <p>Consolidation des flux de TVA...</p>
          </div>
        ) : (
          <>
            {/* KPI Cards */}
            <div className="kpi-grid" style={{ marginBottom: 24 }}>
              {/* Card 1: Net VAT to pay / VAT credit */}
              <div className={`kpi-card ${data.netTva >= 0 ? 'warning' : 'success'}`} style={{ borderLeft: data.netTva >= 0 ? '4px solid var(--orange)' : '4px solid var(--green)' }}>
                <div className="kpi-label">
                  {data.netTva >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} 
                  {data.netTva >= 0 ? "TVA Nette à Payer" : "Crédit de TVA estimé"}
                </div>
                <div className="kpi-value" style={{ color: data.netTva >= 0 ? 'var(--orange)' : 'var(--green)' }}>
                  {formatCurrency(Math.abs(data.netTva))}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {data.netTva >= 0 
                    ? "Montant à reverser à l'administration" 
                    : "Créance de TVA récupérable sur les prochains mois"}
                </div>
              </div>

              {/* Card 2: Collected VAT */}
              <div className="kpi-card">
                <div className="kpi-label">
                  <ArrowUpRight size={16} style={{ color: 'var(--teal)' }} /> TVA Collectée (Ventes)
                </div>
                <div className="kpi-value">{formatCurrency(data.collectedTva)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                    <span>Taux 10% (Restauration) :</span>
                    <strong>{formatCurrency(data.collectedTvaBreakdown['10%'])}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                    <span>Taux 5.5% (Emporté) :</span>
                    <strong>{formatCurrency(data.collectedTvaBreakdown['5.5%'])}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
                    <span>Taux 20% (Alcools) :</span>
                    <strong>{formatCurrency(data.collectedTvaBreakdown['20%'])}</strong>
                  </div>
                </div>
              </div>

              {/* Card 3: Deductible VAT */}
              <div className="kpi-card">
                <div className="kpi-label">
                  <Receipt size={16} style={{ color: 'var(--orange)' }} /> TVA Déductible (Achats & Dépenses)
                </div>
                <div className="kpi-value" style={{ color: 'var(--text-primary)' }}>
                  {formatCurrency(data.deductibleTva)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Calculé sur l&apos;ensemble de vos factures et écritures bancaires de dépenses
                </div>
              </div>
            </div>

            {/* Restaurant Industry Specific Fiscal Tips */}
            <div className="card" style={{ marginBottom: 24, borderLeft: '4px solid var(--teal)' }}>
              <div className="card-header" style={{ paddingBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Percent size={20} style={{ color: 'var(--teal)' }} />
                  <h3 className="card-title" style={{ fontSize: 16 }}>Conseils d&apos;optimisation fiscale (Restauration)</h3>
                </div>
              </div>
              <div className="card-body" style={{ padding: '0 20px 20px' }}>
                <div className="grid-2" style={{ gap: 16 }}>
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    <strong style={{ fontSize: 13, color: 'var(--teal)', display: 'block', marginBottom: 4 }}>1. Ventilation des Ventes (10% vs 5.5%)</strong>
                    <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      Les pizzas consommées sur place ou emportées chaudes sont soumises à <strong>10%</strong>. Les boissons sans alcool emportées et desserts emballés sont à <strong>5.5%</strong>. Configurez bien ces catégories dans Square pour réduire la TVA collectée.
                    </p>
                  </div>
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    <strong style={{ fontSize: 13, color: 'var(--teal)', display: 'block', marginBottom: 4 }}>2. TVA sur les boissons alcoolisées (20%)</strong>
                    <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      Les bières, vins et alcools sont toujours soumis au taux de <strong>20%</strong>, y compris à emporter. Vérifiez régulièrement votre catalogue de caisse Square pour vous assurer du respect de cette règle fiscale.
                    </p>
                  </div>
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    <strong style={{ fontSize: 13, color: 'var(--teal)', display: 'block', marginBottom: 4 }}>3. TVA Déductible sur Factures (&ldquo;sur les débits&rdquo;)</strong>
                    <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      Pour les gros fournisseurs de matières premières (ex: Métro, Mozzalat) ayant opté pour la &ldquo;TVA sur les débits&rdquo;, vous pouvez déduire la TVA dès l&apos;émission de la facture, sans attendre le règlement bancaire.
                    </p>
                  </div>
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                    <strong style={{ fontSize: 13, color: 'var(--teal)', display: 'block', marginBottom: 4 }}>4. Repas d&apos;affaires & Invitations</strong>
                    <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      La TVA sur les repas avec vos clients ou partenaires est récupérable à 100% (pensez à noter le nom des invités sur la facture). Notez que la TVA sur les déplacements et nuits d&apos;hôtel du dirigeant n&apos;est pas récupérable.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Charts & Breakdown Grid */}
            <div className="grid-2" style={{ marginBottom: 24 }}>
              {/* Chart collected vs deductible */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Balance de TVA</div>
                  <Percent size={18} style={{ color: 'var(--teal)' }} />
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="var(--text-muted)" />
                      <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" tickFormatter={(v) => `${v}€`} />
                      <Tooltip formatter={(val: any) => formatCurrency(val)} />
                      <Legend iconType="circle" />
                      <Bar dataKey="TVA Collectée" fill="var(--teal)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="TVA Déductible" fill="var(--orange)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Deductible VAT by Supplier */}
              <div className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">TVA Déductible par Fournisseur</div>
                    <div className="card-subtitle" style={{ marginTop: 2 }}>
                      Cliquez sur 👁 pour masquer une ligne des calculs de TVA — 
                      <strong> votre sélection est sauvegardée automatiquement</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {saveStatus === 'saving' && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                        <div className="spinner" style={{ width: 14, height: 14 }} /> Sauvegarde...
                      </span>
                    )}
                    {saveStatus === 'saved' && (
                      <span style={{
                        fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 100,
                        background: 'var(--green-light)', color: 'var(--green)',
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        ✓ Sauvegardé
                      </span>
                    )}
                    {saveStatus === 'error' && (
                      <span style={{
                        fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 100,
                        background: 'var(--red-light)', color: 'var(--red)',
                      }}>
                        ✗ Erreur de sauvegarde
                      </span>
                    )}
                    <FileText size={18} style={{ color: 'var(--text-muted)' }} />
                  </div>
                </div>
                <div className="table-container" style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {data.suppliersTvaList.length === 0 ? (
                    <div className="empty-state" style={{ padding: '40px 0' }}>
                      <p>Aucune dépense enregistrée pour cette période.</p>
                    </div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Fournisseur / Bénéficiaire</th>
                          <th style={{ textAlign: 'right' }}>Nombre d&apos;écritures</th>
                          <th style={{ textAlign: 'right' }}>Total HT</th>
                          <th style={{ textAlign: 'right' }}>TVA déduite</th>
                          <th style={{ textAlign: 'center', width: '60px' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.suppliersTvaList.map((sup, idx) => {
                          const isMasked = maskedSuppliers.includes(sup.name);
                          return (
                            <tr key={idx} style={isMasked ? { opacity: 0.5, background: 'rgba(0,0,0,0.02)' } : {}}>
                              <td style={{ fontWeight: 600, textDecoration: isMasked ? 'line-through' : 'none' }}>{sup.name}</td>
                              <td style={{ textAlign: 'right' }}>{sup.count}</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(sup.ht)}</td>
                              <td style={{ 
                                textAlign: 'right', 
                                fontWeight: 700, 
                                color: isMasked ? 'var(--text-muted)' : 'var(--orange)',
                                textDecoration: isMasked ? 'line-through' : 'none'
                              }}>
                                {formatCurrency(sup.tva)}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  style={{ padding: '4px 8px', border: '1px solid var(--border)' }}
                                  onClick={() => toggleMaskSupplier(sup.name)}
                                  title={isMasked ? "Réintégrer ce fournisseur dans les calculs de TVA" : "Exclure ce fournisseur des calculs de TVA"}
                                >
                                  {isMasked ? <EyeOff size={14} style={{ color: 'var(--text-muted)' }} /> : <Eye size={14} style={{ color: 'var(--teal)' }} />}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>

            {/* Details Section */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24 }}>
              {/* Deductible VAT Purchases Table */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Détail de la TVA sur vos Achats & Dépenses</div>
                  <span className="badge badge-autre" style={{ background: 'var(--orange-bg)', color: 'var(--orange)' }}>
                    Total déduit : {formatCurrency(data.deductibleTva)}
                  </span>
                </div>
                <div className="table-container" style={{ maxHeight: 350, overflowY: 'auto' }}>
                  {data.purchasesList.length === 0 ? (
                    <div className="empty-state" style={{ padding: '48px 0' }}>
                      <FileText size={40} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
                      <p>Aucun achat sur cette période.</p>
                    </div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Fournisseur / Libellé</th>
                          <th>Facture / Origine</th>
                          <th>Catégorie</th>
                          <th style={{ textAlign: 'right' }}>Montant HT</th>
                          <th style={{ textAlign: 'right' }}>Montant TTC</th>
                          <th style={{ textAlign: 'right' }}>TVA Déductible</th>
                          <th style={{ textAlign: 'center' }}>Récupération TVA</th>
                          <th>Origine de la donnée</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.purchasesList.map((purchase: any, idx: number) => {
                          const catLabel = CATEGORY_LABELS[purchase.category] || purchase.category;
                          const isMasked = maskedSuppliers.includes(purchase.supplierName);
                          return (
                            <tr key={idx} style={{
                              fontStyle: purchase.isLinked ? 'normal' : 'italic',
                              opacity: isMasked ? 0.5 : 1,
                              background: isMasked ? 'rgba(0,0,0,0.02)' : (!purchase.isLinked ? 'rgba(232, 155, 62, 0.02)' : 'inherit')
                            }}>
                              <td>{formatDate(purchase.date)}</td>
                              <td style={{ fontWeight: 600, textDecoration: isMasked ? 'line-through' : 'none' }}>{purchase.supplierName}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{purchase.invoiceNumber}</td>
                              <td>
                                <span className="badge badge-autre" style={{ background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                                  {catLabel}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(purchase.ht)}</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(purchase.ttc)}</td>
                              <td style={{ 
                                textAlign: 'right', 
                                fontWeight: 600, 
                                color: isMasked ? 'var(--text-muted)' : 'var(--orange)',
                                textDecoration: isMasked ? 'line-through' : 'none'
                              }}>
                                {formatCurrency(purchase.tva)}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                {purchase.invoiceId ? (
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    {purchase.tva_recoverable ? (
                                      <span className="badge" style={{ padding: '4px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(45,143,94,0.1)', color: 'var(--green)', border: '1px solid rgba(45,143,94,0.2)' }}>
                                        Récupérable
                                      </span>
                                    ) : (
                                      <span className="badge" style={{ 
                                        background: 'rgba(220,38,38,0.08)', 
                                        color: '#DC2626', 
                                        border: '1px solid rgba(220,38,38,0.2)',
                                        display: 'inline-flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        padding: '4px 6px',
                                        borderRadius: 6,
                                        lineHeight: 1.2
                                      }}>
                                        <strong style={{ fontSize: 9, fontWeight: 800 }}>Non récupérable</strong>
                                        <span style={{ fontSize: 8, opacity: 0.8, fontWeight: 600, marginTop: 1 }}>
                                          {purchase.type_document === 'ticket_caisse' && purchase.ttc > 150 && !purchase.company_name_present
                                            ? 'Ticket > 150€ sans nom'
                                            : purchase.type_document === 'facture' && !purchase.company_name_present
                                            ? 'Facture sans nom'
                                            : 'Exclu manuellement'}
                                        </span>
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => toggleTvaRecoverable(purchase.invoiceId, purchase.tva_recoverable)}
                                      className="btn btn-ghost btn-sm"
                                      style={{
                                        fontSize: 10,
                                        padding: '2px 6px',
                                        border: '1px solid var(--border)',
                                        color: purchase.tva_recoverable ? '#DC2626' : 'var(--teal)',
                                        borderColor: purchase.tva_recoverable ? 'rgba(220,38,38,0.2)' : 'rgba(42,125,123,0.2)',
                                        background: 'white',
                                        cursor: 'pointer'
                                      }}
                                      title={purchase.tva_recoverable ? "Marquer comme non récupérable" : "Forcer la récupération de TVA"}
                                    >
                                      {purchase.tva_recoverable ? '✕ Exclure' : '✓ Récupérer'}
                                    </button>
                                  </div>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                                    Oui (Auto Banque)
                                  </span>
                                )}
                              </td>
                              <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{purchase.statusLabel}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Collected VAT Sales Table */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Détail de la TVA sur Ventes (Square)</div>
                  <span className="badge badge-autre" style={{ background: 'var(--teal-bg)', color: 'var(--teal)' }}>
                    TVA collectée : {formatCurrency(data.collectedTva)}
                  </span>
                </div>
                <div className="table-container" style={{ maxHeight: 350, overflowY: 'auto' }}>
                  {data.salesList.length === 0 ? (
                    <div className="empty-state" style={{ padding: '48px 0' }}>
                      <Calendar size={40} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
                      <p>Aucune vente enregistrée sur cette période.</p>
                    </div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Date Service</th>
                          <th>ID Commande</th>
                          <th style={{ textAlign: 'right' }}>Montant TTC (Net)</th>
                          <th style={{ textAlign: 'right' }}>TVA Collectée</th>
                          <th style={{ textAlign: 'right' }}>Détail des taux</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.salesList.map((order: any) => {
                          const totalTtc = order.net_amount || 0;
                          const taxAmount = order.raw_data?.total_tax_money?.amount;
                          const taxEuro = taxAmount !== undefined ? taxAmount / 100 : totalTtc * (0.10 / 1.10);
                          const isEstimated = taxAmount === undefined;

                          const breakdownStr: string[] = [];
                          if (order.raw_data?.line_items) {
                            const ratesFound: Record<string, number> = {};
                            order.raw_data.line_items.forEach((item: any) => {
                              const itemTax = (item.total_tax_money?.amount || 0) / 100;
                              const itemTotal = (item.total_money?.amount || 0) / 100;
                              if (itemTax > 0) {
                                const ht = itemTotal - itemTax;
                                if (ht > 0) {
                                  const r = itemTax / ht;
                                  const label = r >= 0.18 && r <= 0.22 ? '20%' : r >= 0.08 && r <= 0.12 ? '10%' : r >= 0.04 && r <= 0.07 ? '5.5%' : 'autre';
                                  ratesFound[label] = (ratesFound[label] || 0) + itemTax;
                                }
                              }
                            });
                            Object.entries(ratesFound).forEach(([rateLabel, val]) => {
                              breakdownStr.push(`${rateLabel}: ${val.toFixed(2)}€`);
                            });
                          }

                          return (
                            <tr key={order.id}>
                              <td>{formatDate(order.service)}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{order.square_order_id?.substring(0, 12)}...</td>
                              <td style={{ textAlign: 'right' }}>{formatCurrency(totalTtc)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--teal)' }}>
                                {formatCurrency(taxEuro)} {isEstimated && <span style={{ fontSize: 9, fontWeight: 400, color: 'var(--text-muted)' }}>(Est. 10%)</span>}
                              </td>
                              <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                {breakdownStr.length > 0 ? breakdownStr.join(' | ') : isEstimated ? "10% (Défaut)" : "Aucune taxe"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
