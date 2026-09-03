'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate } from '@/lib/utils';
import { KpiCard } from '@/components/ui';
import { suggestInvoicesForTransaction, sumDebits } from '@/lib/reconciliation';
import { checkCcaOperation, describeCcaViolation } from '@/lib/cca';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { Upload, Landmark, AlertCircle, CheckCircle, Filter, ScanLine, Scissors, Plus, Trash2 } from 'lucide-react';

const CATEGORIES: Record<string, string> = {
  fixe_loyer: 'Loyer & Charges',
  fixe_assurance: 'Assurances',
  fixe_abonnement: 'Abonnements & honoraires',
  variable_fournisseur: 'Fournisseurs',
  variable_salaire: 'Salaires',
  impot_taxe: 'Impôts & Taxes',
  recette: 'Recette Ventes',
  investissement: 'Équipement & travaux',
  flux_financier: 'Hors exploitation',
  autre: 'Non classé'
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

// Ouvre un sélecteur de fichier natif et transmet le fichier choisi
function pickFile(accept: string, onPick: (file: File) => void, capture?: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  if (capture) input.capture = capture;
  input.onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) onPick(f);
  };
  input.click();
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
  const [ccaMovements, setCcaMovements] = useState<any[]>([]);
  const [recategorizing, setRecategorizing] = useState(false);

  /** Solde du compte courant d'un associé à une date donnée (incluse). */
  const ccaBalanceAt = useCallback((partner: 'justine' | 'yohan', date: string) =>
    ccaMovements
      .filter(m => m.associe === partner && String(m.date) <= date)
      .reduce((s, m) => s + (m.sens === 'apport' ? Number(m.montant) : -Number(m.montant)), 0),
  [ccaMovements]);

  const supabase = createClient();

  const router = useRouter();

  const loadData = useCallback(async () => {
    setLoading(true);

    // Requêtes indépendantes lancées en parallèle
    // Les deux premières lectures sont paginées : Supabase tronque à 1 000
    // lignes sans le signaler, et un historique bancaire les dépasse vite.
    const [invoiceRows, txList, settingsRes, movementsRes] = await Promise.all([
      fetchAllRows<any>((f0, f1) => supabase
        .from('invoices')
        .select('*, supplier:suppliers(*)')
        .order('date', { ascending: false })
        .range(f0, f1)),
      fetchAllRows<any>((f0, f1) => supabase
        .from('bank_transactions')
        .select('*, invoice:invoices(accounting_ref, invoice_number), mouvements_cca(associe)')
        .order('date', { ascending: false })
        .range(f0, f1)),
      supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'transaction_classifications')
        .limit(1),
      supabase
        .from('mouvements_cca')
        .select('associe, sens, montant, date'),
    ]);

    setInvoices(invoiceRows);


    // Surcouche : classifications enregistrées dans app_settings
    try {
      const settingsData = settingsRes.data;
      if (settingsData && settingsData.length > 0 && settingsData[0].value) {
        const classifications = JSON.parse(settingsData[0].value);
        txList.forEach((t: any) => {
          if (!t.accounting_class && classifications[t.id]) {
            t.accounting_class = classifications[t.id];
          }
        });
      }
    } catch (e) {
      console.warn('Could not load saved classifications:', e);
    }

    // Soldes CCA par associé, avec les dates : le bouton de suggestion doit
    // annoncer le solde À LA DATE du mouvement, pas le solde final — sinon il
    // affiche « solde suffisant » pour un remboursement d'avril couvert par un
    // apport de juin.
    setCcaMovements(movementsRes.data || []);

    setTransactions(txList);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  /**
   * Réapplique les règles de reconnaissance aux dépenses restées en « autre ».
   *
   * Déroulé en deux temps : la route est d'abord appelée en simulation, on
   * montre exactement ce qui changerait, et on n'écrit qu'après accord. Une
   * reclassification en masse touche le food cost et la TVA : elle ne doit
   * jamais se produire sans que l'utilisateur ait vu le détail.
   */
  const handleRecategorize = async () => {
    setRecategorizing(true);
    try {
      const preview = await fetch('/api/bank/recategorize?dryRun=1', { method: 'POST' });
      const plan = await preview.json();
      if (!preview.ok) throw new Error(plan.error || 'Analyse impossible');

      if (!plan.proposed) {
        alert(
          `Aucune reclassification possible.\n\n`
          + `${plan.examined} dépense(s) sans catégorie ont été examinées : aucune ne correspond `
          + `à une règle connue. Il faut les classer à la main — ou me dire de quels `
          + `fournisseurs il s'agit pour que je les ajoute aux règles.`
        );
        return;
      }

      const detail = Object.entries(plan.byCategory as Record<string, { count: number; amount: number }>)
        .sort((a, b) => b[1].amount - a[1].amount)
        .map(([cat, v]) => `  • ${CATEGORIES[cat] || cat} : ${v.count} ligne(s), ${formatCurrency(v.amount)}`)
        .join('\n');

      const ok = confirm(
        `${plan.proposed} dépense(s) peuvent être reclassées :\n\n${detail}\n\n`
        + `Seules les lignes actuellement en « Autre » ou sans catégorie sont touchées — `
        + `une catégorie que tu as choisie à la main n'est jamais écrasée, et chaque ligne `
        + `reste modifiable ensuite.\n\nAppliquer ?`
      );
      if (!ok) return;

      const res = await fetch('/api/bank/recategorize', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Reclassification impossible');

      alert(
        `${result.updated} dépense(s) reclassée(s).`
        + (result.failures ? `\n\nÉchecs :\n${result.failures.join('\n')}` : '')
        + `\n\nLe coût matières du P&L en tient compte immédiatement.`
      );
      await loadData();
    } catch (e: any) {
      alert(`Reclassification impossible : ${e.message}`);
    } finally {
      setRecategorizing(false);
    }
  };

  // Lit le stockage clé/valeur app_settings, mute les classifications, puis upsert
  const saveClassificationOverride = async (ids: string[], accountingClass: string) => {
    const { data: existingRow } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'transaction_classifications')
      .limit(1);

    const classifications: Record<string, string> = existingRow && existingRow.length > 0 && existingRow[0].value
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
  };

  const handleUpload = async (file: File) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    const isPDF = file.type === 'application/pdf' || name.endsWith('.pdf');
    const isCSV = file.type === 'text/csv' || name.endsWith('.csv');

    if (!isPDF && !isCSV) {
      alert('Veuillez uploader un relevé au format PDF ou CSV.');
      return;
    }

    setUploading(true);

    const sendToApi = async (body: { pdfBase64: string } | { csvText: string }) => {
      try {
        const res = await fetch('/api/bank/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        if (data.success) {
          alert(`Import réussi : ${data.count} nouvelles transactions ajoutées.`);
          loadData();
        } else {
          alert('Erreur extraction : ' + (data.error || 'Inconnu'));
        }
      } catch {
        alert('Erreur lors de l\'upload');
      } finally {
        setUploading(false);
      }
    };

    const reader = new FileReader();
    reader.onerror = () => {
      setUploading(false);
      alert('Erreur de lecture du fichier.');
    };

    if (isCSV) {
      reader.onload = () => sendToApi({ csvText: reader.result as string });
      reader.readAsText(file);
    } else {
      reader.onload = () => sendToApi({ pdfBase64: (reader.result as string).split(',')[1] });
      reader.readAsDataURL(file);
    }
  };

  const updateStatus = async (id: string, status: string) => {
    await supabase.from('bank_transactions').update({ status }).eq('id', id);
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, status } : t));
  };

  const updateAccountingClass = async (id: string, accountingClass: string) => {
    // Optimistic update
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, accounting_class: accountingClass } : t));

    const { error } = await supabase
      .from('bank_transactions')
      .update({ accounting_class: accountingClass })
      .eq('id', id);

    if (error) {
      try {
        await saveClassificationOverride([id], accountingClass);
      } catch (saveError) {
        console.error('Classification save failed:', saveError);
        alert("Impossible d'enregistrer la classification comptable.");
      }
    }
  };

  /**
   * Joindre une facture à ce mouvement = l'analyser dans le Scanner, avec le
   * mouvement pré-sélectionné. L'ancien chemin enregistrait la facture sans
   * relecture, en un clic : le Scanner, lui, montre ce que l'IA a lu et exige
   * une confirmation sur chaque point inhabituel avant d'écrire en base.
   */
  const openScannerFor = (transaction: any) => {
    router.push(`/scanner?bank_tx=${encodeURIComponent(transaction.id)}`);
  };

  const handleLinkInvoiceDirect = async (transactionId: string, invoice: any) => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from('bank_transactions')
        .update({
          status: 'reconciled',
          invoice_id: invoice.id,
          accounting_class: invoice.accounting_class || '601',
        })
        .eq('id', transactionId);

      if (error) throw error;

      // Update the invoice payment method to 'bank'
      await supabase
        .from('invoices')
        .update({ payment_method: 'bank' })
        .eq('id', invoice.id);

      alert(`Facture de ${invoice.supplier?.name || 'fournisseur'} liée avec succès.`);
      await loadData();
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
      await loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la scission de la transaction.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCcaReimbursementAuto = async (tx: any, partner: 'justine' | 'yohan') => {
    setLoading(true);
    try {
      // 1. Le compte tient-il, à partir de la date du remboursement ?
      //
      // On recalcule le solde courant sur TOUS les mouvements de l'associé,
      // pas seulement ceux antérieurs : un remboursement daté d'avril peut
      // rendre le compte débiteur en mai, quand un remboursement déjà saisi
      // s'ajoute au sien. La base refusera de toute façon (trigger) ; on le
      // dit avant, avec la date et le montant, et sans « enregistrer quand
      // même » — la règle n'est pas négociable au clic.
      const { data: movements, error: fetchErr } = await supabase
        .from('mouvements_cca')
        .select('id, date, associe, sens, montant, created_at')
        .eq('associe', partner);

      if (fetchErr) throw fetchErr;

      const reimbursementAmount = Math.abs(tx.amount);
      const violation = checkCcaOperation(movements || [], {
        type: 'insert',
        movement: { date: tx.date, associe: partner, sens: 'remboursement', montant: reimbursementAmount },
      });
      if (violation) {
        alert(describeCcaViolation(violation));
        setLoading(false);
        return;
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
      await loadData();
    } catch (e) {
      console.error(e);
      alert((e as { message?: string })?.message || "Erreur lors de la création du remboursement.");
    } finally {
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
      try {
        await saveClassificationOverride(ids, accountingClass);
      } catch (e) {
        console.error('Bulk classification save failed:', e);
      }
    }

    setSelectedIds(new Set());
    alert(`${ids.length} classifications mises à jour.`);
    setLoading(false);
  };

  const toggleSplit = (t: any) => {
    if (splitTxId === t.id) {
      setSplitTxId(null);
    } else {
      setSplitTxId(t.id);
      setSplitAmounts(['', '']);
    }
  };

  const cancelSplit = () => {
    setSplitTxId(null);
    setSplitAmounts(['', '']);
  };

  // ─── KPIs ─────────────────────────────────────────────────────────────────
  // Ces trois cartes parlent de FACTURES : seuls les décaissements sont
  // concernés, un encaissement n'a pas de facture fournisseur à retrouver.
  //
  // Elles sommaient auparavant les montants signés, puis affichaient la valeur
  // absolue du résultat. Les encaissements Square annulaient donc les achats :
  // 21 000 € de dépenses en attente s'affichaient « 250,91 € ». On additionne
  // maintenant des valeurs absolues, sur les débits uniquement — rien ne peut
  // plus se compenser.
  const debits = transactions.filter(t => (t.amount || 0) < 0);

  const pendingDebits = debits.filter(t => t.status === 'pending_invoice');
  const pendingCount = pendingDebits.length;
  const pendingAmount = sumDebits(pendingDebits);

  const reconciledDebits = debits.filter(t => t.status === 'reconciled');
  const reconciledCount = reconciledDebits.length;
  const reconciledAmount = sumDebits(reconciledDebits);

  const okDebits = debits.filter(t => t.status === 'facture_ok');
  const okCount = okDebits.length;
  const okAmount = sumDebits(okDebits);

  // Dépenses restées sans catégorie : elles atterrissent dans « autres
  // charges » et sortent donc du coût matières. Le bouton de réapplication
  // des règles ne s'affiche que s'il y a quelque chose à réappliquer.
  const unclassifiedDebits = debits.filter(t => !t.category || t.category === 'autre');

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

  // ─── Blocs de rendu partagés desktop / mobile ──────────────────────────────

  const getDisplayRef = (t: any): string =>
    t.mouvements_cca && t.mouvements_cca.length > 0
      ? `CCA - ${t.mouvements_cca[0].associe === 'justine' ? 'Justine' : 'Yohan'}`
      : (t.invoice?.accounting_ref || t.invoice?.invoice_number || 'Aucune');

  const renderCcaSuggestion = (t: any, mobile = false) => {
    if (t.status !== 'pending_invoice' || t.amount >= 0) return null;
    const desc = t.description?.toLowerCase() || '';
    const isJustine = desc.includes('justine');
    const isYohan = desc.includes('yohan');
    if (!isJustine && !isYohan) return null;
    const partner: 'justine' | 'yohan' = isJustine ? 'justine' : 'yohan';
    const partnerName = partner === 'justine' ? 'Justine' : 'Yohan';
    const balance = ccaBalanceAt(partner, t.date);
    const reimbursementAmount = Math.abs(t.amount);
    const hasSufficientBalance = balance >= reimbursementAmount;
    const baseBg = hasSufficientBalance ? 'rgba(99, 102, 241, 0.08)' : 'rgba(217, 119, 6, 0.08)';
    const baseBorderColor = hasSufficientBalance ? 'rgba(99, 102, 241, 0.4)' : 'rgba(217, 119, 6, 0.4)';
    const hoverBg = hasSufficientBalance ? 'rgba(99, 102, 241, 0.15)' : 'rgba(217, 119, 6, 0.15)';
    const hoverBorderColor = hasSufficientBalance ? 'rgba(99, 102, 241, 0.7)' : 'rgba(217, 119, 6, 0.7)';
    return (
      <div style={{ marginTop: 6 }}>
        <button
          onClick={() => handleCreateCcaReimbursementAuto(t, partner)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: mobile ? '4px 10px' : '3px 8px',
            borderRadius: mobile ? 8 : 6,
            background: baseBg,
            border: `1.5px dashed ${baseBorderColor}`,
            color: hasSufficientBalance ? 'var(--primary)' : '#D97706',
            fontSize: mobile ? 10.5 : 10,
            fontWeight: 700,
            cursor: 'pointer',
            ...(mobile
              ? { width: '100%', justifyContent: 'center' }
              : { transition: 'all 0.12s' }),
          }}
          onMouseEnter={mobile ? undefined : e => {
            e.currentTarget.style.background = hoverBg;
            e.currentTarget.style.borderColor = hoverBorderColor;
          }}
          onMouseLeave={mobile ? undefined : e => {
            e.currentTarget.style.background = baseBg;
            e.currentTarget.style.borderColor = baseBorderColor;
          }}
        >
          {mobile ? (
            hasSufficientBalance ? (
              <span>💡 Suggestion : Remboursement CCA {partnerName} (Valider)</span>
            ) : (
              <span>⚠️ Remboursement CCA {partnerName} (Solde insuffisant : {formatCurrency(balance)})</span>
            )
          ) : hasSufficientBalance ? (
            <>
              <span>💡 Suggestion : Remboursement CCA {partnerName}</span>
              <span style={{ fontSize: 8.5, background: 'rgba(99, 102, 241, 0.18)', padding: '0px 4px', borderRadius: 4, fontWeight: 800 }}>Valider</span>
            </>
          ) : (
            <span>⚠️ Suggestion : Remboursement CCA {partnerName} (Solde CCA insuffisant : {formatCurrency(balance)})</span>
          )}
        </button>
      </div>
    );
  };

  const renderInvoiceSuggestions = (t: any) => {
    if (t.status !== 'pending_invoice' && t.status !== 'facture_ok') return null;
    const suggestions = suggestInvoicesForTransaction(t, unlinkedInvoices);
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
  };

  const renderClassSelect = (t: any, mobile = false) => (
    <select
      className={mobile ? 'mobile-select-full' : 'account-select'}
      value={t.accounting_class || 'autre'}
      onChange={e => updateAccountingClass(t.id, e.target.value)}
    >
      <option value="">Sélectionner...</option>
      {ACCOUNTING_CLASSES.map(ac => (
        <option key={ac.code} value={ac.code}>{ac.label}</option>
      ))}
    </select>
  );

  const renderStatusSelect = (t: any, mobile = false) => (
    <select
      className={mobile ? 'mobile-select-full' : 'inline-select'}
      style={{
        fontWeight: mobile ? 700 : 600,
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
  );

  const renderSplitForm = (t: any, mobile = false) => {
    const splitSum = splitAmounts.reduce((sum, val) => sum + (parseFloat(val) || 0), 0);
    const txAbs = Math.abs(t.amount);
    const balanced = Math.abs(txAbs - splitSum) < 0.01;

    const summary = (
      <div style={{ fontSize: 11, fontWeight: 700, color: balanced ? 'var(--green)' : 'var(--orange)' }}>
        Saisi : {formatCurrency(splitSum)} | Reste : {formatCurrency(txAbs - splitSum)}
      </div>
    );

    const rows = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {splitAmounts.map((amount, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: mobile ? 6 : 8 }}>
            <span style={{ fontSize: mobile ? 10.5 : 11, color: 'var(--text-muted)', width: mobile ? 50 : 60, fontWeight: 600 }}>
              {mobile ? 'Part' : 'Partie'} {idx + 1}
            </span>
            <div style={{ position: 'relative', flex: 1, ...(mobile ? {} : { maxWidth: 180 }) }}>
              <input
                type="number"
                step="0.01"
                className={mobile ? 'mobile-select-full' : 'form-input'}
                placeholder="0.00"
                value={amount}
                onChange={e => {
                  const newAmounts = [...splitAmounts];
                  newAmounts[idx] = e.target.value;
                  setSplitAmounts(newAmounts);
                }}
                style={{ paddingLeft: 20, fontSize: 12, height: 32, ...(mobile ? { width: '100%' } : {}) }}
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
    );

    if (mobile) {
      return (
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
            Scinder la transaction : <strong style={{ color: 'var(--red)' }}>{formatCurrency(txAbs)}</strong>
          </div>
          {summary}
          {rows}
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
              disabled={!balanced}
              style={{
                background: balanced ? 'var(--teal)' : 'var(--border)',
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
              onClick={cancelSplit}
            >
              Annuler
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 'min(600px, 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Scissors size={15} style={{ color: 'var(--teal)' }} />
            Scinder la transaction bancaire de <strong style={{ color: 'var(--red)' }}>{formatCurrency(txAbs)}</strong>
          </div>
          {summary}
        </div>
        {rows}
        <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setSplitAmounts([...splitAmounts, ''])}
            style={{ display: 'flex', alignItems: 'center', gap: 4, height: 32, fontSize: 11.5, fontWeight: 700 }}
          >
            <Plus size={14} /> Ajouter une partie
          </button>
          <button
            className="btn btn-sm"
            disabled={!balanced}
            onClick={() => handleSplitTransaction(t)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, height: 32, fontSize: 11.5, fontWeight: 700,
              background: balanced ? 'var(--teal)' : 'var(--border)',
              color: 'white',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Valider la scission
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={cancelSplit}
            style={{ height: 32, fontSize: 11.5, color: 'var(--text-muted)' }}
          >
            Annuler
          </button>
        </div>
      </div>
    );
  };

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
        <div className="kpi-grid-auto">
          <KpiCard
            label="Factures Manquantes"
            value={formatCurrency(pendingAmount)}
            subValue={`${pendingCount} dépense${pendingCount > 1 ? 's' : ''} à lettrer`}
            icon={<AlertCircle size={20} />}
            accentColor="#E89B3E"
          />
          <KpiCard
            label="Factures Associées"
            value={formatCurrency(reconciledAmount)}
            subValue={`${reconciledCount} transaction${reconciledCount > 1 ? 's' : ''} lettrée${reconciledCount > 1 ? 's' : ''}`}
            icon={<CheckCircle size={20} />}
            accentColor="#2D8F5E"
          />
          <KpiCard
            label="Factures Validées (OK)"
            value={formatCurrency(okAmount)}
            subValue={`${okCount} transaction${okCount > 1 ? 's' : ''} validée${okCount > 1 ? 's' : ''}`}
            icon={<CheckCircle size={20} />}
            accentColor="#2A7D7B"
          />

          {/* Carte 4 : Importer relevé (cliquable) */}
          <div
            className="kpi-v2"
            style={{
              background: 'linear-gradient(135deg, white 0%, var(--cream-light) 100%)',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              cursor: 'pointer',
            }}
            onClick={() => pickFile('.pdf,.csv', handleUpload)}
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
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>PDF ou CSV</div>
              </>
            )}
          </div>
        </div>

        {/* Dépenses non classées : elles quittent le coût matières en silence.
            La table de règles s'enrichit avec le temps, mais une règle ajoutée
            ne vaut que pour les imports futurs — d'où cette réapplication. */}
        {unclassifiedDebits.length > 0 && (
          <div
            className="alert alert-warning"
            style={{ marginBottom: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 240 }}>
              <strong>
                {unclassifiedDebits.length} dépense{unclassifiedDebits.length > 1 ? 's' : ''} sans
                catégorie ({formatCurrency(sumDebits(unclassifiedDebits))})
              </strong>
              <div style={{ marginTop: 2, fontWeight: 500 }}>
                Sans catégorie, une dépense atterrit dans « autres charges » : elle sort du coût
                matières et le food cost s&apos;en trouve faussé. La reconnaissance automatique
                peut en reclasser une partie.
              </div>
            </div>
            <button
              className="btn btn-sm"
              onClick={handleRecategorize}
              disabled={recategorizing}
              style={{ background: '#9A6B1F', color: 'white', borderColor: '#9A6B1F', flexShrink: 0 }}
            >
              {recategorizing ? 'Analyse…' : 'Reclasser automatiquement'}
            </button>
          </div>
        )}

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
        <div className="filter-bar" style={{ marginBottom: 24 }}>
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
                    {filteredTransactions.map(t => (
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
                            {renderCcaSuggestion(t)}
                            {renderInvoiceSuggestions(t)}
                          </td>
                          <td>
                            <span className="badge badge-autre" style={{ background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                              {CATEGORIES[t.category] || t.category}
                            </span>
                          </td>
                          <td>
                            {renderClassSelect(t)}
                          </td>
                          <td style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)' }}>
                            {getDisplayRef(t)}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: t.amount < 0 ? 'var(--red)' : 'var(--green)' }}>
                            {formatCurrency(t.amount)}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              {renderStatusSelect(t)}

                              {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (
                                <button
                                  className="btn btn-secondary btn-sm"
                                  title="Joindre la facture : l'analyser dans le Scanner, ce mouvement pré-sélectionné"
                                  onClick={() => openScannerFor(t)}
                                >
                                  <ScanLine size={14} />
                                </button>
                              )}

                              {t.status === 'pending_invoice' && (
                                <button
                                  className="btn btn-secondary btn-sm"
                                  title="Scinder la transaction en plusieurs montants"
                                  onClick={() => toggleSplit(t)}
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
                              {renderSplitForm(t)}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile Card List View */}
            <div className="mobile-card-list">
              {filteredTransactions.map(t => (
                <div key={t.id} className="mobile-card">
                  <div className="mobile-card-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
                    {renderCcaSuggestion(t, true)}
                    {renderInvoiceSuggestions(t)}
                  </div>

                  {/* Inline Split Form for Mobile */}
                  {splitTxId === t.id && renderSplitForm(t, true)}

                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Catégorie IA:</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {CATEGORIES[t.category] || t.category}
                    </span>
                  </div>

                  <div className="mobile-card-row">
                    <span className="mobile-card-label">Réf. Facture:</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {getDisplayRef(t)}
                    </span>
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <span className="mobile-card-label" style={{ display: 'block', marginBottom: 4 }}>Compte Comptable (Restauration) :</span>
                    {renderClassSelect(t, true)}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <span className="mobile-card-label" style={{ display: 'block', marginBottom: 4 }}>Statut :</span>
                    {renderStatusSelect(t, true)}
                  </div>

                  {(t.status === 'pending_invoice' || t.status === 'facture_ok') && (
                    <div className="mobile-actions">
                      <button
                        className="mobile-action-btn-full"
                        style={{ background: 'var(--teal)', color: 'white' }}
                        onClick={() => openScannerFor(t)}
                      >
                        <ScanLine size={16} />
                        Joindre la facture (Scanner)
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
                          onClick={() => toggleSplit(t)}
                        >
                          <Scissors size={14} />
                          Scinder
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
