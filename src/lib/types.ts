// =============================================
// QENTINA — Types TypeScript
// =============================================

export interface Supplier {
  id: string;
  name: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  supplier_id: string | null;
  invoice_number: string | null;
  date: string;
  total_ht: number | null;
  total_ttc: number | null;
  pdf_url: string | null;
  created_at: string;
  supplier?: Supplier;
}

export type InvoiceLineCategory = 'alimentaire' | 'materiel' | 'emballage' | 'boisson' | 'autre';

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  designation: string;
  quantity: number | null;
  unit: string | null;
  unit_price_ht: number | null;
  total_ht: number | null;
  category: InvoiceLineCategory | null;
  created_at: string;
}

export interface Ingredient {
  id: string;
  name: string;
  unit: string | null;
  last_unit_price: number | null;
  last_updated: string | null;
  created_at: string;
}

export type RecipeCategory = 'pizza' | 'panuozzo' | 'salade' | 'plat' | 'dessert' | 'protocole_pate' | 'base_sauce';

export interface Recipe {
  id: string;
  name: string;
  category: RecipeCategory;
  portions: number;
  selling_price: number | null;
  created_at: string;
  recipe_ingredients?: RecipeIngredient[];
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  ingredient_id?: string | null;
  sub_recipe_id?: string | null;
  quantity: number | null;
  unit: string | null;
  ingredient?: Ingredient;
}

export interface InventoryCount {
  id: string;
  ingredient_id: string;
  quantity: number;
  unit_price: number | null;
  counted_at: string;
  ingredient?: Ingredient;
}

export interface SquareOrder {
  id: string;
  square_order_id: string;
  total_money: number | null;
  net_amount: number | null;
  discount_amount: number | null;
  service: string;
  created_at: string;
}

export interface SquareItem {
  id: string;
  order_id: string;
  name: string | null;
  quantity: number | null;
  base_price: number | null;
  total_price: number | null;
}

export interface LaborTimecard {
  id: string;
  employee_name: string | null;
  start_at: string | null;
  end_at: string | null;
  hours_worked: number | null;
  hourly_rate: number | null;
}

// Extraction Claude
export interface ExtractedInvoice {
  fournisseur: string;
  date: string;
  numero_facture: string;
  total_ht: number;
  total_ttc: number;
  lignes: ExtractedLine[];
}

export interface ExtractedLine {
  designation: string;
  quantite: number;
  unite: string;
  prix_unitaire_ht: number;
  prix_total_ht: number;
  categorie: InvoiceLineCategory;
}

// Dashboard KPIs
export interface DashboardKPIs {
  foodCostPercent: number;
  caTotal: number;
  ticketMoyen: number;
  nbCommandes: number;
  ratioMasseSalariale: number;
  stockValorise: number;
  topProduits: { name: string; quantity: number }[];
  caEvolution: { date: string; ca: number }[];
  margeParRecette: { name: string; marge: number; foodCost: number }[];
}

export type PeriodFilter = 'today' | 'week' | 'month' | 'year' | 'custom';

// Comptes Courants d'Associés (CCA)
export type CcaAssocie = 'justine' | 'yohan';
export type CcaSens = 'apport' | 'remboursement';
export type CcaSousType = 'facture_payee_perso' | 'avance_tresorerie' | 'frais_perso_reverse';

export interface MouvementCca {
  id: string;
  date: string;
  associe: CcaAssocie;
  sens: CcaSens;
  sous_type: CcaSousType;
  montant: number;
  piece_justif: string | null;
  rapproche_banque: boolean;
  date_virement_banque: string | null;
  note: string | null;
  bank_transaction_id: string | null;
  invoice_id: string | null;
  created_at: string;
}
