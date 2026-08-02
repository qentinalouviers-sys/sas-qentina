'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate } from '@/lib/utils';
import { Upload, Landmark, AlertCircle, CheckCircle, Filter, Camera, Scissors, Plus, Trash2 } from 'lucide-react';

const CATEGORIES: Record<string, string> = {
  fixe_loyer: 'Loyer & Charges',
  fixe_assurance: 'Assurances',
  fixe_abonnement: 'Abonnements',
  variable_fournisseur: 'Fournisseurs',
  variable_salaire: 'Salaires',
  impot_taxe: 'Impôts & Taxes',
  recette: 'Recette Ventes',
  autre: 'Autre'
};

const ACCOUNTING_CLASSES = [
  { code: '601', label: '601 - Matières Premières' },
  { code: '607', label: '607 - Marchandises (Boissons, café)' },
  { code: '606', label: '606 - Fournitures (Emballages, matériel)' },
  { code: '6061', label: '6061 - Énergie (Électricité, gaz, eau)' },
  { code: '61', label: '61 - Services (Loyers, Assurances)' },
  { code: '62', label: '62 - Services ext. (SaaS, Internet)' },
  { code: '63', label: '63 - Impôts, taxes & cotisations' },
  { code: '64', label: '64 - Personnel (Salaires, charges)' },
  { code: '707', label: '707 - Ventes / Chiffre d\'affaires' },
  { code: '455', label: '455 - Compte Courant Associés' },
  { code: 'autre', label: 'Autre classification' }
];

