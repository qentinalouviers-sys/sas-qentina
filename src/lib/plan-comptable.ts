/**
 * plan-comptable.ts — Où va chaque flux dans le plan comptable général.
 *
 * Un seul exemplaire, pour que l'export comptable, le P&L et le Scanner
 * parlent le même langage. Les numéros suivent le PCG ; le cabinet pourra
 * les remapper vers son propre plan, l'important est la cohérence d'un mois
 * à l'autre.
 */

export interface Compte { num: string; lib: string }

/** Comptes de charges par classe portée par une facture (colonne accounting_class). */
export const CHARGES_PAR_CLASSE: Record<string, Compte> = {
  '601':  { num: '601000', lib: 'Achats de matières premières (alimentaire)' },
  '607':  { num: '607000', lib: 'Achats de marchandises (boissons)' },
  '606':  { num: '606300', lib: 'Fournitures d\'entretien et petit équipement' },
  '6061': { num: '606100', lib: 'Fournitures non stockables (eau, énergie)' },
  '61':   { num: '613000', lib: 'Locations' },
  '62':   { num: '626000', lib: 'Frais postaux et télécommunications' },
  '63':   { num: '635000', lib: 'Impôts et taxes' },
  '64':   { num: '641000', lib: 'Rémunérations du personnel' },
  autre:  { num: '604000', lib: 'Achats d\'études et prestations' },
};

/** Comptes de charges par catégorie de LIGNE de facture — plus fin que la classe. */
export const CHARGES_PAR_CATEGORIE_LIGNE: Record<string, Compte> = {
  alimentaire: { num: '601000', lib: 'Achats de matières premières (alimentaire)' },
  boisson:     { num: '607000', lib: 'Achats de marchandises (boissons)' },
  emballage:   { num: '602600', lib: 'Emballages' },
  materiel:    { num: '606300', lib: 'Fournitures d\'entretien et petit équipement' },
  autre:       { num: '604000', lib: 'Achats d\'études et prestations' },
};

/**
 * Contrepartie d'un mouvement bancaire selon sa catégorie.
 * Sans facture, aucune TVA n'est isolée (art. 271 CGI) : le TTC entier va au
 * compte de charge, et le cabinet arbitre s'il le souhaite.
 */
export const BANQUE_PAR_CATEGORIE: Record<string, Compte> = {
  variable_fournisseur: { num: '601000', lib: 'Achats de matières premières (alimentaire)' },
  fixe_loyer:           { num: '613200', lib: 'Locations immobilières' },
  fixe_assurance:       { num: '616000', lib: 'Primes d\'assurance' },
  fixe_abonnement:      { num: '628100', lib: 'Abonnements et cotisations' },
  variable_salaire:     { num: '641000', lib: 'Rémunérations du personnel' },
  impot_taxe:           { num: '635000', lib: 'Impôts et taxes' },
  investissement:       { num: '218300', lib: 'Matériel de bureau et informatique / équipement' },
  recette:              { num: '758000', lib: 'Produits divers de gestion courante' },
  flux_financier:       { num: '580000', lib: 'Virements internes' },
  autre:                { num: '471000', lib: 'Compte d\'attente' },
};

export const COMPTES = {
  banque:          { num: '512000', lib: 'Banque' } as Compte,
  fournisseurs:    { num: '401000', lib: 'Fournisseurs' } as Compte,
  clientsSquare:   { num: '411100', lib: 'Clients — encaissements Square' } as Compte,
  tvaDeductible:   { num: '445660', lib: 'TVA déductible sur autres biens et services' } as Compte,
  tvaCollectee:    { num: '445710', lib: 'TVA collectée' } as Compte,
  ventes10:        { num: '707100', lib: 'Ventes de marchandises — 10 %' } as Compte,
  ventes55:        { num: '707200', lib: 'Ventes de marchandises — 5,5 %' } as Compte,
  ventes20:        { num: '707300', lib: 'Ventes de marchandises — 20 %' } as Compte,
  ventesNonVentile:{ num: '707000', lib: 'Ventes de marchandises — taux non ventilé' } as Compte,
  cca:             { num: '455000', lib: 'Associés — comptes courants' } as Compte,
  deplacements:    { num: '625100', lib: 'Voyages et déplacements' } as Compte,
  attente:         { num: '471000', lib: 'Compte d\'attente' } as Compte,
};

/** Compte de vente selon la tranche de TVA. */
export function compteVentes(rate: '5.5%' | '10%' | '20%' | 'nonVentile'): Compte {
  switch (rate) {
    case '10%': return COMPTES.ventes10;
    case '5.5%': return COMPTES.ventes55;
    case '20%': return COMPTES.ventes20;
    default: return COMPTES.ventesNonVentile;
  }
}

/** Compte auxiliaire fournisseur : « 401METRO », lisible dans un grand livre. */
export function compteAuxiliaireFournisseur(name: string | null | undefined): { num: string; lib: string } {
  const lib = (name || 'Fournisseur inconnu').trim();
  const slug = lib.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'INCONNU';
  return { num: `401${slug}`, lib };
}
