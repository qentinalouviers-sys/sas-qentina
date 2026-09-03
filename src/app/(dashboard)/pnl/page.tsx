'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchAllRows, fetchAllRowsIn } from '@/lib/supabase/fetch-all';
import { formatCurrency, formatPercent, getDateRange, toISODate, formatDate } from '@/lib/utils';
import {
  isFinancialFlow, orderHtAmount, bankAmountHt, makeInvoiceMatcher,
} from '@/lib/accounting';
import { inventorySessions, computeCogs, type CogsResult } from '@/lib/cogs';
import ClosuresPanel from '@/components/ClosuresPanel';
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
  Tag,
} from 'lucide-react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { PeriodFilter } from '@/lib/types';

/**
 * Catégories bancaires proposées dans le détail du P&L.
 *
 * Une écriture qu'on voudrait « sortir » du résultat est en réalité mal
 * classée : un remboursement d'emprunt rangé en fournisseur, un virement
 * perso compté en recette. On la corrige à la source — la catégorie — et le
 * P&L, la TVA et le tableau de bord suivent tous. L'ancien bouton « masquer »
 * retirait l'écriture du seul P&L, sans motif ni trace : un compte de
 * résultat qu'on peut ajuster en silence n'est pas un outil comptable.
 */
const BANK_CATEGORIES: Record<string, string> = {
  variable_fournisseur: 'Fournisseurs (coût matières)',
  fixe_loyer: 'Loyer & charges locatives',
  fixe_assurance: 'Assurances',
  fixe_abonnement: 'Abonnements & honoraires',
  variable_salaire: 'Salaires & charges sociales',
  impot_taxe: 'Impôts & taxes',
  investissement: 'Équipement & travaux',
  recette: 'Encaissement (hors chiffre d\'affaires)',
  flux_financier: 'Flux financier — hors résultat',
  autre: 'Non classé',
};

