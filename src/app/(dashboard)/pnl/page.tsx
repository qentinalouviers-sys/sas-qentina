'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, formatPercent, getDateRange, toISODate, formatDate } from '@/lib/utils';
import { isFinancialFlow } from '@/lib/accounting';
import {
  TrendingUp,
  DollarSign,
  Users,
  Receipt,
  PieChart as PieIcon, 
  Sparkles,
  Info,
  AlertCircle,
  X,
  Search,
  Eye,
  EyeOff
} from 'lucide-react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { PeriodFilter } from '@/lib/types';

const getHtAmount = (o: any) => {
  const raw = o.raw_data || {};
  const tax = (raw.total_tax_money?.amount || raw.net_amounts?.tax_money?.amount || 0) / 100;
  return (o.net_amount || 0) - tax;
};

// Formateur de ligne de modale pour une transaction bancaire (Date / Libellé / Montant),
// paramétré par la couleur du montant.
const makeBankRowFormatter = (color: string) => (t: any) => ({
  id: String(t.id),
  cells: [
    formatDate(t.date),
    t.description,
    <strong key="amt" style={{ color }}>{formatCurrency(Math.abs(t.amount || 0))}</strong>
  ]
});

// Ligne cliquable du tableau P&L (poste de détail indenté).
// Le flex est posé sur un <div> interne à la cellule (jamais sur le <td>,
// ce qui casserait l'alignement des colonnes du tableau).
interface PnlRowProps {
  label: string;
  value: number;
  ratio: number;
  note: string;
  color?: string;
  onClick: () => void;
}

