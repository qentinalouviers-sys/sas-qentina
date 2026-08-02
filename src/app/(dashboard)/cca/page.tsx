'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  formatCurrency,
  formatDate,
  getDateRange,
  toISODate,
  downloadCSV
} from '@/lib/utils';
import { Modal } from '@/components/ui';
import {
  Coins,
  Upload,
  Plus,
  Trash2,
  ArrowUpRight,
  ArrowDownRight,
  FileText,
  AlertCircle,
  CheckCircle,
  Download,
  ExternalLink
} from 'lucide-react';
import type { CcaAssocie, CcaSousType, MouvementCca, PeriodFilter } from '@/lib/types';


function renderCcaAttachmentLinks(pieceJustif: string | null) {
  if (!pieceJustif) return <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucun</span>;
  
  let urls: string[] = [];
  if (pieceJustif.trim().startsWith('[')) {
    try {
      urls = JSON.parse(pieceJustif);
    } catch {
      urls = [pieceJustif];
    }
  } else {
    urls = [pieceJustif];
  }

  if (urls.length === 0) return <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucun</span>;

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {urls.map((url, index) => (
        <a 
          key={index}
          href={url} 
          target="_blank" 
          rel="noopener noreferrer"
          className="btn btn-secondary btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
          title={urls.length > 1 ? `Page ${index + 1}` : "Voir la pièce justificative"}
        >
          <FileText size={12} /> {urls.length > 1 ? `Page ${index + 1}` : 'Justificatif'} <ExternalLink size={10} />
        </a>
      ))}
    </div>
  );
}