const LINE_CATEGORIES: Record<string, string> = {
  alimentaire: 'Alimentaire',
  boisson: 'Boissons',
  emballage: 'Emballages',
  materiel: 'Matériel',
  autre: 'Autre',
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
  // Écritures que l'ancien bouton « masquer » excluait du P&L. Elles sont
  // réintégrées ; on garde le compte pour le dire une fois, et proposer de
  // les recatégoriser.
  const [legacyMaskedCount, setLegacyMaskedCount] = useState(0);
  const [recategorizing, setRecategorizing] = useState<string | null>(null);
  const [data, setData] = useState({
    // CA — la caisse Square est la référence
    caSquare: 0,
    caBank: 0,
    totalCA: 0,

    // Hors exploitation : prêts, apports, compte courant, trésorerie
    fluxFinanciersTotal: 0,
    fluxFinanciersCount: 0,
    fluxFinanciersList: [] as any[],
    // Paiements écartés parce que déjà couverts par une facture de la période
    paiementsDejaFactures: 0,

    // Achats (Coûts Variables)
    purchasesAlim: 0,
    purchasesBoisson: 0,
    purchasesEmballage: 0,
    purchasesMateriel: 0,
    purchasesAutreInvoices: 0,
    bankSuppliersUnreconciled: 0,
    totalCogs: 0, // Coût matières CONSOMMÉ (achats ± variation de stock)
    achatsHt: 0,       // achats de la période, avant variation de stock
    cogsFactures: 0,   // ventilé ligne à ligne : exact
    cogsBanque: 0,     // paiements sans détail : majorant
    partBanquePercent: 0,
    cogs: null as CogsResult | null,
    
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
    chargesInvestissement: 0,
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
      // Toute lecture dont le volume dépend de la période est paginée :
      // Supabase tronque à 1 000 lignes sans le signaler, et sur un exercice
      // complet le chiffre d'affaires s'en trouvait amputé de 44 %.
      const [
        { data: settingsData },
        orders,
        bankRecettes,
        invoices,
        bankSuppliers,
        timecards,
        bankSalaries,
        fixedTx,
        inventoryCounts,
      ] = await Promise.all([
        // A. IDs masqués depuis app_settings
        supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'masked_items'),
        // 1. Chiffre d'Affaires (Square Orders)
        fetchAllRows<any>((f0, f1) => supabase
          .from('square_orders')
          .select('id, net_amount, service, square_order_id, created_at, raw_data')
          .gte('service', startStr)
          .lte('service', endStr)
          .order('service', { ascending: false })
          .range(f0, f1)),
        // CA Banque (Recettes)
        fetchAllRows<any>((f0, f1) => supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status, category')
          .eq('category', 'recette')
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false })
          .range(f0, f1)),
        // 2. Factures fournisseurs.
        // `total_ttc` sert au rapprochement souple ci-dessous : sans lui, une
        // facture scannée et son paiement bancaire non lettré sont comptés
        // deux fois dans le coût matières.
        fetchAllRows<any>((f0, f1) => supabase
          .from('invoices')
          .select('id, date, total_ttc')
          .gte('date', startStr)
          .lte('date', endStr)
          .range(f0, f1)),
        // Achats Fournisseurs non lettrés (dans banque directement, non lié à facture)
        fetchAllRows<any>((f0, f1) => supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status, category')
          .eq('category', 'variable_fournisseur')
          .is('invoice_id', null)
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false })
          .range(f0, f1)),
        // 3. Masse Salariale — Timecards (Salaires théoriques)
        fetchAllRows<any>((f0, f1) => supabase
          .from('labor_timecards')
          .select('id, employee_name, start_at, end_at, hours_worked, hourly_rate')
          .gte('start_at', start.toISOString())
          .lte('start_at', end.toISOString())
          .order('start_at', { ascending: false })
          .range(f0, f1)),
        // Banque Salaires & Charges
        fetchAllRows<any>((f0, f1) => supabase
          .from('bank_transactions')
          .select('id, date, description, amount, status, category')
          .eq('category', 'variable_salaire')
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false })
          .range(f0, f1)),
        // 4. Charges Fixes (Banque)
        fetchAllRows<any>((f0, f1) => supabase
          .from('bank_transactions')
          .select('id, date, description, amount, category, status')
          .in('category', ['fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'impot_taxe', 'investissement', 'autre'])
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: false })
          .range(f0, f1)),
        // Inventaires : pour passer des achats au coût matières consommé.
        fetchAllRows<{ ingredient_id: string; quantity: number | null; unit_price: number | null; counted_at: string }>((f0, f1) => supabase
          .from('inventory_counts')
          .select('ingredient_id, quantity, unit_price, counted_at')
          .range(f0, f1)),
      ]);

      const legacyMasked: string[] = settingsData && settingsData.length > 0 && settingsData[0].value
        ? JSON.parse(settingsData[0].value)
        : [];
      setLegacyMaskedCount(legacyMasked.length);

      // 1. Chiffre d'Affaires (Square Orders)
      const ordersList = orders || [];
      const activeOrders = ordersList;
      const caSquare = activeOrders.reduce((s: number, o: any) => s + orderHtAmount(o), 0);

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
      const activeBankRecettes = bankRecettesList;
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
        // Une facture Metro peut compter plus de cent lignes : quelques
        // dizaines de factures suffisent à dépasser le plafond des 1 000.
        invoiceLinesList = await fetchAllRowsIn<any, string>(invoiceIds, (ids, f0, f1) => supabase
          .from('invoice_lines')
          .select('id, total_ht, designation, quantity, unit, unit_price_ht, category, invoice:invoices(date, invoice_number, supplier:suppliers(name))')
          .in('invoice_id', ids)
          .range(f0, f1));
        
        const activeInvoiceLines = invoiceLinesList;
        
        activeInvoiceLines.forEach((l: any) => {
          const amt = l.total_ht || 0;
          if (l.category === 'alimentaire') purchasesAlim += amt;
          else if (l.category === 'boisson') purchasesBoisson += amt;
          else if (l.category === 'emballage') purchasesEmballage += amt;
          else if (l.category === 'materiel') purchasesMateriel += amt;
          else purchasesAutreInvoices += amt;
        });
      }

      // ── Rapprochement souple facture ↔ paiement ───────────────────────────
      // Voir `makeInvoiceMatcher` : un paiement égal au centime au TTC d'une
      // facture de la période est déjà compté par cette facture. Le compter
      // aussi doublerait l'achat — c'est ce qui gonflait le coût matières.
      const matcher = makeInvoiceMatcher((invoices || []) as any[]);

      // Achats Fournisseurs non lettrés (dans banque directement, non lié à facture)
      const bankSuppliersUnreconciledList = sansFlux(bankSuppliers || [])
        .filter((t: any) => !matcher.alreadyInvoiced(t));
      const activeBankSuppliers = bankSuppliersUnreconciledList;
      // Les lignes de factures sont en HT, les montants bancaires en TTC :
      // on ramène ces derniers en HT pour que le ratio reste comparable.
      const bankSuppliersUnreconciled = activeBankSuppliers.reduce(
        (s: number, t: any) => s + bankAmountHt(t, 'variable_fournisseur'), 0
      );
      // ── Deux food cost, et il faut les distinguer ─────────────────────────
      //
      // Une facture SCANNÉE est ventilée ligne à ligne : le bac gastro et le
      // produit d'entretien achetés chez Metro partent en « matériel », hors
      // coût matières. C'est exact.
      //
      // Un PAIEMENT BANCAIRE non rapproché n'a aucun détail : le virement Metro
      // entre en entier, entretien et petit matériel compris. C'est donc un
      // MAJORANT, pas une mesure.
      //
      // Tant que la part bancaire domine, le food cost affiché est un plafond.
      // On garde les deux pour pouvoir le dire — un ratio dont on ignore la
      // fiabilité ne vaut pas mieux qu'une absence de ratio.
      const cogsFactures = purchasesAlim + purchasesBoisson + purchasesEmballage;
      const cogsBanque = bankSuppliersUnreconciled;
      const achatsHt = cogsFactures + cogsBanque;
      const partBanquePercent = achatsHt > 0 ? (cogsBanque / achatsHt) * 100 : 0;

      // Coût matières CONSOMMÉ = stock initial + achats − stock final. Quand
      // deux inventaires encadrent la période ; sinon les achats, et on le dit.
      const cogs = computeCogs({
        purchases: achatsHt,
        sessions: inventorySessions(inventoryCounts),
        start: startStr,
        end: endStr,
      });
      const totalCogs = cogs.cogs;

      // 3. Masse Salariale
      // Timecards (Salaires théoriques)
      const timecardsList = timecards || [];
      const activeTimecards = timecardsList;
      const laborTimecards = activeTimecards.reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);

      // Banque Salaires & Charges
      const bankSalariesList = sansFlux(bankSalaries || []);
      const activeBankSalaries = bankSalariesList;
      const laborBank = activeBankSalaries.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);

      // Utiliser les flux réels banque si dispos, sinon timecards comme coût théorique
      const useBankLabor = laborBank > 0;
      const activeLabor = useBankLabor ? laborBank : laborTimecards;

      // 4. Charges Fixes (Banque) — mêmes deux précautions que pour les achats :
      // on écarte les paiements déjà couverts par une facture de la période, et
      // on ramène les montants en HT.
      const fixedTxList = sansFlux(fixedTx || [])
        .filter((t: any) => !matcher.alreadyInvoiced(t));
      const activeFixedTx = fixedTxList;

      let chargesLoyer = 0;
      let chargesAssurance = 0;
      let chargesAbonnement = 0;
      let chargesImpot = 0;
      let chargesInvestissement = 0;
      let chargesAutreBank = 0;

      activeFixedTx.forEach((t: any) => {
        const amt = bankAmountHt(t);
        if (t.category === 'fixe_loyer') chargesLoyer += amt;
        else if (t.category === 'fixe_assurance') chargesAssurance += amt;
        else if (t.category === 'fixe_abonnement') chargesAbonnement += amt;
        else if (t.category === 'impot_taxe') chargesImpot += amt;
        else if (t.category === 'investissement') chargesInvestissement += amt;
        else if (t.category === 'autre') chargesAutreBank += amt;
      });

      // Inclure les factures de "matériel" et "autres factures" (hors alim/boisson/emballage) dans les charges d'exploitation.
      //
      // L'équipement et les travaux (`investissement`) restent DEHORS : ce sont
      // des dépenses ponctuelles. Les mêler aux charges fixes gonfle le coût de
      // structure du mois où elles tombent et le fait paraître meilleur les mois
      // suivants — on ne peut plus lire de tendance. Ils apparaissent sur leur
      // propre ligne, sous le résultat d'exploitation.
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
        paiementsDejaFactures: matcher.count(),
        purchasesAlim,
        purchasesBoisson,
        purchasesEmballage,
        purchasesMateriel,
        purchasesAutreInvoices,
        bankSuppliersUnreconciled,
        totalCogs,
        achatsHt,
        cogsFactures,
        cogsBanque,
        partBanquePercent,
        cogs,
        laborTimecards,
        laborBank,
        activeLabor,
        isLaborTheoretical: !useBankLabor,
        chargesLoyer,
        chargesAssurance,
        chargesAbonnement,
        chargesImpot,
        chargesInvestissement,
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

  // Corriger la catégorie d'une écriture, à la source. Le P&L se recharge :
  // la TVA et le tableau de bord verront la même correction.
  const recategorizeBank = async (id: string, category: string) => {
    setRecategorizing(id);
    const { error } = await createClient().from('bank_transactions').update({ category }).eq('id', id);
    setRecategorizing(null);
    if (error) { alert(`Recatégorisation impossible : ${error.message}`); return; }
    loadData();
  };

  const recategorizeLine = async (id: string, category: string) => {
    setRecategorizing(id);
    const { error } = await createClient().from('invoice_lines').update({ category }).eq('id', id);
    setRecategorizing(null);
    if (error) { alert(`Recatégorisation impossible : ${error.message}`); return; }
    loadData();
  };

  // Les écritures ex-masquées sont réintégrées ; une fois relues, on retire l'avis.
  const dismissLegacyMasked = async () => {
    const { error } = await createClient().from('app_settings').delete().eq('key', 'masked_items');
    if (error) { alert(`Impossible de retirer l'avis : ${error.message}`); return; }
    setLegacyMaskedCount(0);
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
            <strong key="amt" style={{ color: 'var(--teal)' }}>{formatCurrency(orderHtAmount(o))}</strong>
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
      case 'charges_investissement':
      case 'charges_autre_bank':
        const bankCat = activeDetail === 'charges_loyer' ? 'fixe_loyer'
                     : activeDetail === 'charges_assurance' ? 'fixe_assurance'
                     : activeDetail === 'charges_abonnement' ? 'fixe_abonnement'
                     : activeDetail === 'charges_impot' ? 'impot_taxe'
                     : activeDetail === 'charges_investissement' ? 'investissement'
                     : 'autre';

        const categoryLabels: Record<string, string> = {
          fixe_loyer: 'Loyers & Charges locatives',
          fixe_assurance: 'Assurances',
          fixe_abonnement: 'Abonnements & honoraires',
          investissement: 'Équipement & travaux',
          impot_taxe: 'Impôts & Taxes',
          autre: 'Dépenses non classées'
        };

        title = `Détail : ${categoryLabels[bankCat]}`;
        headers = ['Date Opération', 'Libellé de l\'opération', 'Montant'];
        
        rawItemsList = data.fixedTxList.filter((t: any) => t.category === bankCat);
        formatRowFunction = makeBankRowFormatter('var(--text-primary)');
        break;
      
      default:
        return null;
    }

    // 2. Filtrage des éléments pour la recherche
    const searchLower = searchQuery.toLowerCase();

    const displayedItems = rawItemsList.filter((item: any) => {
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

    const activeItemsList = rawItemsList;

    if (activeDetail === 'labor_timecards') {
      consolidatedSum = activeItemsList.reduce((s: number, t: any) => s + (t.hours_worked || 0) * (t.hourly_rate || 0), 0);
    } else if (activeDetail.startsWith('purchases_')) {
      consolidatedSum = activeItemsList.reduce((s: number, l: any) => s + (l.total_ht || 0), 0);
    } else if (activeDetail === 'ca_square') {
      consolidatedSum = activeItemsList.reduce((s: number, o: any) => s + orderHtAmount(o), 0);
    } else {
      consolidatedSum = activeItemsList.reduce((s: number, t: any) => s + Math.abs(t.amount || 0), 0);
    }

    // Une catégorie se corrige sur une écriture bancaire ou une ligne de
    // facture. Une vente Square ou un pointage n'ont pas de catégorie à
    // discuter : une vente est une vente.
    const isBankDetail = ['ca_bank', 'flux_financiers', 'bank_suppliers_unreconciled', 'labor_bank'].includes(activeDetail)
      || activeDetail.startsWith('charges_');
    const isLineDetail = activeDetail.startsWith('purchases_');
    const finalHeaders = (isBankDetail || isLineDetail) ? [...headers, 'Catégorie'] : headers;

    return (
      <div className="modal-overlay" onClick={() => setActiveDetail(null)}>
        <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <h3 className="modal-title">{title}</h3>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Total : <strong>{formatCurrency(consolidatedSum)}</strong> ({activeItemsList.length} écriture(s))
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
          </div>

          <div className="table-container" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {displayedItems.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px' }}>
                <p>Aucune écriture trouvée.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    {finalHeaders.map((h, idx) => {
                      const isRightAlign = idx === finalHeaders.length - 2 || 
                                           ['Montant', 'Total HT', 'Total Brut', 'Prix U. HT'].includes(h);
                      const isCenterAlign = h === 'Catégorie';
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
                    const busy = recategorizing === rowData.id;

                    return (
                      <tr key={rowData.id} style={busy ? { opacity: 0.5 } : undefined}>
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
                        {(isBankDetail || isLineDetail) && (
                          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Tag size={13} style={{ color: 'var(--text-muted)' }} />
                              <select
                                className="form-select"
                                style={{ minHeight: 32, padding: '2px 8px', fontSize: 12 }}
                                value={item.category || 'autre'}
                                disabled={busy}
                                title="Corriger la catégorie de cette écriture, à la source"
                                onChange={e => isBankDetail
                                  ? recategorizeBank(rowData.id, e.target.value)
                                  : recategorizeLine(rowData.id, e.target.value)}
                              >
                                {Object.entries(isBankDetail ? BANK_CATEGORIES : LINE_CATEGORIES).map(([k, label]) => (
                                  <option key={k} value={k}>{label}</option>
                                ))}
                              </select>
                            </span>
                          </td>
                        )}
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
            Cliquez sur une ligne pour voir les écritures et corriger une catégorie
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
                  <div style={{ marginTop: 3, color: data.cogs?.method === 'inventaire' ? 'var(--green)' : 'var(--text-muted)' }}>
                    {data.cogs?.method === 'inventaire'
                      ? `mesuré : inventaires du ${formatDate(data.cogs.opening!.day)} et du ${formatDate(data.cogs.closing!.day)}`
                      : 'sur achats — pas d\'inventaire aux bornes'}
                  </div>
                  {data.partBanquePercent >= 10 && (
                    <div style={{ marginTop: 3, color: 'var(--orange)' }}>
                      dont {formatPercent(data.partBanquePercent)} sans détail — majorant
                    </div>
                  )}
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

            {data.paiementsDejaFactures > 0 && (
              <div className="alert alert-success" style={{ marginBottom: 20, background: 'rgba(42, 125, 123, 0.05)', color: 'var(--teal)', borderColor: 'rgba(42, 125, 123, 0.2)' }}>
                <Info size={16} />
                <span>
                  <strong>{data.paiementsDejaFactures} paiement(s) déjà couvert(s) par une facture :</strong> leur montant correspond au centime au TTC d&apos;une facture scannée de la période. Ils sont écartés du coût matières pour ne pas compter l&apos;achat deux fois. Fais le rapprochement bancaire pour rendre cet appariement définitif.
                </span>
              </div>
            )}

            {legacyMaskedCount > 0 && (
              <div className="alert alert-warning" style={{ marginBottom: 20, alignItems: 'flex-start' }}>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span style={{ flex: 1 }}>
                  <strong>{legacyMaskedCount} écriture(s) étaient exclues du résultat à la main.</strong> Le bouton
                  « masquer » n&apos;existe plus : un compte de résultat qu&apos;on peut ajuster sans trace n&apos;est pas
                  un outil comptable. Ces écritures sont réintégrées. Si l&apos;une d&apos;elles n&apos;a rien à faire dans le
                  résultat (emprunt, virement perso, doublon), ouvre le détail de son poste et corrige sa
                  <strong> catégorie</strong> — la correction vaut alors aussi pour la TVA et le tableau de bord.
                </span>
                <button className="btn btn-secondary btn-sm" onClick={dismissLegacyMasked} style={{ flexShrink: 0 }}>
                  J&apos;ai relu, retirer cet avis
                </button>
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
                      <td style={{ color: 'var(--orange)' }}>2. COÛT MATIÈRES CONSOMMÉ</td>
                      <td style={{ textAlign: 'right', color: 'var(--orange)' }}>
                        {formatCurrency(data.totalCogs)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--orange)' }}>
                        {formatPercent(calculateRatio(data.totalCogs))}
                      </td>
                      <td>{data.cogs?.method === 'inventaire' ? 'Achats ± variation de stock' : 'Achats de la période (pas d\'inventaire aux bornes)'}</td>
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
                      note="Sans facture : contenu inconnu, matériel compris (cliquer pour voir)"
                      onClick={() => openDetail('bank_suppliers_unreconciled')}
                    />

                    {/* Variation de stock : ce qui a été acheté mais pas consommé
                        (ou consommé sur le stock du mois précédent). Signe
                        comptable : un stock qui grossit RÉDUIT le coût consommé. */}
                    {data.cogs?.method === 'inventaire' && (
                      <tr className="interactive-row">
                        <td style={{ paddingLeft: 32 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Eye size={12} style={{ color: 'var(--orange)' }} /> Variation de stock
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', color: data.cogs.stockVariation > 0 ? 'var(--green)' : 'var(--red)' }}>
                          {data.cogs.stockVariation > 0 ? '−' : '+'}{formatCurrency(Math.abs(data.cogs.stockVariation))}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{formatPercent(calculateRatio(-data.cogs.stockVariation))}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Stock {formatCurrency(data.cogs.opening!.value)} le {formatDate(data.cogs.opening!.day)} → {formatCurrency(data.cogs.closing!.value)} le {formatDate(data.cogs.closing!.day)}, sur {data.cogs.commonProducts} produits comptés aux deux dates
                        </td>
                      </tr>
                    )}
                    {data.cogs && data.cogs.method === 'achats' && data.achatsHt > 0 && (
                      <tr>
                        <td colSpan={4} style={{ padding: '8px 16px 8px 32px', fontSize: 12, color: 'var(--text-muted)' }}>
                          Coût matières calculé sur les achats : {data.cogs.reason} Un inventaire au tournant du mois le transformerait en consommation réelle.
                        </td>
                      </tr>
                    )}

                    {/* Le food cost ne vaut que ce que vaut son détail. Tant
                        qu'une part vient de virements bruts, c'est un plafond,
                        pas une mesure — et l'écart entre les deux est
                        exactement ce que le scan des factures ferait gagner. */}
                    {data.partBanquePercent >= 10 && (
                      <tr>
                        <td colSpan={4} style={{ padding: '10px 16px 10px 32px', background: 'var(--orange-light)' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#9A6B1F', lineHeight: 1.5 }}>
                            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                            <span>
                              <strong>Ce food cost est un maximum, pas une mesure.</strong>{' '}
                              {formatPercent(data.partBanquePercent)} vient de virements fournisseurs
                              sans facture ({formatCurrency(data.cogsBanque)}) : leur contenu est
                              inconnu, donc les produits d&apos;entretien, le film alimentaire et le
                              petit matériel achetés chez Metro y sont comptés comme de la nourriture.
                              Une facture scannée, elle, est ventilée ligne à ligne et sort le matériel
                              du calcul — le food cost réellement mesuré sur factures est de{' '}
                              <strong>{formatCurrency(data.cogsFactures)}</strong>, soit{' '}
                              <strong>{formatPercent(calculateRatio(data.cogsFactures))}</strong> du CA.
                              Le vrai chiffre est entre les deux.
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}

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
                      label="Dépenses non classées"
                      value={data.chargesAutreBank + data.purchasesAutreInvoices}
                      ratio={calculateRatio(data.chargesAutreBank + data.purchasesAutreInvoices)}
                      note="À catégoriser dans Banque (cliquer pour voir/exclure)"
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

                    {/* Équipement & travaux : sous l'EBE, jamais dedans.
                        Ce sont des dépenses ponctuelles. Les compter en charges
                        d'exploitation rendrait l'EBE incomparable d'un mois à
                        l'autre — alors que c'est justement sa raison d'être. */}
                    {data.chargesInvestissement > 0 && (
                      <>
                        <tr style={{ background: 'var(--cream-light)', fontWeight: 700 }}>
                          <td style={{ color: 'var(--text-secondary)' }}>
                            6. ÉQUIPEMENT &amp; TRAVAUX (hors exploitation)
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {formatCurrency(data.chargesInvestissement)}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {formatPercent(calculateRatio(data.chargesInvestissement))}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            Dépenses ponctuelles, exclues de l&apos;EBE
                          </td>
                        </tr>
                        <PnlRow
                          label="Détail équipement & travaux"
                          value={data.chargesInvestissement}
                          ratio={calculateRatio(data.chargesInvestissement)}
                          note="Achats de matériel, aménagement, réparations"
                          onClick={() => openDetail('charges_investissement')}
                        />
                      </>
                    )}
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
            <ClosuresPanel />
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