const PnlRow = ({ label, value, ratio, note, color = 'var(--text-secondary)', onClick }: PnlRowProps) => (
  <tr onClick={onClick} style={{ cursor: 'pointer' }} className="interactive-row">
    <td style={{ paddingLeft: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Eye size={12} style={{ color }} /> {label}
      </div>
    </td>
    <td style={{ textAlign: 'right' }}>{formatCurrency(value)}</td>
    <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{formatPercent(ratio)}</td>
    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{note}</td>
  </tr>
);

export default function PnlPage() {
  const [period, setPeriod] = useState<PeriodFilter>('month');
  const [loading, setLoading] = useState(true);
  const [maskedIds, setMaskedIds] = useState<string[]>([]);
  const [showMaskedInModal, setShowMaskedInModal] = useState(false);
  const [data, setData] = useState({
    // CA — la caisse Square est la référence
    caSquare: 0,
    caBank: 0,
    totalCA: 0,

    // Hors exploitation : prêts, apports, compte courant, trésorerie
    fluxFinanciersTotal: 0,
    fluxFinanciersCount: 0,
    fluxFinanciersList: [] as any[],

    // Achats (Coûts Variables)
    purchasesAlim: 0,
    purchasesBoisson: 0,
    purchasesEmballage: 0,
    purchasesMateriel: 0,
    purchasesAutreInvoices: 0,
    bankSuppliersUnreconciled: 0,
    totalCogs: 0, // Cost of Goods Sold (Matières)
    
    // Personnel
    laborTimecards: 0,
    laborBank: 0,
    activeLabor: 0,
    isLaborTheoretical: false,

    // Charges Fixes & Structure
    chargesLoyer: 0,
    chargesAssurance: 0,
    chargesAbonnement: 0,
    chargesImpot: 0,
    chargesAutreBank: 0,
    totalFixedCharges: 0,

    // Résultats
    margeBrute: 0,
    margeBrutePercent: 0,
    ebitda: 0,
    ebitdaPercent: 0,

    // Listes de détails pour la modale (contiennent tous les éléments y compris masqués)
    ordersList: [] as any[],
    bankRecettesList: [] as any[],
    invoiceLinesList: [] as any[],
    bankSuppliersUnreconciledList: [] as any[],
    timecardsList: [] as any[],
    bankSalariesList: [] as any[],
    fixedTxList: [] as any[],
  });

  // Gestion de la modale de détail
  const [activeDetail, setActiveDetail] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { start, end } = getDateRange(period);
    const startStr = toISODate(start);
    const endStr = toISODate(end);

    try {
      // Les 8 requêtes indépendantes sont lancées en parallèle ;
      // seules les lignes de factures (invoice_lines) dépendent des factures → second temps.
      const [
        { data: settingsData },
        { data: orders },
        { data: bankRecettes },
        { data: invoices },
        { data: bankSuppliers },
        { data: timecards },
        { data: bankSalaries },
        { data: fixedTx },
      ] = await Promise.all([
        // A. IDs masqués depuis app_settings
        supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'masked_items'),
        // 1. Chiffre d'Affaires (Square Orders)
        supabase
          .from('square_orders')
          .select('id, net_amount, service, square_order_id, created_at, raw_data')
          .gte('service', startStr)
          .lte('service', endStr)
          .order('service', { ascending: false }),
        // CA Banque (Recettes)
        supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status')
          .eq('category', 'recette')
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false }),
        // 2. Factures fournisseurs
        supabase
          .from('invoices')
          .select('id')
          .gte('date', startStr)
          .lte('date', endStr),
        // Achats Fournisseurs non lettrés (dans banque directement, non lié à facture)
        supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status')
          .eq('category', 'variable_fournisseur')
          .is('invoice_id', null)
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false }),
        // 3. Masse Salariale — Timecards (Salaires théoriques)
        supabase
          .from('labor_timecards')
          .select('id, employee_name, start_at, end_at, hours_worked, hourly_rate')
          .gte('start_at', start.toISOString())
          .lte('start_at', end.toISOString())
          .order('start_at', { ascending: false }),
        // Banque Salaires & Charges
        supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status')
          .eq('category', 'variable_salaire')
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false }),
        // 4. Charges Fixes (Banque)
        supabase
          .from('bank_transactions')
          .select('id, date, description, amount, category, status')
          .in('category', ['fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'impot_taxe', 'autre'])
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false }),
      ]);

      const loadedMaskedIds: string[] = settingsData && settingsData.length > 0 && settingsData[0].value
        ? JSON.parse(settingsData[0].value)
        : [];

      setMaskedIds(loadedMaskedIds);

      // 1. Chiffre d'Affaires (Square Orders)
      const ordersList = orders || [];
      const activeOrders = ordersList.filter((o: any) => !loadedMaskedIds.includes(String(o.id)));
      const caSquare = activeOrders.reduce((s: number, o: any) => s + getHtAmount(o), 0);

      // ── Flux financiers : ni recette, ni charge ──────────────────────────
      // Un prêt, un apport, un mouvement de compte courant ou un virement de
      // trésorerie n'a rien à faire dans un compte de résultat d'exploitation.
      // Comptés à part, ils expliquent l'écart entre les encaissements du compte
      // et le chiffre d'affaires réel — écart qui gonflait auparavant à la fois
      // les « recettes » et le poste fourre-tout des charges.
      const estFlux = (t: any) => isFinancialFlow(t.description || '', t.category);
      const horsExploitation: any[] = [];
      const sansFlux = (list: any[]) => list.filter((t: any) => {
        if (!estFlux(t)) return true;
        horsExploitation.push(t);
        return false;
      });

      // Encaissements bancaires (indicatif — le CA vient de Square)
      const bankRecettesList = sansFlux(bankRecettes || []);
      const activeBankRecettes = bankRecettesList.filter((t: any) => !loadedMaskedIds.includes(String(t.id)));
      const caBank = activeBankRecettes.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);
      const totalCA = caSquare; // La caisse Square est la référence du CA

      // 2. Lignes de factures (dépend des factures récupérées ci-dessus)
      const invoiceIds = invoices?.map((i: any) => i.id) || [];
      
      let purchasesAlim = 0;
      let purchasesBoisson = 0;
      let purchasesEmballage = 0;
      let purchasesMateriel = 0;
      let purchasesAutreInvoices = 0;
      let invoiceLinesList: any[] = [];

      if (invoiceIds.length > 0) {
        const { data: lines } = await supabase
          .from('invoice_lines')
          .select('id, total_ht, designation, quantity, unit, unit_price_ht, category, invoice:invoices(date, invoice_number, supplier:suppliers(name))')
          .in('invoice_id', invoiceIds);
        
        invoiceLinesList = lines || [];
        
        const activeInvoiceLines = invoiceLinesList.filter((l: any) => !loadedMaskedIds.includes(String(l.id)));
        
        activeInvoiceLines.forEach((l: any) => {
          const amt = l.total_ht || 0;
          if (l.category === 'alimentaire') purchasesAlim += amt;
          else if (l.category === 'boisson') purchasesBoisson += amt;
          else if (l.category === 'emballage') purchasesEmballage += amt;
          else if (l.category === 'materiel') purchasesMateriel += amt;
          else purchasesAutreInvoices += amt;
        });
      }

      // Achats Fournisseurs non lettrés (dans banque directement, non lié à facture)
      const bankSuppliersUnreconciledList = sansFlux(bankSuppliers || []);
      const activeBankSuppliers = bankSuppliersUnreconciledList.filter((t: any) => !loadedMaskedIds.includes(String(t.id)));
      const bankSuppliersUnreconciled = activeBankSuppliers.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);
      const totalCogs = purchasesAlim + purchasesBoisson + purchasesEmballage + bankSuppliersUnreconciled;

      // 3. Masse Salariale
      // Timecards (Salaires théoriques)
      const timecardsList = timecards || [];
      const activeTimecards = timecardsList.filter((t: any) => !loadedMaskedIds.includes(String(t.id)));
      const laborTimecards = activeTimecards.reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);

      // Banque Salaires & Charges
      const bankSalariesList = sansFlux(bankSalaries || []);
      const activeBankSalaries = bankSalariesList.filter((t: any) => !loadedMaskedIds.includes(String(t.id)));
      const laborBank = activeBankSalaries.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);

      // Utiliser les flux réels banque si dispos, sinon timecards comme coût théorique
      const useBankLabor = laborBank > 0;
      const activeLabor = useBankLabor ? laborBank : laborTimecards;

      // 4. Charges Fixes (Banque)
      const fixedTxList = sansFlux(fixedTx || []);
      const activeFixedTx = fixedTxList.filter((t: any) => !loadedMaskedIds.includes(String(t.id)));
      
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

      // Inclure les factures de "matériel" et "autres factures" (hors alim/boisson/emballage) dans les charges d'exploitation
      const totalFixedCharges = chargesLoyer + chargesAssurance + chargesAbonnement + chargesImpot + chargesAutreBank + purchasesMateriel + purchasesAutreInvoices;

      // 5. Calculs des Résultats
      const margeBrute = totalCA - totalCogs;
      const margeBrutePercent = totalCA > 0 ? (margeBrute / totalCA) * 100 : 0;
      const ebitda = margeBrute - activeLabor - totalFixedCharges;
      const ebitdaPercent = totalCA > 0 ? (ebitda / totalCA) * 100 : 0;

      const fluxFinanciersTotal = horsExploitation.reduce(
        (s: number, t: any) => s + Math.abs(t.amount || 0), 0
      );

      setData({
        caSquare,
        caBank,
        totalCA,
        fluxFinanciersTotal,
        fluxFinanciersCount: horsExploitation.length,
        fluxFinanciersList: horsExploitation,
        purchasesAlim,
        purchasesBoisson,
        purchasesEmballage,
        purchasesMateriel,
        purchasesAutreInvoices,
        bankSuppliersUnreconciled,
        totalCogs,
        laborTimecards,
        laborBank,
        activeLabor,
        isLaborTheoretical: !useBankLabor,
        chargesLoyer,
        chargesAssurance,
        chargesAbonnement,
        chargesImpot,
        chargesAutreBank,
        totalFixedCharges,
        margeBrute,
        margeBrutePercent,
        ebitda,
        ebitdaPercent,
        
        // Lists (complete data, raw from DB)
        ordersList,
        bankRecettesList,
        invoiceLinesList,
        bankSuppliersUnreconciledList,
        timecardsList,
        bankSalariesList,
        fixedTxList,
      });

    } catch (error) {
      console.error("Erreur lors de la consolidation du P&L :", error);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel('pnl-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'square_orders' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_lines' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_transactions' }, () => loadData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadData]);

  // Action de masquer / démasquer un élément
  const toggleMaskItem = async (id: string) => {
    const supabase = createClient();
    let newMaskedIds: string[] = [];
    
    if (maskedIds.includes(id)) {
      newMaskedIds = maskedIds.filter(mId => mId !== id);
    } else {
      newMaskedIds = [...maskedIds, id];
    }
    
    // Mettre à jour l'état local immédiatement (optimiste)
    setMaskedIds(newMaskedIds);
    
    try {
      await supabase
        .from('app_settings')
        .upsert({ key: 'masked_items', value: JSON.stringify(newMaskedIds) });
      
      // Recharger pour recalculer les totaux de la page
      loadData();
    } catch (error) {
      console.error("Erreur lors de la sauvegarde du masquage :", error);
    }
  };

  // Préparation des données pour les graphiques (mémoïsées)
  const breakdownData = useMemo(() => [
    { name: 'Chiffre d\'Affaires', montant: data.totalCA, fill: 'var(--teal)' },
    { name: 'Coût Matières', montant: data.totalCogs, fill: 'var(--orange)' },
    { name: 'Charges Personnel', montant: data.activeLabor, fill: 'var(--red)' },
    { name: 'Charges Fixes & Ops', montant: data.totalFixedCharges, fill: 'var(--text-muted)' },
    { name: 'EBE (Marge Opé.)', montant: data.ebitda, fill: data.ebitda >= 0 ? 'var(--green)' : 'var(--red)' },
  ], [data]);

  const expensesPieData = useMemo(() => [
    { name: 'Alimentaire', value: data.purchasesAlim, color: '#E89B3E' },
    { name: 'Boissons', value: data.purchasesBoisson, color: '#3A9D9B' },
    { name: 'Emballages', value: data.purchasesEmballage, color: '#9061F9' },
    { name: 'Frais Fournisseurs direct', value: data.bankSuppliersUnreconciled, color: '#F2994A' },
    { name: 'Personnel', value: data.activeLabor, color: '#D94F4F' },
    { name: 'Loyer & Charges', value: data.chargesLoyer, color: '#10B981' },
    { name: 'Assurances', value: data.chargesAssurance, color: '#3B82F6' },
    { name: 'Abonnements', value: data.chargesAbonnement, color: '#EC4899' },
    { name: 'Impôts & Taxes', value: data.chargesImpot, color: '#6B7280' },
    { name: 'Matériel & Divers', value: data.chargesAutreBank + data.purchasesMateriel + data.purchasesAutreInvoices, color: '#9CA3AF' },
  ].filter(item => item.value > 0), [data]);

  const calculateRatio = (amount: number) => {
    return data.totalCA > 0 ? (amount / data.totalCA) * 100 : 0;
  };

  const openDetail = (key: string) => {
    setActiveDetail(key);
    setSearchQuery('');
    setShowMaskedInModal(false);
  };

  // Rendu de la modale de détail
  const renderDetailModal = () => {
    if (!activeDetail) return null;

    let title = '';
    let headers: string[] = [];
    let rawItemsList: any[] = [];
    let consolidatedSum = 0;
    let formatRowFunction: (item: any) => { id: string; cells: any[] };

    // 1. Définition des listes d'éléments, calculs et formatage de ligne
    switch (activeDetail) {
      case 'ca_square':
        title = 'Détail du CA Ventes (Square POS)';
        headers = ['Date Service', 'ID Commande', 'Montant HT'];
        rawItemsList = data.ordersList;
        formatRowFunction = (o: any) => ({
          id: String(o.id),
          cells: [
            formatDate(o.service),
            <span key="id" style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.square_order_id}</span>,
            <strong key="amt" style={{ color: 'var(--teal)' }}>{formatCurrency(getHtAmount(o))}</strong>
          ]
        });
        break;

      case 'ca_bank':
        title = 'Encaissements bancaires — indicatif, le CA vient de Square';
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        rawItemsList = data.bankRecettesList;
        formatRowFunction = makeBankRowFormatter('var(--green)');
        break;

      case 'flux_financiers':
        title = 'Flux financiers — exclus du compte de résultat';
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        rawItemsList = data.fluxFinanciersList;
        formatRowFunction = makeBankRowFormatter('var(--text-muted)');
        break;

      case 'purchases_alim':
      case 'purchases_boisson':
      case 'purchases_emballage':
      case 'purchases_materiel':
      case 'purchases_autre_inv':
        const cat = activeDetail === 'purchases_alim' ? 'alimentaire' 
                  : activeDetail === 'purchases_boisson' ? 'boisson'
                  : activeDetail === 'purchases_emballage' ? 'emballage'
                  : activeDetail === 'purchases_materiel' ? 'materiel'
                  : 'autre';
                  
        title = `Factures détaillées — ${cat === 'alimentaire' ? 'Alimentaire' : cat === 'boisson' ? 'Boissons' : cat === 'emballage' ? 'Emballages' : cat === 'materiel' ? 'Matériel' : 'Autres achats'}`;
        headers = ['Date Facture', 'Fournisseur', 'Désignation', 'Quantité / Unité', 'Prix U. HT', 'Total HT'];
        
        rawItemsList = data.invoiceLinesList.filter((l: any) => {
          if (cat === 'autre') {
            return l.category !== 'alimentaire' && l.category !== 'boisson' && l.category !== 'emballage' && l.category !== 'materiel';
          }
          return l.category === cat;
        });

        formatRowFunction = (l: any) => ({
          id: String(l.id),
          cells: [
            l.invoice ? formatDate(l.invoice.date) : '-',
            l.invoice?.supplier?.name || 'Inconnu',
            l.designation,
            `${l.quantity || 1} ${l.unit || ''}`,
            formatCurrency(l.unit_price_ht),
            <strong key="amt" style={{ color: 'var(--orange)' }}>{formatCurrency(l.total_ht)}</strong>
          ]
        });
        break;

      case 'bank_suppliers_unreconciled':
        title = 'Paiements Fournisseurs (Flux directs Banque)';
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        rawItemsList = data.bankSuppliersUnreconciledList;
        formatRowFunction = makeBankRowFormatter('var(--red)');
        break;

      case 'labor_bank':
        title = 'Paiements Salaires & Charges réels (Banque)';
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        rawItemsList = data.bankSalariesList;
        formatRowFunction = makeBankRowFormatter('var(--red)');
        break;

      case 'labor_timecards':
        title = 'Salaires planifiés / Pointages horaires';
        headers = ['Employé', 'Date / Heure Début', 'Date / Heure Fin', 'Heures', 'Taux Horaire', 'Total Brut'];
        rawItemsList = data.timecardsList;
        formatRowFunction = (t: any) => {
          const cost = (t.hours_worked || 0) * (t.hourly_rate || 0);
          return {
            id: String(t.id),
            cells: [
              <strong key="name">{t.employee_name || 'Anonyme'}</strong>,
              t.start_at ? new Date(t.start_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '-',
              t.end_at ? new Date(t.end_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '-',
              `${(t.hours_worked || 0).toFixed(2)} h`,
              `${formatCurrency(t.hourly_rate)}/h`,
              <strong key="cost" style={{ color: 'var(--red)' }}>{formatCurrency(cost)}</strong>
            ]
          };
        };
        break;

      case 'charges_loyer':
      case 'charges_assurance':
      case 'charges_abonnement':
      case 'charges_impot':
      case 'charges_autre_bank':
        const bankCat = activeDetail === 'charges_loyer' ? 'fixe_loyer'
                     : activeDetail === 'charges_assurance' ? 'fixe_assurance'
                     : activeDetail === 'charges_abonnement' ? 'fixe_abonnement'
                     : activeDetail === 'charges_impot' ? 'impot_taxe'
                     : 'autre';

        const categoryLabels: Record<string, string> = {
          fixe_loyer: 'Loyers & Charges locatives',
          fixe_assurance: 'Assurances',
          fixe_abonnement: 'Abonnements',
          impot_taxe: 'Impôts & Taxes',
          autre: 'Frais divers banque'
        };

        title = `Détail : ${categoryLabels[bankCat]}`;
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        
        rawItemsList = data.fixedTxList.filter((t: any) => t.category === bankCat);
        formatRowFunction = makeBankRowFormatter('var(--text-primary)');
        break;
      
      default:
        return null;
    }

    // 2. Filtrage des éléments pour la recherche + prise en compte du masquage
    const searchLower = searchQuery.toLowerCase();
    
    // Détecter combien d'éléments de cette liste complète sont masqués
    const totalMaskedCount = rawItemsList.filter(item => maskedIds.includes(String(item.id))).length;

    // Éléments après filtres (Recherche & Masquage)
    const displayedItems = rawItemsList.filter((item: any) => {
      const isMasked = maskedIds.includes(String(item.id));
      
      // Exclure si masqué et qu'on ne demande pas à les afficher
      if (isMasked && !showMaskedInModal) return false;

      // Filtre de recherche textuelle selon le type
      if (activeDetail === 'labor_timecards') {
        return item.employee_name?.toLowerCase().includes(searchLower);
      } else if (activeDetail.startsWith('purchases_')) {
        return item.designation?.toLowerCase().includes(searchLower) ||
               item.invoice?.supplier?.name?.toLowerCase().includes(searchLower) ||
               item.invoice?.invoice_number?.toLowerCase().includes(searchLower);
      } else {
        return item.description?.toLowerCase().includes(searchLower) ||
               item.date?.includes(searchLower) || 
               item.square_order_id?.toLowerCase().includes(searchLower) ||
               item.service?.includes(searchLower);
      }
    });

    // Calcul de la somme des éléments visibles et NON masqués
    const activeItemsList = rawItemsList.filter(item => !maskedIds.includes(String(item.id)));
    
    if (activeDetail === 'labor_timecards') {
      consolidatedSum = activeItemsList.reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);
    } else if (activeDetail.startsWith('purchases_')) {
      consolidatedSum = activeItemsList.reduce((s: number, l: any) => s + (l.total_ht || 0), 0);
    } else if (activeDetail === 'ca_square') {
      consolidatedSum = activeItemsList.reduce((s: number, o: any) => s + getHtAmount(o), 0);
    } else {
      consolidatedSum = activeItemsList.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);
    }

    // Ajouter la colonne "Action" au tableau de la modale
    const finalHeaders = [...headers, 'Action'];

    return (
      <div className="modal-overlay" onClick={() => setActiveDetail(null)}>
        <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h3 className="modal-title">{title}</h3>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Total actif consolidé : <strong>{formatCurrency(consolidatedSum)}</strong> ({activeItemsList.length} élément(s) actif(s))
              </div>
            </div>
            <button className="modal-close" onClick={() => setActiveDetail(null)}>
              <X size={20} />
            </button>
          </div>

          <div style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
              <input
                type="text"
                placeholder="Rechercher dans les détails..."
                className="form-input"
                style={{ paddingLeft: '36px' }}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--text-muted)' }} />
            </div>
            
            {totalMaskedCount > 0 && (
              <button 
                className={`btn ${showMaskedInModal ? 'btn-primary' : 'btn-secondary'} btn-sm`} 
                onClick={() => setShowMaskedInModal(!showMaskedInModal)}
                style={{ height: '38px' }}
              >
                {showMaskedInModal ? "👁️ Masquer les éléments exclus" : `👁️ Afficher les masqués (${totalMaskedCount})`}
              </button>
            )}
          </div>

          <div className="table-container" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {displayedItems.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px' }}>
                <p>Aucune écriture active trouvée.</p>
                {totalMaskedCount > 0 && !showMaskedInModal && (
                  <p style={{ fontSize: '13px', marginTop: '8px' }}>
                    💡 Il y a {totalMaskedCount} élément(s) masqué(s) dans cette liste. Cliquez sur &ldquo;Afficher les masqués&rdquo; ci-dessus pour les auditer.
                  </p>
                )}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    {finalHeaders.map((h, idx) => {
                      const isRightAlign = idx === finalHeaders.length - 2 || 
                                           ['Montant', 'Total HT', 'Total Brut', 'Prix U. HT'].includes(h);
                      const isCenterAlign = h === 'Action';
                      return (
                        <th 
                          key={idx} 
                          style={
                            isRightAlign ? { textAlign: 'right' } :
                            isCenterAlign ? { textAlign: 'center', whiteSpace: 'nowrap' } :
                            {}
                          }
                        >
                          {h}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {displayedItems.map((item) => {
                    const rowData = formatRowFunction(item);
                    const isMasked = maskedIds.includes(rowData.id);
                    
                    return (
                      <tr 
                        key={rowData.id}
                        style={isMasked ? { opacity: 0.5, textDecoration: 'line-through', background: 'var(--cream-light)' } : {}}
                      >
                        {rowData.cells.map((cell: any, cellIdx: number) => {
                          const isRightAlign = cellIdx === rowData.cells.length - 1 || 
                                               ['Montant', 'Total HT', 'Total Brut', 'Prix U. HT'].includes(headers[cellIdx]);
                          return (
                            <td 
                              key={cellIdx} 
                              style={isRightAlign ? { textAlign: 'right' } : {}}
                            >
                              {cell}
                            </td>
                          );
                        })}
                        {/* Colonne Action pour Masquer / Démasquer */}
                        <td style={{ textAlign: 'center' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ 
                              padding: '4px 8px', 
                              borderColor: isMasked ? 'var(--teal)' : 'var(--border)',
                              background: isMasked ? 'var(--teal-bg)' : 'white'
                            }}
                            onClick={() => toggleMaskItem(rowData.id)}
                            title={isMasked ? "Démasquer et réintégrer l'élément" : "Masquer et exclure des calculs"}
                          >
                            {isMasked ? (
                              <Eye size={14} style={{ color: 'var(--teal)' }} />
                            ) : (
                              <EyeOff size={14} style={{ color: 'var(--text-muted)' }} />
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          
          <div className="modal-footer" style={{ marginTop: '16px', padding: '12px 0 0 0', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setActiveDetail(null)}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h2>Compte de Résultat (P&L)</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Consolidation financière en temps réel — Cliquez sur une ligne pour voir les calculs ou masquer des éléments
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
            <p>Calcul des flux comptables...</p>
          </div>
        ) : (
          <>
            {/* KPI Summary Cards */}
            <div className="kpi-grid">
              <div className={`kpi-card ${data.ebitda >= 0 ? 'success' : 'danger'}`}>
                <div className="kpi-label">
                  <TrendingUp size={16} /> EBE (Marge Opérationnelle)
                </div>
                <div className={`kpi-value ${data.ebitda >= 0 ? 'success' : 'danger'}`}>
                  {formatCurrency(data.ebitda)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Marge opérationnelle (EBE) : <strong>{formatPercent(data.ebitdaPercent)}</strong>
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">
                  <DollarSign size={16} /> Marge Brute
                </div>
                <div className="kpi-value">{formatCurrency(data.margeBrute)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Taux de marge brute : <strong>{formatPercent(data.margeBrutePercent)}</strong>
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">
                  <Users size={16} /> Masse Salariale
                </div>
                <div className="kpi-value">{formatCurrency(data.activeLabor)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Ratio CA : <strong>{formatPercent(calculateRatio(data.activeLabor))}</strong>
                  {data.isLaborTheoretical && " (Théorique)"}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">
                  <Receipt size={16} /> Coût Matières (Food Cost)
                </div>
                <div className="kpi-value" style={{ color: 'var(--orange)' }}>
                  {formatCurrency(data.totalCogs)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Food Cost % : <strong>{formatPercent(calculateRatio(data.totalCogs))}</strong>
                </div>
              </div>
            </div>

            {/* Warn user if labor is theoretical or masked elements exist */}
            {data.isLaborTheoretical && (
              <div className="alert alert-warning" style={{ marginBottom: 20 }}>
                <AlertCircle size={16} />
                <span>
                  <strong>Masse salariale théorique :</strong> Aucun salaire ou charge n&apos;a été détecté dans les flux bancaires sur cette période. Les calculs se basent sur l&apos;historique des fiches horaires (Timecards).
                </span>
              </div>
            )}

            {maskedIds.length > 0 && (
              <div className="alert alert-success" style={{ marginBottom: 20, background: 'rgba(42, 125, 123, 0.05)', color: 'var(--teal)', borderColor: 'rgba(42, 125, 123, 0.2)' }}>
                <Info size={16} />
                <span>
                  <strong>Ajustements actifs :</strong> {maskedIds.length} écriture(s) ont été masquée(s) et exclue(s) du calcul du P&L. Ouvrez les détails pour les réintégrer.
                </span>
              </div>
            )}

            {/* Charts section */}
            <div className="grid-2" style={{ marginBottom: 24 }}>
              {/* Cascade/Flow chart */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Structure du Résultat Opérationnel</div>
                  <TrendingUp size={20} style={{ color: 'var(--teal)' }} />
                </div>
                <div className="chart-container">
                  <ResponsiveContainer>
                    <BarChart data={breakdownData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
                      <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
                      <Tooltip formatter={(val: any) => formatCurrency(val)} />
                      <Bar dataKey="montant">
                        {breakdownData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Pie chart expense distribution */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Répartition des charges</div>
                  <PieIcon size={20} style={{ color: 'var(--teal)' }} />
                </div>
                <div className="chart-container">
                  {expensesPieData.length > 0 ? (
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie
                          data={expensesPieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={75}
                          label={({ name, percent }: any) => `${name} (${((percent || 0) * 100).toFixed(0)}%)`}
                          labelLine={false}
                          style={{ fontSize: 10, fontWeight: 500 }}
                        >
                          {expensesPieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(val: any) => formatCurrency(val)} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="empty-state">
                      <p>Aucune charge opérationnelle active.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* P&L Detail Table */}
            <div className="card" style={{ marginBottom: 24 }}>
              <div className="card-header">
                <div>
                  <div className="card-title">Rapport de Résultat Consolidé</div>
                  <div className="card-subtitle">Détails des postes de recettes et de dépenses (Cliquez sur une ligne pour l&apos;auditer ou masquer)</div>
                </div>
                <Sparkles size={20} style={{ color: 'var(--orange)' }} />
              </div>

              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '45%' }}>Postes Budgétaires</th>
                      <th style={{ textAlign: 'right' }}>Montant HT</th>
                      <th style={{ textAlign: 'right' }}>Ratio / CA (%)</th>
                      <th>Notes & Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* SECTION 1: REVENUS */}
                    <tr style={{ background: 'var(--cream-light)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--teal)' }}>1. PRODUITS D&apos;EXPLOITATION (REVENUS)</td>
                      <td style={{ textAlign: 'right', color: 'var(--teal)' }}>
                        {formatCurrency(data.totalCA)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--teal)' }}>100,0 %</td>
                      <td>Volume opérationnel net</td>
                    </tr>
                    <PnlRow
                      label="CA Ventes (Square POS)"
                      value={data.caSquare}
                      ratio={calculateRatio(data.caSquare)}
                      color="var(--teal)"
                      note="Ventes directes caisse (cliquer pour voir/exclure)"
                      onClick={() => openDetail('ca_square')}
                    />
                    <PnlRow
                      label="Encaissements bancaires (hors total)"
                      value={data.caBank}
                      ratio={calculateRatio(data.caBank)}
                      color="var(--teal)"
                      note="Indicatif — le CA vient de la caisse Square"
                      onClick={() => openDetail('ca_bank')}
                    />
                    {data.fluxFinanciersCount > 0 && (
                      <PnlRow
                        label="Flux financiers exclus du résultat"
                        value={data.fluxFinanciersTotal}
                        ratio={calculateRatio(data.fluxFinanciersTotal)}
                        color="var(--text-muted)"
                        note={`${data.fluxFinanciersCount} mouvement(s) : prêts, apports, compte courant, trésorerie, retraits`}
                        onClick={() => openDetail('flux_financiers')}
                      />
                    )}

                    {/* SECTION 2: COUT MATIERES */}
                    <tr style={{ background: 'var(--cream-light)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--orange)' }}>2. COÛTS VARIABLES (ACHATS MATIÈRES)</td>
                      <td style={{ textAlign: 'right', color: 'var(--orange)' }}>
                        {formatCurrency(data.totalCogs)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--orange)' }}>
                        {formatPercent(calculateRatio(data.totalCogs))}
                      </td>
                      <td>Food Cost global</td>
                    </tr>
                    <PnlRow
                      label="Achats Alimentaires"
                      value={data.purchasesAlim}
                      ratio={calculateRatio(data.purchasesAlim)}
                      color="var(--orange)"
                      note="Lignes factures (cliquer pour voir/exclure)"
                      onClick={() => openDetail('purchases_alim')}
                    />
                    <PnlRow
                      label="Achats Boissons"
                      value={data.purchasesBoisson}
                      ratio={calculateRatio(data.purchasesBoisson)}
                      color="var(--orange)"
                      note="Lignes factures (cliquer pour voir/exclure)"
                      onClick={() => openDetail('purchases_boisson')}
                    />
                    <PnlRow
                      label="Achats Emballages"
                      value={data.purchasesEmballage}
                      ratio={calculateRatio(data.purchasesEmballage)}
                      color="var(--orange)"
                      note="Consommables & emballages (cliquer pour voir/exclure)"
                      onClick={() => openDetail('purchases_emballage')}
                    />
                    <PnlRow
                      label="Paiements Fournisseurs (flux direct)"
                      value={data.bankSuppliersUnreconciled}
                      ratio={calculateRatio(data.bankSuppliersUnreconciled)}
                      color="var(--orange)"
                      note="Dépenses banque sans factures PDF (cliquer pour voir/exclure)"
                      onClick={() => openDetail('bank_suppliers_unreconciled')}
                    />

                    {/* SECTION 3: MARGE BRUTE */}
                    <tr style={{ background: '#E6F5ED', fontWeight: 800 }}>
                      <td style={{ color: 'var(--green)' }}>3. MARGE BRUTE D&apos;EXPLOITATION</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }}>
                        {formatCurrency(data.margeBrute)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }}>
                        {formatPercent(data.margeBrutePercent)}
                      </td>
                      <td>Objectif cible : &gt; 68%</td>
                    </tr>

                    {/* SECTION 4: PERSONNEL */}
                    <tr style={{ background: 'var(--cream-light)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--red)' }}>4. CHARGES DE PERSONNEL</td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>
                        {formatCurrency(data.activeLabor)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--red)' }}>
                        {formatPercent(calculateRatio(data.activeLabor))}
                      </td>
                      <td>Ressources Humaines</td>
                    </tr>
                    <PnlRow
                      label="Salaires & Charges réels (Banque)"
                      value={data.laborBank}
                      ratio={calculateRatio(data.laborBank)}
                      color="var(--red)"
                      note="Flux bancaires salaires (cliquer pour voir/exclure)"
                      onClick={() => openDetail('labor_bank')}
                    />
                    <PnlRow
                      label="Salaires planifiés / Pointage (Timecards)"
                      value={data.laborTimecards}
                      ratio={calculateRatio(data.laborTimecards)}
                      color="var(--red)"
                      note="Timecards Square (cliquer pour voir/exclure)"
                      onClick={() => openDetail('labor_timecards')}
                    />

                    {/* SECTION 5: CHARGES FIXES */}
                    <tr style={{ background: 'var(--cream-light)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--text-secondary)' }}>5. CHARGES FIXES & STRUCTURE</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                        {formatCurrency(data.totalFixedCharges)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                        {formatPercent(calculateRatio(data.totalFixedCharges))}
                      </td>
                      <td>Frais généraux & structure</td>
                    </tr>
                    <PnlRow
                      label="Loyers & Charges locatives"
                      value={data.chargesLoyer}
                      ratio={calculateRatio(data.chargesLoyer)}
                      note="Loyers immobiliers (cliquer pour voir/exclure)"
                      onClick={() => openDetail('charges_loyer')}
                    />
                    <PnlRow
                      label="Assurances d'exploitation"
                      value={data.chargesAssurance}
                      ratio={calculateRatio(data.chargesAssurance)}
                      note="RC Pro, locaux (cliquer pour voir/exclure)"
                      onClick={() => openDetail('charges_assurance')}
                    />
                    <PnlRow
                      label="Abonnements (Logiciels, internet...)"
                      value={data.chargesAbonnement}
                      ratio={calculateRatio(data.chargesAbonnement)}
                      note="Outils SAAS, telecom (cliquer pour voir/exclure)"
                      onClick={() => openDetail('charges_abonnement')}
                    />
                    <PnlRow
                      label="Impôts & Taxes"
                      value={data.chargesImpot}
                      ratio={calculateRatio(data.chargesImpot)}
                      note="Taxes foncières, impôts (cliquer pour voir/exclure)"
                      onClick={() => openDetail('charges_impot')}
                    />
                    <PnlRow
                      label="Achats de Matériel non immobilisé"
                      value={data.purchasesMateriel}
                      ratio={calculateRatio(data.purchasesMateriel)}
                      note="Factures matériel (cliquer pour voir/exclure)"
                      onClick={() => openDetail('purchases_materiel')}
                    />
                    <PnlRow
                      label="Frais divers & Autres charges"
                      value={data.chargesAutreBank + data.purchasesAutreInvoices}
                      ratio={calculateRatio(data.chargesAutreBank + data.purchasesAutreInvoices)}
                      note="Banque & Factures divers (cliquer pour voir/exclure)"
                      onClick={() => openDetail('charges_autre_bank')}
                    />

                    {/* EBITDA */}
                    <tr style={{ 
                      background: data.ebitda >= 0 ? 'var(--green-light)' : 'var(--red-light)', 
                      fontWeight: 800,
                      fontSize: 15
                    }}>
                      <td style={{ color: data.ebitda >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        EXCÉDENT BRUT D&apos;EXPLOITATION (EBE / EBITDA)
                      </td>
                      <td style={{ 
                        textAlign: 'right', 
                        color: data.ebitda >= 0 ? 'var(--green)' : 'var(--red)' 
                      }}>
                        {formatCurrency(data.ebitda)}
                      </td>
                      <td style={{ 
                        textAlign: 'right', 
                        color: data.ebitda >= 0 ? 'var(--green)' : 'var(--red)' 
                      }}>
                        {formatPercent(data.ebitdaPercent)}
                      </td>
                      <td style={{ color: data.ebitda >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {data.ebitda >= 0 ? 'Rentable' : 'Déficitaire sur la période'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Note context */}
            <div style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'white', fontSize: 12, color: 'var(--text-muted)' }}>
              <Info size={16} style={{ flexShrink: 0, color: 'var(--teal)' }} />
              <div>
                Le compte de résultat (P&L) consolide de façon asynchrone les données de vente de votre caisse Square avec les écritures comptables extraites de vos factures et relevés bancaires. Toute transaction bancaire pointée avec sa facture est consolidée afin de vous offrir une vision nette et exempte de doublons.
              </div>
            </div>
          </>
        )}
      </div>

      {/* Rendu dynamique de la modale de détail */}
      {renderDetailModal()}

      {/* Style additionnel pour survoler les lignes */}
      <style jsx global>{`
        .interactive-row:hover td {
          background-color: var(--cream-dark) !important;
        }
      `}</style>
    </>
  );
}