export default function CcaPage() {
  const [movements, setMovements] = useState<MouvementCca[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [associeFilter, setAssocieFilter] = useState<'tous' | 'justine' | 'yohan'>('tous');
  const [period, setPeriod] = useState<PeriodFilter | 'all'>('all');
  const [showModal, setShowModal] = useState(false);

  // Form State
  const [formDate, setFormDate] = useState(toISODate(new Date()));
  const [formAssocie, setFormAssocie] = useState<CcaAssocie>('justine');
  const [formSousType, setFormSousType] = useState<CcaSousType>('facture_payee_perso');
  const [formMontant, setFormMontant] = useState('');
  const [formNote, setFormNote] = useState('');
  const [formFile, setFormFile] = useState<File | null>(null);

  const supabase = createClient();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('mouvements_cca')
        .select('*')
        .order('date', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });

      if (error) throw error;
      setMovements(data || []);
    } catch (e) {
      console.error("Error loading CCA movements:", e);
      alert("Impossible de charger les mouvements CCA.");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime updates
  useEffect(() => {
    const channel = supabase.channel('cca-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mouvements_cca' }, () => loadData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadData, supabase]);

  // Calculate Running Balances chronologically
  const { movements: movementsWithBalance, justineBal, yohanBal } = useMemo(() => {
    let jBal = 0;
    let yBal = 0;

    const withBalance = movements.map(m => {
      const amt = Number(m.montant);
      const isApport = m.sens === 'apport';
      if (m.associe === 'justine') {
        const prevBal = jBal;
        jBal += isApport ? amt : -amt;
        const bascule = prevBal >= 0 && jBal < 0;
        return { ...m, running_balance: jBal, bascule_negatif: bascule };
      } else {
        const prevBal = yBal;
        yBal += isApport ? amt : -amt;
        const bascule = prevBal >= 0 && yBal < 0;
        return { ...m, running_balance: yBal, bascule_negatif: bascule };
      }
    });

    return { movements: withBalance, justineBal: jBal, yohanBal: yBal };
  }, [movements]);

  // Latest Balances
  const currentJustineBalance = justineBal;
  const currentYohanBalance = yohanBal;
  const currentTotalBalance = justineBal + yohanBal;
  const debiteurCount = (currentJustineBalance < 0 ? 1 : 0) + (currentYohanBalance < 0 ? 1 : 0);

  // Filtering for display
  let filtered = movementsWithBalance;
  if (associeFilter !== 'tous') {
    filtered = filtered.filter(m => m.associe === associeFilter);
  }
  if (period !== 'all') {
    const { start, end } = getDateRange(period);
    filtered = filtered.filter(m => {
      const mDate = new Date(m.date);
      return mDate >= start && mDate <= end;
    });
  }

  // Display array: Newest first
  const displayMovements = [...filtered].reverse();

  // Handle manual apport submission
  const handleAddApport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formFile) {
      alert("La pièce justificative est obligatoire pour un apport manuel.");
      return;
    }
    const amountNum = parseFloat(formMontant);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert("Le montant doit être supérieur à 0.");
      return;
    }

    setSaving(true);
    try {
      // 1. Upload file to Supabase storage
      const fileExt = formFile.name.split('.').pop();
      const fileName = `cca/${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${fileExt}`;
      const { error: uploadErr } = await supabase.storage
        .from('invoice-files')
        .upload(fileName, formFile);

      if (uploadErr) throw uploadErr;

      const { data: publicUrlData } = supabase.storage
        .from('invoice-files')
        .getPublicUrl(fileName);

      const pieceJustifUrl = publicUrlData.publicUrl;

      // 2. Insert movement
      const { error: insertErr } = await supabase
        .from('mouvements_cca')
        .insert({
          date: formDate,
          associe: formAssocie,
          sens: 'apport',
          sous_type: formSousType,
          montant: amountNum,
          piece_justif: pieceJustifUrl,
          note: formNote.trim() || null,
          rapproche_banque: false
        });

      if (insertErr) {
        // L'insert a échoué : on supprime le fichier uploadé pour ne pas laisser d'orphelin
        try {
          await supabase.storage.from('invoice-files').remove([fileName]);
        } catch (cleanupErr) {
          console.error('Impossible de supprimer le fichier orphelin:', cleanupErr);
        }
        throw insertErr;
      }

      alert("Apport manuel enregistré avec succès.");
      setShowModal(false);
      
      // Reset form
      setFormDate(toISODate(new Date()));
      setFormAssocie('justine');
      setFormSousType('facture_payee_perso');
      setFormMontant('');
      setFormNote('');
      setFormFile(null);
      
      loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'enregistrement de l'apport.");
    } finally {
      setSaving(false);
    }
  };

  // Handle movement deletion
  const handleDeleteMovement = async (mouvement: MouvementCca) => {
    const confirm1 = confirm("Êtes-vous sûr de vouloir supprimer ce mouvement de compte courant ?");
    if (!confirm1) return;
    const confirm2 = confirm("Attention : cette action est irréversible et modifiera le solde de l'associé. Confirmez-vous ?");
    if (!confirm2) return;

    setLoading(true);
    try {
      // Guard: Deleting an apport reduces the associate's balance. Check if balance - amount < 0.
      if (mouvement.sens === 'apport') {
        const partner = mouvement.associe;
        // Soldes déjà calculés en mémoire (useMemo) — inutile de refaire un fetch
        const currentBal = partner === 'justine' ? justineBal : yohanBal;

        if (currentBal - Number(mouvement.montant) < 0) {
          const confirmDebit = confirm(
            `⚠️ Cette suppression rend le compte de ${
              partner === 'justine' ? 'Justine' : 'Yohan'
            } débiteur (solde : ${formatCurrency(currentBal - Number(mouvement.montant))}).\nUn CCA ne doit pas être débiteur en SAS — à régulariser ou à vérifier avec le comptable.\n\nSouhaitez-vous supprimer quand même ?`
          );
          if (!confirmDebit) {
            setLoading(false);
            return;
          }
        }
      }

      // If linked to a bank transaction, reset its status to pending_invoice and nullify class/invoice
      if (mouvement.bank_transaction_id) {
        await supabase
          .from('bank_transactions')
          .update({
            status: 'pending_invoice',
            accounting_class: null,
            invoice_id: null
          })
          .eq('id', mouvement.bank_transaction_id);
      }

      // Delete movement
      const { error: deleteErr } = await supabase
        .from('mouvements_cca')
        .delete()
        .eq('id', mouvement.id);

      if (deleteErr) throw deleteErr;

      alert("Mouvement supprimé avec succès.");
      loadData();
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la suppression.");
      setLoading(false);
    }
  };

  const getSubtypeLabel = (st: CcaSousType) => {
    switch (st) {
      case 'facture_payee_perso': return 'Facture payée perso';
      case 'avance_tresorerie': return 'Avance trésorerie';
      case 'frais_perso_reverse': return 'Frais perso reversé';
      default: return st;
    }
  };

  // Export formats
  const handleExportCSV = () => {
    const dataToExport = displayMovements.map(m => ({
      Date: m.date,
      Associe: m.associe === 'justine' ? 'Justine' : 'Yohan',
      Sens: m.sens === 'apport' ? 'Apport (Crédit)' : 'Remboursement (Débit)',
      Type: getSubtypeLabel(m.sous_type),
      Montant: m.montant,
      Solde_Courant: m.running_balance,
      Note: m.note || '',
      Rapproche_Banque: m.rapproche_banque ? 'Oui' : 'Non',
      Lien_Justificatif: m.piece_justif || ''
    }));
    downloadCSV(dataToExport, `cca_mouvements_${associeFilter}_${period}`);
  };

  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(displayMovements, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `cca_mouvements_${associeFilter}_${period}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        .cca-kpi-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
          gap: 20px;
          margin-bottom: 24px;
        }
        .cca-kpi-card {
          background: white;
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 20px;
          box-shadow: var(--shadow-sm);
          position: relative;
          overflow: hidden;
          transition: all 0.2s ease;
        }
        .cca-kpi-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-md);
        }
        .cca-kpi-icon-wrapper {
          position: absolute;
          right: 20px;
          top: 20px;
          width: 44px;
          height: 44px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cca-filter-section {
          background: white;
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 16px 20px;
          margin-bottom: 24px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 16px;
        }
        .cca-filter-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .cca-pill-button {
          background: var(--surface);
          border: 1px solid var(--border);
          padding: 6px 16px;
          border-radius: 100px;
          font-size: 13px;
          font-weight: 700;
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.15s;
        }
        .cca-pill-button.active {
          background: var(--teal);
          color: white;
          border-color: var(--teal);
        }
        .cca-avatar {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          font-size: 12px;
          color: white;
        }
        .cca-avatar.justine {
          background: linear-gradient(135deg, #EC4899 0%, #D946EF 100%);
        }
        .cca-avatar.yohan {
          background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%);
        }
        .file-upload-zone {
          border: 2px dashed var(--border);
          border-radius: 12px;
          padding: 16px;
          text-align: center;
          cursor: pointer;
          transition: all 0.15s;
          background: var(--surface);
        }
        .file-upload-zone:hover {
          border-color: var(--teal);
          background: rgba(42, 125, 123, 0.02);
        }
        @media (max-width: 768px) {
          .cca-filter-section {
            flex-direction: column;
            align-items: stretch;
          }
          .cca-filter-group {
            flex-wrap: wrap;
          }
        }
      `}} />

      <div className="page-header">
        <div>
          <h2>Comptes Courants d&apos;Associés (CCA)</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Suivi et administration des apports et remboursements des associés de la société (sous-comptes 455)
          </span>
        </div>
        
        <button
          className="btn btn-primary"
          onClick={() => setShowModal(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', fontWeight: 750 }}
        >
          <Plus size={18} />
          Ajouter un apport manuel
        </button>
      </div>

      <div className="page-body">
        {/* Global Warning Banner */}
        {debiteurCount > 0 && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.05)',
            border: '1.5px solid var(--red)',
            borderRadius: 16,
            padding: '12px 20px',
            marginBottom: 24,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            boxShadow: 'var(--shadow-sm)',
            color: 'var(--red)',
            fontWeight: 700,
            fontSize: 14
          }}>
            <AlertCircle size={20} />
            <span>
              {debiteurCount} associé{debiteurCount > 1 ? 's' : ''} en CCA débiteur — à régulariser.
            </span>
          </div>
        )}

        {/* KPI Cards */}
        <div className="cca-kpi-grid">
          {/* Total CCA */}
          <div className="cca-kpi-card" style={{ borderLeft: currentTotalBalance < 0 ? '4px solid var(--red)' : '4px solid var(--teal)' }}>
            <span style={{ display: 'block', paddingRight: 56, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Dette Globale Société (Total CCA)
            </span>
            <div style={{ fontSize: 24, fontWeight: 800, color: currentTotalBalance < 0 ? 'var(--red)' : 'var(--text-primary)', marginTop: 8 }}>
              {formatCurrency(currentTotalBalance)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              {currentTotalBalance < 0 ? "La société a un excédent de remboursement global envers les associés" : "Montant total que la société doit actuellement aux associés"}
            </div>
            <div className="cca-kpi-icon-wrapper" style={{ background: 'rgba(42, 125, 123, 0.08)', color: currentTotalBalance < 0 ? 'var(--red)' : 'var(--teal)' }}>
              <Coins size={22} />
            </div>
          </div>

          {/* Justine's CCA */}
          <div className="cca-kpi-card" style={{ borderLeft: currentJustineBalance < 0 ? '4px solid var(--red)' : '4px solid #EC4899' }}>
            <span style={{ display: 'block', paddingRight: 56, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Compte Courant Justine
            </span>
            <div style={{ fontSize: 24, fontWeight: 800, color: currentJustineBalance < 0 ? 'var(--red)' : '#EC4899', marginTop: 8 }}>
              {formatCurrency(currentJustineBalance)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              {currentJustineBalance < 0 ? (
                <span className="badge" style={{ background: 'var(--red-bg)', color: 'var(--red)', fontWeight: 750, padding: '2px 6px', borderRadius: 4, fontSize: 10 }}>
                  ⚠️ CCA débiteur
                </span>
              ) : (
                "Solde créditeur (la société lui doit ce montant)"
              )}
            </div>
            <div className="cca-kpi-icon-wrapper" style={{ background: 'rgba(236, 72, 153, 0.08)', color: '#EC4899' }}>
              <div className="cca-avatar justine">J</div>
            </div>
          </div>

          {/* Yohan's CCA */}
          <div className="cca-kpi-card" style={{ borderLeft: currentYohanBalance < 0 ? '4px solid var(--red)' : '4px solid #3B82F6' }}>
            <span style={{ display: 'block', paddingRight: 56, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Compte Courant Yohan
            </span>
            <div style={{ fontSize: 24, fontWeight: 800, color: currentYohanBalance < 0 ? 'var(--red)' : '#3B82F6', marginTop: 8 }}>
              {formatCurrency(currentYohanBalance)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              {currentYohanBalance < 0 ? (
                <span className="badge" style={{ background: 'var(--red-bg)', color: 'var(--red)', fontWeight: 750, padding: '2px 6px', borderRadius: 4, fontSize: 10 }}>
                  ⚠️ CCA débiteur
                </span>
              ) : (
                "Solde créditeur (la société lui doit ce montant)"
              )}
            </div>
            <div className="cca-kpi-icon-wrapper" style={{ background: 'rgba(59, 130, 246, 0.08)', color: '#3B82F6' }}>
              <div className="cca-avatar yohan">Y</div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="cca-filter-section">
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {/* Filter Associate */}
            <div className="cca-filter-group">
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Associé :</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['tous', 'justine', 'yohan'] as const).map(opt => (
                  <button
                    key={opt}
                    className={`cca-pill-button ${associeFilter === opt ? 'active' : ''}`}
                    onClick={() => setAssocieFilter(opt)}
                  >
                    {opt === 'tous' ? 'Tous' : opt === 'justine' ? 'Justine' : 'Yohan'}
                  </button>
                ))}
              </div>
            </div>

            {/* Filter Period */}
            <div className="cca-filter-group">
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Période :</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['all', 'month', 'year'] as const).map(p => (
                  <button
                    key={p}
                    className={`cca-pill-button ${period === p ? 'active' : ''}`}
                    onClick={() => setPeriod(p)}
                  >
                    {p === 'all' ? 'Historique Complet' : p === 'month' ? 'Ce mois' : 'Cette année'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Export Actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button 
              className="btn btn-secondary btn-sm"
              onClick={handleExportCSV}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
            >
              <Download size={14} /> Export CSV
            </button>
            <button 
              className="btn btn-secondary btn-sm"
              onClick={handleExportJSON}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
            >
              <Download size={14} /> Export JSON
            </button>
          </div>
        </div>

        {/* movements list */}
        {loading ? (
          <div className="loading-page">
            <div className="spinner" style={{ width: 32, height: 32 }} />
            <p>Chargement du grand livre CCA...</p>
          </div>
        ) : displayMovements.length === 0 ? (
          <div className="empty-state">
            <Coins size={48} />
            <p>Aucune écriture enregistrée pour les filtres sélectionnés.</p>
          </div>
        ) : (
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Associé</th>
                    <th>Sens</th>
                    <th>Type d&apos;opération</th>
                    <th>Justificatif</th>
                    <th>Origine</th>
                    <th style={{ textAlign: 'right' }}>Montant</th>
                    <th style={{ textAlign: 'right' }}>Solde Courant</th>
                    <th style={{ textAlign: 'center', width: 60 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {displayMovements.map(m => {
                    const isJustine = m.associe === 'justine';
                    const isApport = m.sens === 'apport';
                    return (
                      <tr 
                        key={m.id} 
                        style={{ 
                          transition: 'all 0.1s',
                          background: m.bascule_negatif ? 'rgba(239, 68, 68, 0.04)' : 'inherit'
                        }}
                      >
                        <td>{formatDate(m.date)}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className={`cca-avatar ${m.associe}`}>
                              {isJustine ? 'J' : 'Y'}
                            </div>
                            <span style={{ fontWeight: 600, fontSize: 13, textTransform: 'capitalize' }}>
                              {m.associe}
                              {m.running_balance < 0 && (
                                <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--red)', fontWeight: 800 }}>
                                  (Débiteur)
                                </span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            fontWeight: 750,
                            padding: '3px 8px',
                            borderRadius: 100,
                            background: isApport ? 'rgba(52, 211, 153, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                            color: isApport ? '#059669' : '#DC2626'
                          }}>
                            {isApport ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                            {isApport ? 'Apport' : 'Remboursement'}
                          </span>
                        </td>
                        <td>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{getSubtypeLabel(m.sous_type)}</div>
                          {m.note && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{m.note}</div>}
                        </td>
                        <td>
                          {renderCcaAttachmentLinks(m.piece_justif)}
                        </td>
                        <td>
                          {m.rapproche_banque ? (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11,
                              fontWeight: 700,
                              color: 'var(--green)'
                            }}>
                              <CheckCircle size={12} /> Banque Rapprochée
                            </span>
                          ) : (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--text-muted)'
                            }}>
                              Hors banque
                            </span>
                          )}
                        </td>
                        <td style={{ 
                          textAlign: 'right', 
                          fontWeight: 700, 
                          color: isApport ? '#059669' : '#DC2626',
                          fontSize: 14 
                        }}>
                          {isApport ? '+' : '-'} {formatCurrency(m.montant)}
                        </td>
                        <td style={{ 
                          textAlign: 'right', 
                          fontWeight: 700, 
                          fontSize: 13, 
                          color: m.running_balance < 0 ? 'var(--red)' : 'var(--text-primary)' 
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                            {m.bascule_negatif && (
                              <span title="Ce mouvement fait basculer le compte en débiteur" style={{ display: 'inline-flex' }}>
                                <AlertCircle size={14} style={{ color: 'var(--red)' }} />
                              </span>
                            )}
                            {formatCurrency(m.running_balance)}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button
                            onClick={() => handleDeleteMovement(m)}
                            className="btn btn-ghost btn-sm"
                            title="Supprimer ce mouvement"
                            style={{ color: '#DC2626', padding: 6 }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Manual Apport Modal */}
      {showModal && (
        <Modal
          title="Ajouter un apport manuel"
          onClose={() => setShowModal(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowModal(false)}
                disabled={saving}
                style={{ fontWeight: 650 }}
              >
                Annuler
              </button>
              <button
                type="submit"
                form="cca-apport-form"
                className="btn btn-primary"
                disabled={saving}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
              >
                {saving ? (
                  <>
                    <div className="spinner" style={{ width: 14, height: 14 }} /> Enregistrement...
                  </>
                ) : (
                  <>Enregistrer l&apos;apport</>
                )}
              </button>
            </>
          }
        >
          <form id="cca-apport-form" onSubmit={handleAddApport} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Date */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Date de l&apos;opération
              </label>
              <input
                type="date"
                required
                className="form-input"
                value={formDate}
                onChange={e => setFormDate(e.target.value)}
              />
            </div>

            {/* Associate */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Associé
              </label>
              <select
                className="form-select"
                value={formAssocie}
                onChange={e => setFormAssocie(e.target.value as CcaAssocie)}
              >
                <option value="justine">Justine (Présidente)</option>
                <option value="yohan">Yohan</option>
              </select>
            </div>

            {/* Sub-type */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Nature de l&apos;apport
              </label>
              <select
                className="form-select"
                value={formSousType}
                onChange={e => setFormSousType(e.target.value as CcaSousType)}
              >
                <option value="facture_payee_perso">Facture payée personnellement (Frais avancés)</option>
                <option value="avance_tresorerie">Avance de trésorerie (Virement perso vers pro)</option>
                <option value="frais_perso_reverse">Frais perso reversés à la société</option>
              </select>
            </div>

            {/* Montant */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Montant de l&apos;apport (€)
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  className="form-input"
                  value={formMontant}
                  onChange={e => setFormMontant(e.target.value)}
                  style={{ paddingLeft: 20 }}
                />
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--text-muted)' }}>€</span>
              </div>
            </div>

            {/* File Attachment (Mandatory — validé côté JS dans handleAddApport,
                pas d'attribut required : l'input est masqué et Chrome bloquerait
                la soumission avec une erreur « not focusable ») */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Pièce justificative (Requis)
              </label>
              <div
                className="file-upload-zone"
                onClick={() => {
                  const inp = document.getElementById('piece-justif-input');
                  if (inp) inp.click();
                }}
              >
                <input
                  id="piece-justif-input"
                  type="file"
                  accept="image/*,.pdf"
                  onChange={e => setFormFile(e.target.files?.[0] || null)}
                  style={{ display: 'none' }}
                />
                <Upload size={24} style={{ color: 'var(--teal)', margin: '0 auto 8px' }} />
                <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-primary)', display: 'block' }}>
                  {formFile ? formFile.name : "Cliquez pour sélectionner la pièce jointe (facture, reçu...)"}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  PDF, JPG ou PNG
                </span>
              </div>
            </div>

            {/* Note */}
            <div>
              <label className="form-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700, fontSize: 13 }}>
                Note descriptive (Optionnelle)
              </label>
              <textarea
                className="form-input"
                placeholder="Détails sur l'opération, nom du fournisseur..."
                value={formNote}
                onChange={e => setFormNote(e.target.value)}
                style={{ height: 80, resize: 'none', padding: '10px' }}
              />
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
