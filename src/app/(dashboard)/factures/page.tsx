'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatDate, toISODate, CATEGORY_LABELS, downloadCSV } from '@/lib/utils';
import Link from 'next/link';
import { ScanLine, FileText, Filter, Download, Search, Paperclip, Banknote, CreditCard, Link2, X, Info, ArrowRight, Trash2, CheckCircle, Check, Loader2, Clock } from 'lucide-react';
import type { Invoice, Supplier, InvoiceLine } from '@/lib/types';
import ClaudeStatusIndicator from '@/components/ClaudeStatusIndicator';

// Formatage de date tolérant : renvoie '' si la date est nulle ou invalide
function safeDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  const parsed = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(parsed.getTime())) return '';
  return formatDate(parsed);
}

const ACCOUNTING_LABELS: Record<string, string> = {
  '601': 'Matières Premières',
  '607': 'Marchandises Boissons',
  '606': 'Fournitures Emballages',
  '6061':'Énergie Électricité Eau',
  '61':  'Services extérieurs',
  '62':  'Autres services',
  '63':  'Impôts Taxes',
  '64':  'Personnel Salaires',
  'autre':'Autre',
};

// Panneau secondaire de choix de règlement (Espèces / CB Perso)
// tint : composantes RGB « r, g, b » utilisées pour le fond et la bordure
function PaymentSubPanel({ title, tint, titleColor, children }: { title: string; tint: string; titleColor: string; children: ReactNode }) {
  return (
    <div style={{
      marginTop: 10,
      padding: 12,
      background: `rgba(${tint}, 0.05)`,
      border: `1.5px dashed rgba(${tint}, 0.3)`,
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: titleColor, display: 'flex', alignItems: 'center', gap: 4 }}>
        <Info size={12} /> {title}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

// Heuristic scoring helper to match invoices with bank transactions
function getSuggestionsForInvoice(invoice: any, txList: any[]) {
  if (!invoice) return [];
  return txList
    .map(tx => {
      let score = 0;
      const txAbsAmount = Math.abs(tx.amount);
      const invTtc = invoice.total_ttc;
      
      // Heuristic 1: Amount match
      const amountDiff = Math.abs(txAbsAmount - invTtc);
      if (amountDiff < 0.01) {
        score += 100;
      } else if (amountDiff < 1.00) {
        score += 50;
      }
      
      // Heuristic 2: Date proximity
      const txDate = new Date(tx.date);
      const invDate = new Date(invoice.date);
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
      const supplierName = invoice.supplier?.name?.toLowerCase() || '';
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
      
      return { tx, score };
    })
    .filter(item => item.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function renderAttachmentLinks(pdfUrl: string | null) {
  if (!pdfUrl) return <span style={{ color: 'var(--border)', fontSize: 11 }}>—</span>;
  
  let urls: string[] = [];
  if (pdfUrl.trim().startsWith('[')) {
    try {
      urls = JSON.parse(pdfUrl);
    } catch {
      urls = [pdfUrl];
    }
  } else {
    urls = [pdfUrl];
  }

  if (urls.length === 0) return <span style={{ color: 'var(--border)', fontSize: 11 }}>—</span>;

  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
      {urls.map((url, index) => (
        <a
          key={index}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={urls.length > 1 ? `Page ${index + 1}` : "Voir / télécharger la pièce jointe"}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, borderRadius: 6,
            background: 'rgba(42,125,123,.1)', color: 'var(--teal)',
            border: '1px solid rgba(42,125,123,.25)',
            fontSize: 10, fontWeight: 700,
            transition: 'all .15s',
            cursor: 'pointer'
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(42,125,123,.2)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(42,125,123,.1)'; }}
        >
          {urls.length > 1 ? String(index + 1) : <Paperclip size={12} />}
        </a>
      ))}
    </div>
  );
}

export default function FacturesPage() {
  const [invoices, setInvoices] = useState<(Invoice & { supplier?: Supplier, accounting_ref?: string, payment_method?: string, accounting_class?: string })[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);

  // Reconciliation states
  const [linkedTx, setLinkedTx] = useState<any>(null);
  const [bankTxList, setBankTxList] = useState<any[]>([]);
  const [bankTxLoaded, setBankTxLoaded] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [reconciling, setReconciling] = useState(false);
  const [showManualSelector, setShowManualSelector] = useState(false);
  const [showCcaSelector, setShowCcaSelector] = useState(false);
  const [showCashSelector, setShowCashSelector] = useState(false);
  const [linkedCcaAssocie, setLinkedCcaAssocie] = useState<'justine' | 'yohan' | null>(null);
  
  // Delete state
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Filters
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterDateStart, setFilterDateStart] = useState('');
  const [filterDateEnd, setFilterDateEnd] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: inv } = await supabase
      .from('invoices')
      .select('*, supplier:suppliers(*)')
      .order('date', { ascending: false });
    setInvoices(inv || []);

    const { data: sup } = await supabase.from('suppliers').select('*').order('name');
    setSuppliers(sup || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadData(); }, [loadData]);

  const loadLines = async (invoiceId: string) => {
    setSelectedInvoice(invoiceId);
    setConfirmDelete(false);
    
    // Fetch lines
    const { data: linesData } = await supabase
      .from('invoice_lines')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at');
    setLines(linesData || []);

    // Fetch linked bank transaction
    const { data: txData } = await supabase
      .from('bank_transactions')
      .select('*')
      .eq('invoice_id', invoiceId)
      .limit(1);
    
    if (txData && txData.length > 0) {
      setLinkedTx(txData[0]);
    } else {
      setLinkedTx(null);
    }

    // Fetch linked CCA movement if exists
    setLinkedCcaAssocie(null);
    setShowManualSelector(false);
    setShowCcaSelector(false);
    setShowCashSelector(false);
    try {
      const { data: ccaMv } = await supabase
        .from('mouvements_cca')
        .select('associe')
        .eq('invoice_id', invoiceId)
        .limit(1);
      if (ccaMv && ccaMv.length > 0) {
        setLinkedCcaAssocie(ccaMv[0].associe as any);
      }
    } catch (e) {
      console.warn("Could not load linked CCA associate:", e);
    }

    // Lazy load bank transactions if not loaded yet
    if (!bankTxLoaded) {
      const { data: allTx } = await supabase
        .from('bank_transactions')
        .select('*')
        .in('status', ['pending_invoice', 'facture_ok'])
        .order('date', { ascending: false })
        .limit(100);
      setBankTxList(allTx || []);
      setBankTxLoaded(true);
    }
  };

  const handleReconcile = async (pm: 'bank' | 'cash' | 'card_perso', bankTxId: string | null, associe?: 'justine' | 'yohan') => {
    if (!selectedInvoice) return;
    setReconciling(true);
    try {
      // 1. If there was a previously linked transaction, release it!
      if (linkedTx) {
        await supabase
          .from('bank_transactions')
          .update({ status: 'pending_invoice', invoice_id: null })
          .eq('id', linkedTx.id);
      }

      // Clean up any existing CCA movement linked to this invoice
      await supabase
        .from('mouvements_cca')
        .delete()
        .eq('invoice_id', selectedInvoice);

      // 2. Update the invoice payment method
      const selectedInvObj = invoices.find(inv => inv.id === selectedInvoice);
      await supabase
        .from('invoices')
        .update({ payment_method: pm })
        .eq('id', selectedInvoice);

      // 3. If linking to a new bank transaction, update it
      let newLinkedTx = null;
      if (pm === 'bank' && bankTxId) {
        const { data: updatedTx } = await supabase
          .from('bank_transactions')
          .update({
            status: 'reconciled',
            invoice_id: selectedInvoice,
            accounting_class: selectedInvObj?.accounting_class || '601',
          })
          .eq('id', bankTxId)
          .select()
          .single();
        newLinkedTx = updatedTx;
      }

      // 4. Create CCA movement if payment method is CB Perso or Cash Perso, and associate is specified
      if ((pm === 'card_perso' || (pm === 'cash' && associe)) && associe && selectedInvObj) {
        const { error: ccaErr } = await supabase
          .from('mouvements_cca')
          .insert({
            date: selectedInvObj.date || toISODate(new Date()),
            associe: associe,
            sens: 'apport',
            sous_type: 'facture_payee_perso',
            montant: selectedInvObj.total_ttc || selectedInvObj.total_ht || 0,
            piece_justif: selectedInvObj.pdf_url,
            note: `Règlement ${pm === 'cash' ? 'espèces ' : ''}facture ${selectedInvObj.invoice_number || ''} (${selectedInvObj.supplier?.name || 'Inconnu'})`,
            rapproche_banque: false,
            invoice_id: selectedInvoice
          });
        if (ccaErr) throw ccaErr;
      }

      // Update local states
      setLinkedTx(newLinkedTx);
      setLinkedCcaAssocie(associe || null);
      setInvoices(prev => prev.map(inv => inv.id === selectedInvoice ? { ...inv, payment_method: pm } : inv));
      setShowManualSelector(false);
      setShowCcaSelector(false);
      setShowCashSelector(false);

      // Refresh list of pending bank transactions
      const { data: allTx } = await supabase
        .from('bank_transactions')
        .select('*')
        .in('status', ['pending_invoice', 'facture_ok'])
        .order('date', { ascending: false })
        .limit(100);
      setBankTxList(allTx || []);

      alert('Règlement mis à jour avec succès.');
    } catch (e) {
      console.error(e);
      alert('Erreur lors de la mise à jour du règlement.');
    } finally {
      setReconciling(false);
    }
  };

  const handleDeleteInvoice = async () => {
    if (!selectedInvoice) return;

    try {
      // 1. Release any linked transaction first
      if (linkedTx) {
        await supabase
          .from('bank_transactions')
          .update({ status: 'pending_invoice', invoice_id: null })
          .eq('id', linkedTx.id);
      }

      // 2. Delete the invoice (lines are deleted by cascade in DB)
      const { error } = await supabase
        .from('invoices')
        .delete()
        .eq('id', selectedInvoice);

      if (error) throw error;

      alert('Facture supprimée avec succès.');
      
      // Reset states
      setSelectedInvoice(null);
      setLines([]);
      setLinkedTx(null);
      setConfirmDelete(false);
      
      // Reload invoices list
      loadData();
    } catch (e) {
      console.error(e);
      alert('Erreur lors de la suppression de la facture.');
    }
  };

  const updateCategory = async (lineId: string, category: string) => {
    await supabase.from('invoice_lines').update({ category }).eq('id', lineId);
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, category: category as InvoiceLine['category'] } : l));
  };

  const filteredInvoices = invoices.filter(inv => {
    if (filterSupplier && inv.supplier_id !== filterSupplier) return false;
    if (filterDateStart && inv.date < filterDateStart) return false;
    if (filterDateEnd && inv.date > filterDateEnd) return false;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();

      // 1. Match Fournisseur
      const matchSupplier = inv.supplier?.name?.toLowerCase().includes(query);

      // 2. Match Références
      const matchRef = inv.accounting_ref?.toLowerCase().includes(query) ||
                       inv.invoice_number?.toLowerCase().includes(query);

      // 3. Match Catégorie comptable
      const classCode = inv.accounting_class || '';
      const classLabel = ACCOUNTING_LABELS[classCode] || '';
      const matchCategory = classCode.includes(query) ||
                            classLabel.toLowerCase().includes(query);

      // 4. Match Montant : uniquement si la requête est entièrement numérique
      let matchAmount = false;
      if (/^\d+([.,]\d+)?$/.test(query)) {
        const queryAsNum = parseFloat(query.replace(',', '.'));
        const normalizedQuery = query.replace(',', '.');

        // Correspondance sur la chaîne formatée complète (évite que « 1 » matche tout)
        if (String(inv.total_ttc ?? '') === normalizedQuery || String(inv.total_ht ?? '') === normalizedQuery) {
          matchAmount = true;
        }
        // Ecart proche (±2 €) pour les montants saisis précisément (ex: taper "812.84")
        const diffTtc = Math.abs((inv.total_ttc || 0) - queryAsNum);
        const diffHt = Math.abs((inv.total_ht || 0) - queryAsNum);
        if (diffTtc <= 2.00 || diffHt <= 2.00) {
          matchAmount = true;
        }
      }

      // 5. Match Date
      const matchDate = inv.date?.includes(query) || safeDate(inv.date).includes(query);

      return matchSupplier || matchRef || matchCategory || matchAmount || matchDate;
    }

    return true;
  });

  const selectedInvObj = invoices.find(inv => inv.id === selectedInvoice);
  const invoiceSuggestions = selectedInvObj ? getSuggestionsForInvoice(selectedInvObj, bankTxList) : [];

  // Liste des transactions bancaires filtrées par la recherche du sélecteur manuel
  const filteredBankTx = bankTxList.filter(tx => {
    if (!txSearch) return true;
    const s = txSearch.toLowerCase();
    return tx.description?.toLowerCase().includes(s) || String(Math.abs(tx.amount)).includes(s);
  });

  // Configuration des 4 boutons de mode de règlement
  const isBankOrUnset = selectedInvObj ? (selectedInvObj.payment_method === 'bank' || !selectedInvObj.payment_method) : false;
  const paymentModeButtons = [
    {
      key: 'a_pointer',
      label: 'À pointer',
      icon: <Clock size={13} />,
      activeColor: '#E89B3E',
      isActive: isBankOrUnset && !linkedTx,
      onClick: () => { handleReconcile('bank', null); setShowManualSelector(false); },
    },
    {
      key: 'banque',
      label: 'Banque',
      icon: <Link2 size={13} />,
      activeColor: 'var(--teal)',
      isActive: isBankOrUnset && !!linkedTx,
      onClick: () => {
        if (!linkedTx) {
          setShowManualSelector(true);
        }
      },
    },
    {
      key: 'especes',
      label: 'Espèces',
      icon: <Banknote size={13} />,
      activeColor: 'var(--green)',
      isActive: selectedInvObj?.payment_method === 'cash',
      onClick: () => {
        setShowCashSelector(!showCashSelector);
        setShowCcaSelector(false);
      },
    },
    {
      key: 'cb_perso',
      label: 'CB Perso',
      icon: <CreditCard size={13} />,
      activeColor: '#7C3AED',
      isActive: selectedInvObj?.payment_method === 'card_perso',
      onClick: () => {
        setShowCcaSelector(!showCcaSelector);
        setShowCashSelector(false);
      },
    },
  ];

  const exportCSV = () => {
    const data = filteredInvoices.map(inv => ({
      Date: safeDate(inv.date),
      Fournisseur: inv.supplier?.name || '',
      'N° Facture': inv.invoice_number || '',
      'Réf. Interne': inv.accounting_ref || '',
      'Total HT': inv.total_ht,
      'Total TTC': inv.total_ttc,
    }));
    downloadCSV(data, 'factures-qentina');
  };

  return (
    <>
      <div className="page-header">
        <h2>Factures d'Achats</h2>
        <div className="page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ClaudeStatusIndicator />
          <button className="btn btn-secondary btn-sm" onClick={exportCSV}><Download size={16} /> CSV</button>
        </div>
      </div>
      <div className="page-body">
        {/* Toute facture passe par le Scanner : les données lues par l'IA y
            sont relues et les points inhabituels confirmés avant d'entrer en
            base. L'import direct depuis cette page enregistrait sans relecture
            et lettrait au premier montant approchant. */}
        <Link
          href="/scanner"
          className="dropzone"
          style={{ marginBottom: 24, display: 'block', textDecoration: 'none', color: 'inherit' }}
        >
          <ScanLine size={40} style={{ color: 'var(--teal)', marginBottom: 12 }} />
          <div className="dropzone-text">Ajouter une facture : ouvrir le Scanner</div>
          <div className="dropzone-hint">
            Lecture par l&apos;IA, relecture des points douteux, puis rapprochement bancaire — rien n&apos;entre en base sans ton accord.
          </div>
        </Link>

        {/* Filters */}
        <div className="filter-bar">
          <Filter size={18} style={{ color: 'var(--text-muted)' }} />
          
          {/* Moteur de recherche intelligent */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', minWidth: 'min(280px, 80vw)', flexGrow: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 12, color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              type="text"
              className="form-input"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Rechercher montant, fournisseur, n°..."
              style={{
                paddingLeft: 36,
                paddingRight: searchQuery ? 30 : 12,
                width: '100%',
                borderRadius: 8,
                border: '1px solid var(--border)',
                outline: 'none',
                transition: 'all 0.15s ease',
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: 10,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <select className="form-select" value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}>
            <option value="">Tous les fournisseurs</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="date" className="form-input" value={filterDateStart} onChange={e => setFilterDateStart(e.target.value)} placeholder="Début" />
          <input type="date" className="form-input" value={filterDateEnd} onChange={e => setFilterDateEnd(e.target.value)} placeholder="Fin" />
          {(filterSupplier || filterDateStart || filterDateEnd || searchQuery) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setFilterSupplier(''); setFilterDateStart(''); setFilterDateEnd(''); setSearchQuery(''); }}>
              Réinitialiser
            </button>
          )}
        </div>

        {/* Search Results Count */}
        {searchQuery.trim() && (
          <div style={{
            fontSize: 12,
            fontWeight: 800,
            color: 'var(--teal)',
            marginBottom: 16,
            background: 'rgba(42, 125, 123, 0.05)',
            border: '1px solid rgba(42, 125, 123, 0.15)',
            borderRadius: 8,
            padding: '8px 12px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6
          }}>
            <span>🔍</span> {filteredInvoices.length} facture{filteredInvoices.length > 1 ? 's' : ''} correspond{filteredInvoices.length > 1 ? 'ent' : 'e'} à votre recherche
          </div>
        )}

        {/* Invoices Table */}
        {loading ? (
          <div className="loading-page"><div className="spinner" style={{ width: 32, height: 32 }} /></div>
        ) : filteredInvoices.length === 0 ? (
          <div className="empty-state"><FileText size={48} /><p>Aucune facture. Uploadez votre premier PDF ou image !</p></div>
        ) : (
          <div className="table-container" style={{ marginBottom: 24 }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Fournisseur</th>
                  <th>N° Facture</th>
                  <th>Réf. Comptable</th>
                  <th>Total HT</th>
                  <th>Total TTC</th>
                  <th style={{ textAlign: 'center' }}>Fichier</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map(inv => (
                  <tr key={inv.id} onClick={() => loadLines(inv.id)} style={{ cursor: 'pointer', background: selectedInvoice === inv.id ? 'var(--teal-bg)' : undefined }}>
                    <td>{safeDate(inv.date)}</td>
                    <td style={{ fontWeight: 600 }}>{inv.supplier?.name || '—'}</td>
                    <td>{inv.invoice_number || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: 'var(--text-secondary)' }}>
                      {(inv as any).accounting_ref || '—'}
                    </td>
                    <td>{formatCurrency(inv.total_ht)}</td>
                    <td>{formatCurrency(inv.total_ttc)}</td>
                    {/* Attached file */}
                    <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                      {renderAttachmentLinks((inv as any).pdf_url)}
                    </td>
                    <td><Search size={16} style={{ color: 'var(--text-muted)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Invoice Detail & Reconciliation Drawer */}
        {selectedInvoice && selectedInvObj && (
          <div className="card" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
            {/* Header */}
            <div className="card-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'linear-gradient(135deg, var(--teal), var(--teal-dark))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white',
                }}>
                  <FileText size={18} />
                </div>
                <div>
                  <div className="card-title" style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>
                    Facture : {selectedInvObj.accounting_ref || 'Sans référence'}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {selectedInvObj.supplier?.name || 'Inconnu'} · {safeDate(selectedInvObj.date)}
                  </span>
                </div>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {/* Delete button with confirmation */}
                {confirmDelete ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(220, 38, 38, 0.08)', padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(220, 38, 38, 0.2)', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: '#DC2626', fontWeight: 600 }}>Supprimer définitivement ?</span>
                    <button className="btn btn-danger btn-sm" onClick={handleDeleteInvoice} style={{ padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, background: '#DC2626', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                      Oui, supprimer
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)} style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Annuler
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)} style={{ color: '#DC2626', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid rgba(220, 38, 38, 0.2)', padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: 'none' }}>
                    <Trash2 size={13} /> Supprimer
                  </button>
                )}
                
                <button className="btn btn-ghost btn-sm" style={{ border: '1px solid var(--border)', padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: 'none' }} onClick={() => { setSelectedInvoice(null); setLines([]); setConfirmDelete(false); }}>
                  Fermer
                </button>
              </div>
            </div>

            {/* Content Body */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 20, padding: 20 }}>
              
              {/* Left Column: Settlement & Reconciliation */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ border: '1px solid var(--border-light)', borderRadius: 12, padding: 16, background: 'var(--cream-light)' }}>
                  <h4 style={{ margin: '0 0 12px 0', fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Mode de Règlement & Pointage
                  </h4>

                  {/* Payment Method Selector Buttons */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                    {paymentModeButtons.map(btn => (
                      <button
                        key={btn.key}
                        className="btn"
                        disabled={reconciling}
                        onClick={btn.onClick}
                        style={{
                          flex: '1 1 90px', fontSize: 11, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          background: btn.isActive ? btn.activeColor : 'white',
                          color: btn.isActive ? 'white' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                          fontWeight: 600,
                        }}
                      >
                        {btn.icon} {btn.label}
                      </button>
                    ))}
                  </div>

                  {showCashSelector && (
                    <PaymentSubPanel title="Quel type de règlement en espèces ?" tint="45, 143, 94" titleColor="var(--green)">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            handleReconcile('cash', null);
                            setShowCashSelector(false);
                          }}
                          style={{ flex: '1 1 120px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: 'var(--green)', borderColor: 'rgba(45,143,94,0.3)', cursor: 'pointer', background: 'white' }}
                        >
                          Espèces Entreprise
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            handleReconcile('cash', null, 'justine');
                            setShowCashSelector(false);
                          }}
                          style={{ flex: '1 1 90px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#EC4899', borderColor: 'rgba(236,72,153,0.3)', cursor: 'pointer', background: 'white' }}
                        >
                          Justine
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            handleReconcile('cash', null, 'yohan');
                            setShowCashSelector(false);
                          }}
                          style={{ flex: '1 1 90px', justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#3B82F6', borderColor: 'rgba(59,130,246,0.3)', cursor: 'pointer', background: 'white' }}
                        >
                          Yohan
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setShowCashSelector(false)}
                          style={{ fontSize: 11, color: 'var(--text-muted)' }}
                        >
                          Annuler
                        </button>
                    </PaymentSubPanel>
                  )}

                  {showCcaSelector && (
                    <PaymentSubPanel title="Qui a réglé cette facture ?" tint="124, 58, 237" titleColor="#7C3AED">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            handleReconcile('card_perso', null, 'justine');
                            setShowCcaSelector(false);
                          }}
                          style={{ flex: 1, justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#EC4899', borderColor: 'rgba(236,72,153,0.3)' }}
                        >
                          Justine
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            handleReconcile('card_perso', null, 'yohan');
                            setShowCcaSelector(false);
                          }}
                          style={{ flex: 1, justifyContent: 'center', fontSize: 11, fontWeight: 750, color: '#3B82F6', borderColor: 'rgba(59,130,246,0.3)' }}
                        >
                          Yohan
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setShowCcaSelector(false)}
                          style={{ fontSize: 11, color: 'var(--text-muted)' }}
                        >
                          Annuler
                        </button>
                    </PaymentSubPanel>
                  )}

                  {/* Dynamic Status / Actions based on selection */}
                  {reconciling ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Mise à jour en cours...
                    </div>
                  ) : (selectedInvObj.payment_method === 'bank' || !selectedInvObj.payment_method) ? (
                    <div>
                      {linkedTx ? (
                        <div style={{ background: 'rgba(45,143,94,0.06)', border: '1.5px solid rgba(45,143,94,0.25)', borderRadius: 10, padding: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--green)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <CheckCircle size={13} /> Rapprochée avec succès
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{linkedTx.description}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {safeDate(linkedTx.date)} · <strong style={{ color: 'var(--red)' }}>{formatCurrency(linkedTx.amount)}</strong>
                          </div>
                          
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleReconcile('bank', null)}
                            style={{ width: '100%', border: '1px solid rgba(220,38,38,0.2)', color: '#DC2626', fontSize: 11, padding: '6px', marginTop: 10, justifyContent: 'center', display: 'flex', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                          >
                            Délier la transaction
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div style={{ background: 'rgba(232,155,62,0.06)', border: '1px solid rgba(232,155,62,0.25)', borderRadius: 10, padding: 12, fontSize: 11, color: '#B45309', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.4 }}>
                            <Info size={14} style={{ flexShrink: 0 }} /> Facture en attente de rapprochement bancaire
                          </div>

                          {/* Encart de suggestions de rapprochement */}
                          {invoiceSuggestions.length > 0 && (
                            <div style={{ marginBottom: 12 }}>
                              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span>💡 Suggestions de pointage</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {invoiceSuggestions.map(({ tx, score }) => (
                                  <div
                                    key={tx.id}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      padding: '8px 12px',
                                      borderRadius: 10,
                                      background: 'rgba(42, 125, 123, 0.04)',
                                      border: '1.5px dashed rgba(42, 125, 123, 0.3)',
                                      fontSize: 11.5,
                                    }}
                                  >
                                    <div style={{ minWidth: 0, flex: 1, marginRight: 8 }}>
                                      <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {tx.description}
                                      </div>
                                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                                        {safeDate(tx.date)} · <strong style={{ color: 'var(--red)' }}>{formatCurrency(tx.amount)}</strong>
                                      </div>
                                    </div>
                                    <button
                                      className="btn"
                                      disabled={reconciling}
                                      onClick={() => handleReconcile('bank', tx.id)}
                                      style={{
                                        padding: '4px 8px',
                                        fontSize: 10.5,
                                        borderRadius: 6,
                                        background: 'var(--teal)',
                                        color: 'white',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 3,
                                      }}
                                    >
                                      <Check size={11} /> Lier
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          
                          {!showManualSelector ? (
                            <button
                              className="btn btn-secondary btn-sm"
                              style={{ width: '100%', justifyContent: 'center', display: 'flex', padding: '8px 12px', fontSize: 12, borderRadius: 8, cursor: 'pointer' }}
                              onClick={() => setShowManualSelector(true)}
                            >
                              Lier à une transaction bancaire
                            </button>
                          ) : (
                            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'white' }}>
                              <div style={{ padding: 8, borderBottom: '1px solid var(--border-light)', background: 'var(--cream-light)' }}>
                                <div style={{ position: 'relative' }}>
                                  <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                                  <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Filtrer montant ou libellé..."
                                    value={txSearch}
                                    onChange={e => setTxSearch(e.target.value)}
                                    style={{ fontSize: 11, padding: '5px 8px 5px 24px', height: 'auto', width: '100%', border: '1px solid var(--border)', borderRadius: 6 }}
                                  />
                                </div>
                              </div>
                              <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                                {filteredBankTx.length === 0 ? (
                                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                                    Aucune transaction en attente
                                  </div>
                                ) : (
                                  filteredBankTx.map(tx => (
                                    <div
                                      key={tx.id}
                                      onClick={() => handleReconcile('bank', tx.id)}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
                                        cursor: 'pointer', borderBottom: '1px solid var(--border-light)',
                                        fontSize: 11, transition: 'background 0.12s',
                                      }}
                                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(42,125,123,0.05)')}
                                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                    >
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.description}</div>
                                        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{safeDate(tx.date)}</span>
                                      </div>
                                      <span style={{ fontWeight: 700, color: 'var(--red)', flexShrink: 0 }}>{formatCurrency(tx.amount)}</span>
                                      <ArrowRight size={11} style={{ color: 'var(--teal)' }} />
                                    </div>
                                  ))
                                )}
                              </div>
                              <div style={{ padding: 6, borderTop: '1px solid var(--border-light)', display: 'flex', justifyContent: 'flex-end', background: 'var(--cream-light)' }}>
                                <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', fontSize: 10, cursor: 'pointer', border: 'none', background: 'none' }} onClick={() => setShowManualSelector(false)}>
                                  Fermer la liste
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : selectedInvObj.payment_method === 'cash' ? (
                    <div style={{ background: 'rgba(45,143,94,0.06)', border: '1.5px solid rgba(45,143,94,0.25)', borderRadius: 10, padding: 12, fontSize: 12, color: '#1A5C38', lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Banknote size={14} /> Réglé en espèces {linkedCcaAssocie ? `personnelles (${linkedCcaAssocie.charAt(0).toUpperCase() + linkedCcaAssocie.slice(1)})` : 'entreprise'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                        {linkedCcaAssocie ? (
                          <>
                            Facture payée en espèces personnelles par l'associé.
                            <div style={{ fontSize: 10.5, color: '#2D8F5E', marginTop: 4, fontWeight: 700 }}>
                              ✓ Un apport automatique a été enregistré dans son compte associé (CCA).
                            </div>
                          </>
                        ) : (
                          "Facture payée en liquide (caisse entreprise). Comptabilisée directement dans votre P&L sans rapprochement de transaction bancaire requis."
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ background: 'rgba(124,58,237,0.06)', border: '1.5px solid rgba(124,58,237,0.25)', borderRadius: 10, padding: 12, fontSize: 12, color: '#5B21B6', lineHeight: 1.4 }}>
                      <div style={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 5 }}><CreditCard size={14} /> Réglé en CB Personnelle</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                        Facture payée avec le compte bancaire personnel de : <strong style={{ textTransform: 'capitalize' }}>{linkedCcaAssocie || 'Inconnu'}</strong>.
                      </div>
                      <div style={{ fontSize: 10.5, color: '#6D28D9', marginTop: 4, fontWeight: 700 }}>
                        ✓ Un apport automatique a été enregistré dans son compte associé (CCA).
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Financial Summary */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                  <div style={{ background: 'var(--cream-light)', padding: 12, borderRadius: 10, border: '1px solid var(--border-light)' }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total HT</div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: 'var(--text-primary)' }}>{formatCurrency(selectedInvObj.total_ht)}</div>
                  </div>
                  <div style={{ background: 'var(--cream-light)', padding: 12, borderRadius: 10, border: '1px solid var(--border-light)' }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Total TTC</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--red)', marginTop: 4 }}>{formatCurrency(selectedInvObj.total_ttc)}</div>
                  </div>
                </div>
              </div>

              {/* Right Column: Invoice Lines Table */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Lignes de la Facture
                </h4>
                {lines.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', background: 'var(--cream-light)', borderRadius: 12, color: 'var(--text-muted)', fontSize: 12, border: '1px dashed var(--border)' }}>
                    Aucune ligne détaillée extraite pour cette facture.
                  </div>
                ) : (
                  <div className="table-container" style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border-light)', borderRadius: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Désignation</th>
                          <th style={{ textAlign: 'center' }}>Qté</th>
                          <th style={{ textAlign: 'center' }}>Unité</th>
                          <th style={{ textAlign: 'right' }}>PU HT</th>
                          <th style={{ textAlign: 'right' }}>Total HT</th>
                          <th>Catégorie</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map(l => (
                          <tr key={l.id}>
                            <td style={{ fontWeight: 500, fontSize: 12 }}>{l.designation}</td>
                            <td style={{ textAlign: 'center', fontSize: 12 }}>{l.quantity}</td>
                            <td style={{ textAlign: 'center', fontSize: 12 }}>{l.unit || '—'}</td>
                            <td style={{ textAlign: 'right', fontSize: 12 }}>{formatCurrency(l.unit_price_ht)}</td>
                            <td style={{ textAlign: 'right', fontSize: 12 }}>{formatCurrency(l.total_ht)}</td>
                            <td>
                              <select
                                className={`inline-select badge-${l.category || 'autre'}`}
                                value={l.category || 'autre'}
                                onChange={e => updateCategory(l.id, e.target.value)}
                                style={{ fontSize: 11, padding: '3px 6px' }}
                              >
                                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                                  <option key={k} value={k}>{v}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </div>
    </>
  );
}