// Heuristic scoring helper to match a bank transaction with unlinked invoices
function getSuggestionsForTransaction(tx: any, unlinkedInvs: any[]) {
  if (!tx) return [];
  const txAbsAmount = Math.abs(tx.amount);
  
  return unlinkedInvs
    .map(inv => {
      let score = 0;
      const invTtc = inv.total_ttc;
      
      // Heuristic 1: Amount match
      const amountDiff = Math.abs(txAbsAmount - invTtc);
      if (amountDiff < 0.01) {
        score += 100;
      } else if (amountDiff < 1.00) {
        score += 50;
      }
      
      // Heuristic 2: Date proximity
      const txDate = new Date(tx.date);
      const invDate = new Date(inv.date);
      const diffTime = Math.abs(txDate.getTime() - invDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays <= 3) {
        score += 30;
      } else if (diffDays <= 7) {
        score += 20;
      } else if (diffDays <= 15) {
        score += 10;
      } else if (diffDays <= 30) {
        score += 5;
      }
      
      // Heuristic 3: Text match between supplier name and transaction description
      const supplierName = inv.supplier?.name?.toLowerCase() || '';
      const txDesc = tx.description?.toLowerCase() || '';
      if (supplierName && txDesc) {
        if (txDesc.includes(supplierName) || supplierName.includes(txDesc)) {
          score += 40;
        } else {
          // Check words
          const supplierWords = supplierName.split(/\s+/).filter((w: string) => w.length > 2);
          const matches = supplierWords.filter((w: string) => txDesc.includes(w));
          if (matches.length > 0) {
            score += 20 * matches.length;
          }
        }
      }
      
      return { invoice: inv, score };
    })
    .filter(item => item.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

export default function BanquePage() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [splitTxId, setSplitTxId] = useState<string | null>(null);
  const [splitAmounts, setSplitAmounts] = useState<string[]>(['', '']);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filterStatus, setFilterStatus] = useState('pending_invoice');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ccaBalances, setCcaBalances] = useState<{ justine: number; yohan: number }>({ justine: 0, yohan: 0 });

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);

    // Load invoices to compute matching suggestions
    try {
      const { data: invList } = await supabase
        .from('invoices')
        .select('*, supplier:suppliers(*)')
        .order('date', { ascending: false });
      setInvoices(invList || []);
    } catch (e) {
      console.warn("Could not load invoices for suggestions:", e);
    }

    let data = null;
    let error = null;

    // Try joining with invoices including accounting_ref (new schema)
    try {
      let query = supabase
        .from('bank_transactions')
        .select('*, invoice:invoices(accounting_ref, invoice_number), mouvements_cca(associe)')
        .order('date', { ascending: false });
        
      const res = await query;
      data = res.data;
      error = res.error;
    } catch (e) {
      console.warn("New schema join failed, falling back to legacy...", e);
    }

    // Fallback to legacy schema
    if (error || !data) {
      let query = supabase
        .from('bank_transactions')
        .select('*, invoice:invoices(invoice_number), mouvements_cca(associe)')
        .order('date', { ascending: false });
        
      const res = await query;
      data = res.data;
      error = res.error;
    }

    const txList = data || [];

    // Load fallback classifications from app_settings
    try {
      const { data: settingsData } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'transaction_classifications')
        .limit(1);
        
      if (settingsData && settingsData.length > 0 && settingsData[0].value) {
        const classifications = JSON.parse(settingsData[0].value);
        txList.forEach((t: any) => {
          if (!t.accounting_class && classifications[t.id]) {
            t.accounting_class = classifications[t.id];
          }
        });
      }
    } catch (e) {
      console.warn("Could not load fallback classifications:", e);
    }

    // Fetch all movements to calculate balances
    try {
      const { data: movements } = await supabase
        .from('mouvements_cca')
        .select('associe, sens, montant');
        
      let jBal = 0;
      let yBal = 0;
      (movements || []).forEach((m: any) => {
        const amt = Number(m.montant);
        if (m.associe === 'justine') {
          jBal += m.sens === 'apport' ? amt : -amt;
        } else {
          yBal += m.sens === 'apport' ? amt : -amt;
        }
      });
      setCcaBalances({ justine: jBal, yohan: yBal });
    } catch (e) {
      console.warn("Could not load CCA balances:", e);
    }

    setTransactions(txList);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleUpload = async (file: File) => {
    if (!file) return;
    const isPDF = file.type === 'application/pdf' || file.name.endsWith('.pdf');
    const isImage = file.type.startsWith('image/') || file.name.endsWith('.jpg') || file.name.endsWith('.jpeg') || file.name.endsWith('.png') || file.name.endsWith('.webp');
    
    if (!isPDF && !isImage) {
      alert('Veuillez uploader un fichier PDF ou une image (JPG, PNG, WEBP).');
      return;
    }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const res = await fetch('/api/bank/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfBase64: base64 }),
        });
        
        const data = await res.json();
        if (data.success) {
          alert(`Import réussi : ${data.count} nouvelles transactions ajoutées.`);
          loadData();
        } else {
          alert('Erreur extraction : ' + (data.error || 'Inconnu'));
        }
        setUploading(false);
      };
      
      reader.readAsDataURL(file);
    } catch {
      alert('Erreur lors de l\'upload');
      setUploading(false);
    }
  };

  const updateStatus = async (id: string, status: string) => {
    await supabase.from('bank_transactions').update({ status }).eq('id', id);
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, status } : t));
  };

  const updateAccountingClass = async (id: string, accountingClass: string) => {
    // Optimistic update
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, accounting_class: accountingClass } : t));

    // Try updating directly in bank_transactions table
    const { error } = await supabase
      .from('bank_transactions')
      .update({ accounting_class: accountingClass })
      .eq('id', id);

    if (error) {
      console.warn("Direct update failed, falling back to app_settings key-value store...", error);
      
      // Save fallback in app_settings table
      try {
        const { data: existingRow } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'transaction_classifications')
          .limit(1);
          
        const classifications = existingRow && existingRow.length > 0 && existingRow[0].value
          ? JSON.parse(existingRow[0].value)
          : {};
          
        classifications[id] = accountingClass;
        
        await supabase
          .from('app_settings')
          .upsert({
            key: 'transaction_classifications',
            value: JSON.stringify(classifications),
            updated_at: new Date().toISOString()
          });
      } catch (fallbackError) {
        console.error("Fallback update failed:", fallbackError);
        alert("Impossible d'enregistrer la classification comptable.");
      }
    }
  };

  const handleLinkInvoice = async (transaction: any, file: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const res = await fetch('/api/invoices/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBase64: base64,
            mimeType: file.type
          }),
        });
        const data = await res.json();
        if (data.success) {
          alert('Facture analysée, rattachée et comptabilisée avec succès !');
          
          const updateData = {
            status: 'reconciled',
            invoice_id: data.invoice_id,
          };
          
          const { error: directError } = await supabase
            .from('bank_transactions')
            .update({
              ...updateData,
              accounting_class: data.extracted?.compte_comptable || '601',
            })
            .eq('id', transaction.id);
            
          if (directError) {
            console.warn("Direct update failed, applying basic status and saving fallback settings...", directError);
            
            // Basic legacy update
            await supabase.from('bank_transactions').update(updateData).eq('id', transaction.id);
            
            // Save fallback classification
            try {
              const { data: existingRow } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', 'transaction_classifications')
                .limit(1);
                
              const classifications = existingRow && existingRow.length > 0 && existingRow[0].value
                ? JSON.parse(existingRow[0].value)
                : {};
                
              classifications[transaction.id] = data.extracted?.compte_comptable || '601';
              
              await supabase
                .from('app_settings')
                .upsert({
                  key: 'transaction_classifications',
                  value: JSON.stringify(classifications),
                  updated_at: new Date().toISOString()
                });
            } catch (fallbackError) {
              console.error("Fallback update failed:", fallbackError);
            }
          }
          
          loadData();
        } else {
          alert('Erreur : ' + (data.error || 'Inconnu'));
        }
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (e) {
      console.error(e);
      alert('Erreur lors du traitement du fichier.');
      setUploading(false);
    }
  };

  const handleLinkInvoiceDirect = async (transactionId: string, invoice: any) => {
    setLoading(true);
    try {
      const updateData = {
        status: 'reconciled',
        invoice_id: invoice.id,
        accounting_class: invoice.accounting_class || '601',
      };
      
      const { error: directError } = await supabase
        .from('bank_transactions')
        .update(updateData)
        .eq('id', transactionId);
        
      if (directError) {
        console.warn("Direct update failed, falling back to legacy flow", directError);
        await supabase
          .from('bank_transactions')
          .update({ status: 'reconciled', invoice_id: invoice.id })
          .eq('id', transactionId);
      }

      // Update the invoice payment method to 'bank'
      await supabase
        .from('invoices')
        .update({ payment_method: 'bank' })
        .eq('id', invoice.id);

      alert(`Facture de ${invoice.supplier?.name || 'fournisseur'} liée avec succès.`);
      loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'association de la facture.");
    } finally {
      setLoading(false);
    }
  };

  const handleSplitTransaction = async (tx: any) => {
    // Basic validation
    const parsedAmounts = splitAmounts.map(val => parseFloat(val) || 0);
    const sum = parsedAmounts.reduce((s, a) => s + a, 0);
    const txAbsAmount = Math.abs(tx.amount);
    
    if (Math.abs(sum - txAbsAmount) >= 0.01) {
      alert(`Erreur : Le total réparti (${sum.toFixed(2)} €) ne correspond pas au montant de la transaction (${txAbsAmount.toFixed(2)} €).`);
      return;
    }

    setLoading(true);
    try {
      const sign = tx.amount < 0 ? -1 : 1;
      const numParts = parsedAmounts.length;
      
      // 1. Update the original transaction in place (first part)
      const firstPartAmount = parsedAmounts[0] * sign;
      const firstPartDesc = `${tx.description} (Partie 1/${numParts})`;
      
      const { error: updateErr } = await supabase
        .from('bank_transactions')
        .update({
          amount: firstPartAmount,
          description: firstPartDesc
        })
        .eq('id', tx.id);

      if (updateErr) throw updateErr;

      // 2. Insert the remaining transactions
      const newTxList = parsedAmounts.slice(1).map((amt, idx) => ({
        date: tx.date,
        description: `${tx.description} (Partie ${idx + 2}/${numParts})`,
        amount: amt * sign,
        category: tx.category || 'autre',
        status: 'pending_invoice',
      }));

      const { error: insertErr } = await supabase
        .from('bank_transactions')
        .insert(newTxList);

      if (insertErr) throw insertErr;

      alert(`La transaction a été scindée avec succès en ${numParts} parties.`);
      setSplitTxId(null);
      setSplitAmounts(['', '']);
      loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la scission de la transaction.");
      setLoading(false);
    }
  };

  const handleCreateCcaReimbursementAuto = async (tx: any, partner: 'justine' | 'yohan') => {
    setLoading(true);
    try {
      // 1. Fetch current movements to calculate balance
      const { data: movements, error: fetchErr } = await supabase
        .from('mouvements_cca')
        .select('sens, montant')
        .eq('associe', partner);
        
      if (fetchErr) throw fetchErr;
      
      const balance = (movements || []).reduce(
        (sum: number, m: any) => sum + (m.sens === 'apport' ? Number(m.montant) : -Number(m.montant)),
        0
      );
      
      const reimbursementAmount = Math.abs(tx.amount);
      if (balance - reimbursementAmount < 0) {
        const confirmDebit = confirm(
          `⚠️ Cette opération rend le compte de ${
            partner === 'justine' ? 'Justine' : 'Yohan'
          } débiteur (solde : ${formatCurrency(balance - reimbursementAmount)}).\nUn CCA ne doit pas être débiteur en SAS — à régulariser ou à vérifier avec le comptable.\n\nSouhaitez-vous enregistrer quand même ?`
        );
        if (!confirmDebit) {
          setLoading(false);
          return;
        }
      }
      
      // 2. Insert movement
      const { error: insertErr } = await supabase
        .from('mouvements_cca')
        .insert({
          date: tx.date,
          associe: partner,
          sens: 'remboursement',
          sous_type: 'avance_tresorerie',
          montant: reimbursementAmount,
          rapproche_banque: true,
          date_virement_banque: tx.date,
          note: `Remboursement auto via banque : ${tx.description}`,
          bank_transaction_id: tx.id
        });
        
      if (insertErr) throw insertErr;
      
      // 3. Update bank transaction
      const { error: updateErr } = await supabase
        .from('bank_transactions')
        .update({
          status: 'reconciled',
          accounting_class: '455'
        })
        .eq('id', tx.id);
        
      if (updateErr) throw updateErr;
      
      alert(`Remboursement de ${formatCurrency(reimbursementAmount)} pour ${partner === 'justine' ? 'Justine' : 'Yohan'} validé et rapproché avec succès.`);
      loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la création du remboursement.");
      setLoading(false);
    }
  };

  // Selection handlers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allFilteredIds = filteredTransactions.map(t => t.id);
    const allSelected = allFilteredIds.every(id => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        allFilteredIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        allFilteredIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleBulkStatusChange = async (status: string) => {
    if (!status || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setLoading(true);
    const { error } = await supabase.from('bank_transactions').update({ status }).in('id', ids);
    if (!error) {
      setTransactions(prev => prev.map(t => ids.includes(t.id) ? { ...t, status } : t));
      setSelectedIds(new Set());
      alert(`${ids.length} transactions mises à jour.`);
    } else {
      alert("Erreur lors de la mise à jour en lot.");
    }
    setLoading(false);
  };

  const handleBulkClassChange = async (accountingClass: string) => {
    if (!accountingClass || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setLoading(true);
    
    // Update local state optimistically
    setTransactions(prev => prev.map(t => ids.includes(t.id) ? { ...t, accounting_class: accountingClass } : t));
    
    const { error } = await supabase
      .from('bank_transactions')
      .update({ accounting_class: accountingClass })
      .in('id', ids);
      
    if (error) {
      // Fallback
      try {
        const { data: existingRow } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'transaction_classifications')
          .limit(1);
          
        const classifications = existingRow && existingRow.length > 0 && existingRow[0].value
          ? JSON.parse(existingRow[0].value)
          : {};
          
        ids.forEach(id => {
          classifications[id] = accountingClass;
        });
        
        await supabase
          .from('app_settings')
          .upsert({
            key: 'transaction_classifications',
            value: JSON.stringify(classifications),
            updated_at: new Date().toISOString()
          });
      } catch (e) {
        console.error("Bulk fallback failed:", e);
      }
    }
    
    setSelectedIds(new Set());
    alert(`${ids.length} classifications mises à jour.`);
    setLoading(false);
  };

  // KPIs calculations
  const pendingCount = transactions.filter(t => t.status === 'pending_invoice').length;
  const pendingAmount = transactions.filter(t => t.status === 'pending_invoice').reduce((s, t) => s + (t.amount || 0), 0);

  const reconciledCount = transactions.filter(t => t.status === 'reconciled').length;
  const reconciledAmount = transactions.filter(t => t.status === 'reconciled').reduce((s, t) => s + (t.amount || 0), 0);

  const okCount = transactions.filter(t => t.status === 'facture_ok').length;
  const okAmount = transactions.filter(t => t.status === 'facture_ok').reduce((s, t) => s + (t.amount || 0), 0);

  // Filter local data for display
  const filteredTransactions = filterStatus
    ? transactions.filter(t => t.status === filterStatus)
    : transactions;

  const linkedInvoiceIds = new Set(transactions.map(t => t.invoice_id).filter(Boolean));
  const unlinkedInvoices = invoices.filter(inv => {
    const isLinked = linkedInvoiceIds.has(inv.id);
    const isBankOrPending = !inv.payment_method || inv.payment_method === 'bank';
    return !isLinked && isBankOrPending;
  });

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        .mobile-card-list {
          display: none;
        }
        .account-select {
          font-size: 12px;
          padding: 4px 8px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: white;
          color: var(--text-primary);
          max-width: 180px;
          text-overflow: ellipsis;
        }
        .badge-status {
          font-size: 11px;
          font-weight: 700;
          padding: 4px 8px;
          border-radius: 100px;
        }
        .badge-status.pending_invoice {
          background: #FFE8D6;
          color: #A0522D;
        }
        .badge-status.facture_ok {
          background: #E0F2F1;
          color: #00796B;
        }
        .badge-status.reconciled {
          background: #E8F5E9;
          color: #2E7D32;
        }
        .badge-status.ignored {
          background: #ECEFF1;
          color: #546E7A;
        }
        @media (max-width: 768px) {
          .desktop-only-table {
            display: none !important;
          }
          .mobile-card-list {
            display: flex !important;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
          }
          .mobile-card {
            background: white;
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 16px;
            box-shadow: var(--shadow-sm);
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .mobile-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px dashed var(--border-light);
            padding-bottom: 8px;
          }
          .mobile-card-date {
            font-size: 11px;
            color: var(--text-muted);
            font-weight: 600;
          }
          .mobile-card-amount {
            font-size: 15px;
            font-weight: 800;
          }
          .mobile-card-desc {
            font-size: 13px;
            font-weight: 700;
            color: var(--text-primary);
            margin: 4px 0;
          }
          .mobile-card-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            gap: 8px;
          }
          .mobile-card-label {
            color: var(--text-muted);
            font-weight: 600;
          }
          .mobile-select-full {
            width: 100%;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--surface);
            font-size: 12.5px;
            font-weight: 600;
          }
          .mobile-actions {
            display: flex;
            gap: 8px;
            margin-top: 6px;
            border-top: 1px solid var(--border-light);
            padding-top: 10px;
          }
          .mobile-action-btn-full {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 9px;
            border-radius: 8px;
            font-size: 12.5px;
            font-weight: 700;
            border: none;
            cursor: pointer;
          }
        }
      `}} />

      <div className="page-header">
        <h2>Pointage Bancaire & Rapprochement</h2>
      </div>
      
      <div className="page-body">
        {/* KPI Grid + Upload */}
        <div className="kpi-grid-bank" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 16,
          marginBottom: 24
        }}>
          {/* Card 1: Factures Manquantes */}
          <div style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 16,
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: 'var(--orange)' }} />
            <div style={{ paddingLeft: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Factures Manquantes
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--red)', marginTop: 4 }}>
                {formatCurrency(Math.abs(pendingAmount))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {pendingCount} transaction{pendingCount > 1 ? 's' : ''} à lettrer
              </div>
            </div>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(232, 155, 62, 0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--orange)', flexShrink: 0
            }}>
              <AlertCircle size={20} />
            </div>
          </div>

          {/* Card 2: Factures Liées */}
          <div style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 16,
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: 'var(--green)' }} />
            <div style={{ paddingLeft: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Factures Associées
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)', marginTop: 4 }}>
                {formatCurrency(Math.abs(reconciledAmount))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {reconciledCount} transaction{reconciledCount > 1 ? 's' : ''} lettrée{reconciledCount > 1 ? 's' : ''}
              </div>
            </div>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(46, 125, 50, 0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--green)', flexShrink: 0
            }}>
              <CheckCircle size={20} />
            </div>
          </div>

          {/* Card 3: Factures OK */}
          <div style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 16,
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: 'var(--teal)' }} />
            <div style={{ paddingLeft: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Factures Validées (OK)
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--teal)', marginTop: 4 }}>
                {formatCurrency(Math.abs(okAmount))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {okCount} transaction{okCount > 1 ? 's' : ''} validée{okCount > 1 ? 's' : ''}
              </div>
            </div>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(42, 125, 123, 0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--teal)', flexShrink: 0
            }}>
              <CheckCircle size={20} />
            </div>
          </div>

          {/* Card 4: Upload Relevé (Compact) */}
          <div style={{
            background: 'linear-gradient(135deg, white 0%, var(--cream-light) 100%)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 16,
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
            onMouseEnter={e => {
              e.currentTarget.style.boxShadow = 'var(--shadow-md)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
            onClick={() => {
              const i = document.createElement('input'); 
              i.type = 'file'; 
              i.accept = '.pdf,.jpg,.jpeg,.png,.webp'; 
              i.onchange = (e) => { 
                const f = (e.target as HTMLInputElement).files?.[0]; 
                if (f) handleUpload(f); 
              }; 
              i.click(); 
            }}
          >
            {uploading ? (
              <>
                <div className="spinner" style={{ width: 24, height: 24, marginBottom: 8 }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>IA en cours...</div>
              </>
            ) : (
              <>
                <Upload size={22} style={{ color: 'var(--teal)', marginBottom: 6 }} />
                <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--teal)' }}>Importer relevé</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>PDF, JPG ou PNG</div>
              </>
            )}
          </div>
        </div>

        {/* Bulk Actions Banner */}
        {selectedIds.size > 0 && (
          <div style={{
            background: 'var(--teal-bg)',
            border: '1.5px solid var(--teal)',
            borderRadius: 16,
            padding: '12px 20px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            boxShadow: 'var(--shadow-md)',
            position: 'sticky',
            top: 10,
            zIndex: 10
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                fontSize: 14,
                fontWeight: 800,
                color: 'var(--teal-dark)',
                background: 'white',
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)'
              }}>
                {selectedIds.size} sélectionnée{selectedIds.size > 1 ? 's' : ''}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedIds(new Set())}
                style={{ fontSize: 13, color: 'var(--text-muted)' }}
              >
                Désélectionner tout
              </button>
            </div>
            
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {/* Bulk Status Select */}
              <select
                className="form-select"
                style={{ padding: '6px 12px', fontSize: 13, fontWeight: 700, width: 'auto', background: 'white' }}
                onChange={e => { handleBulkStatusChange(e.target.value); e.target.value = ''; }}
              >
                <option value="">Modifier le statut en lot...</option>
                <option value="pending_invoice">🚨 Facture manquante</option>
                <option value="facture_ok">👍 Facture OK</option>
                <option value="reconciled">✅ Facture liée (Compta)</option>
                <option value="ignored"> Ignoré</option>
              </select>

              {/* Bulk Class Select */}
              <select
                className="form-select"
                style={{ padding: '6px 12px', fontSize: 13, fontWeight: 700, width: 'auto', background: 'white' }}
                onChange={e => { handleBulkClassChange(e.target.value); e.target.value = ''; }}
              >
                <option value="">Modifier la classe en lot...</option>
                {ACCOUNTING_CLASSES.map(ac => (
                  <option key={ac.code} value={ac.code}>{ac.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="filter-bar" style={{ marginBottom: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
          <Filter size={18} style={{ color: 'var(--text-muted)' }} />
          <select className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            <option value="pending_invoice">Facture Manquante (À lettrer)</option>
            <option value="facture_ok">Facture OK (Non comptabilisée)</option>
            <option value="reconciled">Facture liée (Comptabilisée)</option>
            <option value="ignored">Ignoré (Pas de facture requise)</option>
          </select>
        </div>

        {/* Transactions Table / List */}
        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : filteredTransactions.length === 0 ? (
          <div className="empty-state"><Landmark size={48} /><p>Aucune transaction bancaire trouvée.</p></div>
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="card desktop-only-table">
              <div className="card-header">
                <div className="card-title">Flux bancaires ({filteredTransactions.length})</div>
              </div>
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>
                        <input
                          type="checkbox"
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                          checked={filteredTransactions.length > 0 && filteredTransactions.every(t => selectedIds.has(t.id))}
                          onChange={toggleSelectAll}
                        />
                      </th>
                      <th>Date</th>
                      <th>Libellé de l'opération</th>
                      <th>Catégorie IA</th>
                      <th>Classement Comptable (France)</th>
                      <th>Réf. Facture</th>
                      <th style={{ textAlign: 'right' }}>Montant</th>
                      <th>Statut (Action)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTransactions.map(t => {
                      const displayRef = t.mouvements_cca && t.mouvements_cca.length > 0
                        ? `CCA - ${t.mouvements_cca[0].associe === 'justine' ? 'Justine' : 'Yohan'}`
                        : (t.invoice?.accounting_ref || t.invoice?.invoice_number || 'Aucune');
                      return (
                        <React.Fragment key={t.id}>
                          <tr>
                          <td>
                            <input
                              type="checkbox"
                              style={{ width: 16, height: 16, cursor: 'pointer' }}
                              checked={selectedIds.has(t.id)}
                              onChange={() => toggleSelect(t.id)}
                            />
                          </td>
                          <td>{formatDate(t.date)}</td>
                          <td style={{ fontWeight: 500, fontSize: 13, paddingTop: 12, paddingBottom: 12 }}>
                             <div>{t.description}</div>
                             {t.status === 'pending_invoice' && t.amount < 0 && (() => {
                               const desc = t.description?.toLowerCase() || '';
                               const isJustine = desc.includes('justine');
                               const isYohan = desc.includes('yohan');
                               if (!isJustine && !isYohan) return null;
                               const partner = isJustine ? 'justine' : 'yohan';
                               const partnerName = partner === 'justine' ? 'Justine' : 'Yohan';
                               const balance = ccaBalances[partner];
                               const reimbursementAmount = Math.abs(t.amount);
                               const hasSufficientBalance = balance >= reimbursementAmount;
                               return (
                                 <div style={{ marginTop: 6 }}>
                                   <button
                                     onClick={() => handleCreateCcaReimbursementAuto(t, partner)}
                                     style={{
                                       display: 'inline-flex',
                                       alignItems: 'center',
                                       gap: 4,
                                       padding: '3px 8px',
                                       borderRadius: 6,
                                       background: hasSufficientBalance ? 'rgba(99, 102, 241, 0.08)' : 'rgba(217, 119, 6, 0.08)',
                                       border: hasSufficientBalance ? '1.5px dashed rgba(99, 102, 241, 0.4)' : '1.5px dashed rgba(217, 119, 6, 0.4)',
                                       color: hasSufficientBalance ? 'var(--primary)' : '#D97706',
                                       fontSize: 10,
                                       fontWeight: 700,
                                       cursor: 'pointer',
                                       transition: 'all 0.12s',
                                     }}
                                     onMouseEnter={e => {
                                       e.currentTarget.style.background = hasSufficientBalance ? 'rgba(99, 102, 241, 0.15)' : 'rgba(217, 119, 6, 0.15)';
                                       e.currentTarget.style.borderColor = hasSufficientBalance ? 'rgba(99, 102, 241, 0.7)' : 'rgba(217, 119, 6, 0.7)';
                                     }}
                                     onMouseLeave={e => {
                                       e.currentTarget.style.background = hasSufficientBalance ? 'rgba(99, 102, 241, 0.08)' : 'rgba(217, 119, 6, 0.08)';
                                       e.currentTarget.style.borderColor = hasSufficientBalance ? 'rgba(99, 102, 241, 0.4)' : 'rgba(217, 119, 6, 0.4)';
                                     }}
                                   >
                                     {hasSufficientBalance ? (
                                       <>
                                         <span>💡 Suggestion : Remboursement CCA {partnerName}</span>
                                         <span style={{ fontSize: 8.5, background: 'rgba(99, 102, 241, 0.18)', padding: '0px 4px', borderRadius: 4, fontWeight: 800 }}>Valider</span>
                                       </>
                                     ) : (
                                       <>
                                         <span>⚠️ Suggestion : Remboursement CCA {partnerName} (Solde CCA insuffisant : {formatCurrency(balance)})</span>
                                       </>
                                     )}
                                   </button>
                                 </div>
                               );
                             })()}
                             {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (() => {
                               const suggestions = getSuggestionsForTransaction(t, unlinkedInvoices);
                               if (suggestions.length === 0) return null;
                               return (
                                 <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                   <span style={{ fontSize: 10, color: '#B45309', display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 700 }}>
                                     💡 Rapprocher avec :
                                   </span>
                                   {suggestions.map(({ invoice: inv, score }) => (
                                     <button
                                       key={inv.id}
                                       onClick={() => handleLinkInvoiceDirect(t.id, inv)}
                                       title={`Rapprocher avec la facture de ${inv.supplier?.name || 'Inconnu'} du ${formatDate(inv.date)} - Score: ${score}`}
                                       style={{
                                         display: 'inline-flex',
                                         alignItems: 'center',
                                         gap: 4,
                                         padding: '2px 8px',
                                         borderRadius: 6,
                                         background: 'rgba(232, 155, 62, 0.08)',
                                         border: '1.5px dashed rgba(232, 155, 62, 0.4)',
                                         color: '#B45309',
                                         fontSize: 10,
                                         fontWeight: 700,
                                         cursor: 'pointer',
                                         transition: 'all 0.12s',
                                       }}
                                       onMouseEnter={e => {
                                         e.currentTarget.style.background = 'rgba(232, 155, 62, 0.15)';
                                         e.currentTarget.style.borderColor = 'rgba(232, 155, 62, 0.7)';
                                       }}
                                       onMouseLeave={e => {
                                         e.currentTarget.style.background = 'rgba(232, 155, 62, 0.08)';
                                         e.currentTarget.style.borderColor = 'rgba(232, 155, 62, 0.4)';
                                       }}
                                     >
                                       <span>{inv.supplier?.name || 'Facture'} ({formatCurrency(inv.total_ttc)})</span>
                                       <span style={{ fontSize: 8.5, background: 'rgba(232, 155, 62, 0.18)', padding: '0px 4px', borderRadius: 4, fontWeight: 800 }}>
                                         {score >= 100 ? 'Sûr' : 'Probable'}
                                       </span>
                                     </button>
                                   ))}
                                 </div>
                               );
                             })()}
                           </td>
                          <td>
                            <span className="badge badge-autre" style={{ background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                              {CATEGORIES[t.category] || t.category}
                            </span>
                          </td>
                          <td>
                            <select
                              className="account-select"
                              value={t.accounting_class || 'autre'}
                              onChange={e => updateAccountingClass(t.id, e.target.value)}
                            >
                              <option value="">Sélectionner...</option>
                              {ACCOUNTING_CLASSES.map(ac => (
                                <option key={ac.code} value={ac.code}>{ac.label}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)' }}>
                            {displayRef}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: t.amount < 0 ? 'var(--red)' : 'var(--green)' }}>
                            {formatCurrency(t.amount)}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <select
                                className="inline-select"
                                style={{
                                  fontWeight: 600,
                                  color: t.status === 'pending_invoice' ? 'var(--orange)' : t.status === 'reconciled' ? 'var(--green)' : t.status === 'facture_ok' ? 'var(--teal)' : 'var(--text-muted)'
                                }}
                                value={t.status}
                                onChange={e => updateStatus(t.id, e.target.value)}
                              >
                                <option value="pending_invoice">🚨 Facture manquante</option>
                                <option value="facture_ok">👍 Facture OK</option>
                                <option value="reconciled">✅ Facture liée (Compta)</option>
                                <option value="ignored"> Ignoré</option>
                              </select>
                              
                              {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (
                                <button 
                                  className="btn btn-secondary btn-sm" 
                                  title="Joindre la facture (PDF ou Photo)"
                                  onClick={() => {
                                    const i = document.createElement('input'); 
                                    i.type = 'file'; 
                                    i.accept = '.pdf,image/*'; 
                                    i.onchange = (e) => { 
                                      const f = (e.target as HTMLInputElement).files?.[0]; 
                                      if (f) handleLinkInvoice(t, f); 
                                    }; 
                                    i.click(); 
                                  }}
                                >
                                  <Upload size={14} />
                                </button>
                              )}

                              {t.status === 'pending_invoice' && (
                                <button 
                                  className="btn btn-secondary btn-sm" 
                                  title="Scinder la transaction en plusieurs montants"
                                  onClick={() => {
                                    if (splitTxId === t.id) {
                                      setSplitTxId(null);
                                    } else {
                                      setSplitTxId(t.id);
                                      setSplitAmounts(['', '']);
                                    }
                                  }}
                                  style={{
                                    borderColor: splitTxId === t.id ? 'var(--teal)' : undefined,
                                    background: splitTxId === t.id ? 'var(--teal-bg)' : undefined,
                                    color: splitTxId === t.id ? 'var(--teal)' : undefined,
                                  }}
                                >
                                  <Scissors size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {splitTxId === t.id && (
                          <tr style={{ background: 'var(--cream-light)' }}>
                            <td colSpan={8} style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Scissors size={15} style={{ color: 'var(--teal)' }} />
                                    Scinder la transaction bancaire de <strong style={{ color: 'var(--red)' }}>{formatCurrency(Math.abs(t.amount))}</strong>
                                  </div>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) < 0.01 ? 'var(--green)' : 'var(--orange)' }}>
                                    Saisi : {formatCurrency(splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0))} | 
                                    Reste : {formatCurrency(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0))}
                                  </div>
                                </div>
                                
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {splitAmounts.map((amount, idx) => (
                                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60, fontWeight: 600 }}>Partie {idx + 1}</span>
                                      <div style={{ position: 'relative', flex: 1, maxWidth: 180 }}>
                                        <input
                                          type="number"
                                          step="0.01"
                                          className="form-input"
                                          placeholder="0.00"
                                          value={amount}
                                          onChange={e => {
                                            const newAmounts = [...splitAmounts];
                                            newAmounts[idx] = e.target.value;
                                            setSplitAmounts(newAmounts);
                                          }}
                                          style={{ paddingLeft: 20, fontSize: 12, height: 32 }}
                                        />
                                        <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-muted)' }}>€</span>
                                      </div>
                                      
                                      {splitAmounts.length > 2 && (
                                        <button
                                          className="btn btn-ghost btn-sm"
                                          onClick={() => setSplitAmounts(splitAmounts.filter((_, i) => i !== idx))}
                                          style={{ color: '#DC2626', padding: 6 }}
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                                
                                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => setSplitAmounts([...splitAmounts, ''])}
                                    style={{ display: 'flex', alignItems: 'center', gap: 4, height: 32, fontSize: 11.5, fontWeight: 700 }}
                                  >
                                    <Plus size={14} /> Ajouter une partie
                                  </button>
                                  <button
                                    className="btn btn-sm"
                                    disabled={Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) >= 0.01}
                                    onClick={() => handleSplitTransaction(t)}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 4, height: 32, fontSize: 11.5, fontWeight: 700,
                                      background: Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) < 0.01 ? 'var(--teal)' : 'var(--border)',
                                      color: 'white',
                                      border: 'none',
                                      cursor: 'pointer'
                                    }}
                                  >
                                    Valider la scission
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                      setSplitTxId(null);
                                      setSplitAmounts(['', '']);
                                    }}
                                    style={{ height: 32, fontSize: 11.5, color: 'var(--text-muted)' }}
                                  >
                                    Annuler
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile Card List View */}
            <div className="mobile-card-list">
              {filteredTransactions.map(t => {
                const displayRef = t.mouvements_cca && t.mouvements_cca.length > 0
                  ? `CCA - ${t.mouvements_cca[0].associe === 'justine' ? 'Justine' : 'Yohan'}`
                  : (t.invoice?.accounting_ref || t.invoice?.invoice_number || 'Aucune');
                return (
                  <div key={t.id} className="mobile-card">
                    <div className="mobile-card-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input
                          type="checkbox"
                          style={{ width: 20, height: 20, cursor: 'pointer' }}
                          checked={selectedIds.has(t.id)}
                          onChange={() => toggleSelect(t.id)}
                        />
                        <span className="mobile-card-date">{formatDate(t.date)}</span>
                      </div>
                      <span className="mobile-card-amount" style={{ color: t.amount < 0 ? 'var(--red)' : 'var(--green)' }}>
                        {formatCurrency(t.amount)}
                      </span>
                    </div>

                    <div className="mobile-card-desc" style={{ marginBottom: 4 }}>
                       <div>{t.description}</div>
                       {t.status === 'pending_invoice' && t.amount < 0 && (() => {
                         const desc = t.description?.toLowerCase() || '';
                         const isJustine = desc.includes('justine');
                         const isYohan = desc.includes('yohan');
                         if (!isJustine && !isYohan) return null;
                         const partner = isJustine ? 'justine' : 'yohan';
                         const partnerName = partner === 'justine' ? 'Justine' : 'Yohan';
                          const balance = ccaBalances[partner];
                          const reimbursementAmount = Math.abs(t.amount);
                          const hasSufficientBalance = balance >= reimbursementAmount;
                          return (
                            <div style={{ marginTop: 6 }}>
                              <button
                                onClick={() => handleCreateCcaReimbursementAuto(t, partner)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '4px 10px',
                                  borderRadius: 8,
                                  background: hasSufficientBalance ? 'rgba(99, 102, 241, 0.08)' : 'rgba(217, 119, 6, 0.08)',
                                  border: hasSufficientBalance ? '1.5px dashed rgba(99, 102, 241, 0.4)' : '1.5px dashed rgba(217, 119, 6, 0.4)',
                                  color: hasSufficientBalance ? 'var(--primary)' : '#D97706',
                                  fontSize: 10.5,
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  width: '100%',
                                  justifyContent: 'center'
                                }}
                              >
                                {hasSufficientBalance ? (
                                  <span>💡 Suggestion : Remboursement CCA {partnerName} (Valider)</span>
                                ) : (
                                  <span>⚠️ Remboursement CCA {partnerName} (Solde insuffisant : {formatCurrency(balance)})</span>
                                )}
                              </button>
                            </div>
                          );
                        })()}
                       {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (() => {
                         const suggestions = getSuggestionsForTransaction(t, unlinkedInvoices);
                         if (suggestions.length === 0) return null;
                         return (
                           <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                             <span style={{ fontSize: 10, color: '#B45309', display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 700 }}>
                               💡 Rapprocher avec :
                             </span>
                             {suggestions.map(({ invoice: inv, score }) => (
                               <button
                                 key={inv.id}
                                 onClick={() => handleLinkInvoiceDirect(t.id, inv)}
                                 title={`Rapprocher avec la facture de ${inv.supplier?.name || 'Inconnu'} du ${formatDate(inv.date)} - Score: ${score}`}
                                 style={{
                                   display: 'inline-flex',
                                   alignItems: 'center',
                                   gap: 4,
                                   padding: '2px 8px',
                                   borderRadius: 6,
                                   background: 'rgba(232, 155, 62, 0.08)',
                                   border: '1.5px dashed rgba(232, 155, 62, 0.4)',
                                   color: '#B45309',
                                   fontSize: 10,
                                   fontWeight: 700,
                                   cursor: 'pointer',
                                   transition: 'all 0.12s',
                                 }}
                                 onMouseEnter={e => {
                                   e.currentTarget.style.background = 'rgba(232, 155, 62, 0.15)';
                                   e.currentTarget.style.borderColor = 'rgba(232, 155, 62, 0.7)';
                                 }}
                                 onMouseLeave={e => {
                                   e.currentTarget.style.background = 'rgba(232, 155, 62, 0.08)';
                                   e.currentTarget.style.borderColor = 'rgba(232, 155, 62, 0.4)';
                                 }}
                               >
                                 <span>{inv.supplier?.name || 'Facture'} ({formatCurrency(inv.total_ttc)})</span>
                                 <span style={{ fontSize: 8.5, background: 'rgba(232, 155, 62, 0.18)', padding: '0px 4px', borderRadius: 4, fontWeight: 800 }}>
                                   {score >= 100 ? 'Sûr' : 'Probable'}
                                 </span>
                               </button>
                             ))}
                           </div>
                         );
                       })()}
                     </div>

                    {/* Inline Split Form for Mobile */}
                    {splitTxId === t.id && (
                      <div style={{
                        marginTop: 10,
                        padding: 12,
                        borderRadius: 12,
                        background: 'var(--cream-light)',
                        border: '1px solid var(--border-light)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10
                      }}>
                        <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Scissors size={14} style={{ color: 'var(--teal)' }} />
                          Scinder la transaction : <strong style={{ color: 'var(--red)' }}>{formatCurrency(Math.abs(t.amount))}</strong>
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) < 0.01 ? 'var(--green)' : 'var(--orange)' }}>
                          Saisi : {formatCurrency(splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0))} | 
                          Reste : {formatCurrency(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0))}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {splitAmounts.map((amount, idx) => (
                            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', width: 50, fontWeight: 600 }}>Part {idx + 1}</span>
                              <div style={{ position: 'relative', flex: 1 }}>
                                <input
                                  type="number"
                                  step="0.01"
                                  className="mobile-select-full"
                                  placeholder="0.00"
                                  value={amount}
                                  onChange={e => {
                                    const newAmounts = [...splitAmounts];
                                    newAmounts[idx] = e.target.value;
                                    setSplitAmounts(newAmounts);
                                  }}
                                  style={{ paddingLeft: 20, fontSize: 12, height: 32, width: '100%' }}
                                />
                                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-muted)' }}>€</span>
                              </div>
                              {splitAmounts.length > 2 && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setSplitAmounts(splitAmounts.filter((_, i) => i !== idx))}
                                  style={{ color: '#DC2626', padding: 6 }}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>

                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          <button
                            className="mobile-action-btn-full"
                            style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontSize: 11.5, padding: '6px 8px' }}
                            onClick={() => setSplitAmounts([...splitAmounts, ''])}
                          >
                            <Plus size={12} /> Ajouter
                          </button>
                          <button
                            className="mobile-action-btn-full"
                            disabled={Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) >= 0.01}
                            style={{
                              background: Math.abs(Math.abs(t.amount) - splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0)) < 0.01 ? 'var(--teal)' : 'var(--border)',
                              color: 'white',
                              fontSize: 11.5,
                              padding: '6px 8px'
                            }}
                            onClick={() => handleSplitTransaction(t)}
                          >
                            Valider
                          </button>
                          <button
                            className="mobile-action-btn-full"
                            style={{ background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', fontSize: 11.5, padding: '6px 8px' }}
                            onClick={() => {
                              setSplitTxId(null);
                              setSplitAmounts(['', '']);
                            }}
                          >
                            Annuler
                          </button>
                        </div>
                      </div>
                    )}

                     <div className="mobile-card-row">
                      <span className="mobile-card-label">Catégorie IA:</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {CATEGORIES[t.category] || t.category}
                      </span>
                    </div>

                    <div className="mobile-card-row">
                      <span className="mobile-card-label">Réf. Facture:</span>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {displayRef}
                      </span>
                    </div>

                    <div style={{ marginTop: 4 }}>
                      <span className="mobile-card-label" style={{ display: 'block', marginBottom: 4 }}>Compte Comptable (Restauration) :</span>
                      <select
                        className="mobile-select-full"
                        value={t.accounting_class || 'autre'}
                        onChange={e => updateAccountingClass(t.id, e.target.value)}
                      >
                        <option value="">Sélectionner...</option>
                        {ACCOUNTING_CLASSES.map(ac => (
                          <option key={ac.code} value={ac.code}>{ac.label}</option>
                        ))}
                      </select>
                    </div>

                    <div style={{ marginTop: 4 }}>
                      <span className="mobile-card-label" style={{ display: 'block', marginBottom: 4 }}>Statut :</span>
                      <select
                        className="mobile-select-full"
                        style={{
                          fontWeight: 700,
                          color: t.status === 'pending_invoice' ? 'var(--orange)' : t.status === 'reconciled' ? 'var(--green)' : t.status === 'facture_ok' ? 'var(--teal)' : 'var(--text-muted)'
                        }}
                        value={t.status}
                        onChange={e => updateStatus(t.id, e.target.value)}
                      >
                        <option value="pending_invoice">🚨 Facture manquante</option>
                        <option value="facture_ok">👍 Facture OK</option>
                        <option value="reconciled">✅ Facture liée (Compta)</option>
                        <option value="ignored"> Ignoré</option>
                      </select>
                    </div>

                    {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (
                      <div className="mobile-actions">
                        <button
                          className="mobile-action-btn-full"
                          style={{ background: 'var(--teal)', color: 'white' }}
                          onClick={() => {
                            const i = document.createElement('input'); 
                            i.type = 'file'; 
                            i.accept = 'image/*'; 
                            i.capture = 'environment'; // Triggers back camera on mobile
                            i.onchange = (e) => { 
                              const f = (e.target as HTMLInputElement).files?.[0]; 
                              if (f) handleLinkInvoice(t, f); 
                            }; 
                            i.click(); 
                          }}
                        >
                          <Camera size={16} />
                          Prendre une photo
                        </button>
                        
                        <button
                          className="mobile-action-btn-full"
                          style={{ background: 'var(--surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                          onClick={() => {
                            const i = document.createElement('input'); 
                            i.type = 'file'; 
                            i.accept = '.pdf,image/*'; 
                            i.onchange = (e) => { 
                              const f = (e.target as HTMLInputElement).files?.[0]; 
                              if (f) handleLinkInvoice(t, f); 
                            }; 
                            i.click(); 
                          }}
                        >
                          <Upload size={16} />
                          Importer fichier
                        </button>

                        {t.status === 'pending_invoice' && (
                          <button
                            className="mobile-action-btn-full"
                            style={{
                              background: splitTxId === t.id ? 'var(--teal-bg)' : 'var(--surface)',
                              color: splitTxId === t.id ? 'var(--teal)' : 'var(--text-primary)',
                              border: splitTxId === t.id ? '1px solid var(--teal)' : '1px solid var(--border)',
                              fontWeight: 700
                            }}
                            onClick={() => {
                              if (splitTxId === t.id) {
                                setSplitTxId(null);
                              } else {
                                setSplitTxId(t.id);
                                setSplitAmounts(['', '']);
                              }
                            }}
                          >
                            <Scissors size={14} />
                            Scinder
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
