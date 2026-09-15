/**
 * cca.ts — Compte courant d'associé : la règle « jamais débiteur ».
 *
 * Le verrou réel est un trigger Postgres (db/migration_cca_verrou.sql) : il
 * refuse toute opération qui rend un solde débiteur, quel que soit le chemin
 * emprunté. Ce module en est le miroir côté application, pour deux usages :
 *
 *  - dire à l'utilisateur AVANT d'envoyer pourquoi ça va être refusé, avec la
 *    date et le montant, plutôt qu'un message d'erreur après coup ;
 *  - tester la règle dans verify:compta, sans base.
 *
 * Les deux implémentations doivent dire la même chose. Si l'une change,
 * l'autre change.
 */

export interface CcaMovementLike {
  id?: string;
  date: string;
  associe: string;
  sens: 'apport' | 'remboursement';
  montant: number;
  created_at?: string | null;
}

export type CcaOperation =
  | { type: 'insert'; movement: CcaMovementLike }
  | { type: 'delete'; movement: CcaMovementLike };

export interface CcaViolation {
  associe: string;
  /** Premier jour où le solde passe sous zéro. */
  date: string;
  /** Solde ce jour-là (négatif). */
  solde: number;
}

/**
 * Ordre comptable : par date, et le même jour les apports avant les
 * remboursements. Une journée n'a pas de chronologie interne — on ne peut pas
 * rembourser avant d'avoir reçu, et présenter l'inverse est une erreur de
 * lecture, pas un fait.
 */
export function sortChronological<T extends CcaMovementLike>(movements: readonly T[]): T[] {
  return [...movements].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    const rank = (s: string) => (s === 'apport' ? 0 : 1);
    const r = rank(a.sens) - rank(b.sens);
    if (r !== 0) return r;
    return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  });
}

/**
 * Premier jour, à partir de `since`, où le solde de `associe` devient
 * négatif. `null` si le compte tient.
 */
export function firstDebitDay(
  movements: readonly CcaMovementLike[],
  associe: string,
  since: string,
): CcaViolation | null {
  let solde = 0;
  for (const m of sortChronological(movements.filter(m => m.associe === associe))) {
    solde = Math.round((solde + (m.sens === 'apport' ? m.montant : -m.montant)) * 100) / 100;
    if (m.date >= since && solde < -0.005) return { associe, date: m.date, solde };
  }
  return null;
}

/**
 * Ce que le trigger refusera si on applique `op` à `existing`.
 *
 * Un apport ajouté ou un remboursement supprimé ne peuvent qu'améliorer le
 * solde : ils passent sans contrôle. Les autres cas sont recalculés à partir
 * de la date de l'opération — un creux plus ancien n'est pas sa faute.
 */
export function checkCcaOperation(
  existing: readonly CcaMovementLike[],
  op: CcaOperation,
): CcaViolation | null {
  const m = op.movement;
  if (op.type === 'insert') {
    if (m.sens === 'apport') return null;
    return firstDebitDay([...existing, m], m.associe, m.date);
  }
  if (m.sens === 'remboursement') return null;
  const remaining = m.id ? existing.filter(e => e.id !== m.id) : existing;
  return firstDebitDay(remaining, m.associe, m.date);
}

/** Message pour l'utilisateur — le même fond que celui du trigger. */
export function describeCcaViolation(v: CcaViolation): string {
  const [y, mo, d] = v.date.split('-');
  const nom = v.associe.charAt(0).toUpperCase() + v.associe.slice(1);
  const montant = Math.abs(v.solde).toFixed(2).replace('.', ',');
  return (
    `Compte courant de ${nom} débiteur de ${montant} € au ${d}/${mo}/${y} : opération refusée.\n\n`
    + `Un compte courant débiteur est interdit au dirigeant (art. L.225-43 du code de commerce). `
    + `Enregistre d'abord l'apport qui couvre ce montant, ou choisis une date postérieure.`
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rapprochement des virements sortants
 *
 * Un compte courant n'est juste que si les DEUX sens sont enregistrés :
 *
 *   apport        ← une facture payée perso, une avance, des frais kilométriques
 *   remboursement ← le virement que la société t'envoie depuis le compte LCL
 *
 * Le second est le maillon faible : il ne se saisit nulle part à la main, il
 * n'existe que si le libellé bancaire contient un prénom et si la ligne est
 * restée au statut « en attente de facture ». Un virement libellé autrement —
 * « VIR SEPA DE FARIA », « VIREMENT COMPTE PERSO » — n'est jamais rapproché :
 * le compte courant reste crédité d'une somme déjà versée, et la société
 * s'affiche débitrice de ce qu'elle a déjà payé.
 *
 * Ce module dit, sur pièces, ce qui n'est pas rapproché — et ce qui l'est mal.
 * ──────────────────────────────────────────────────────────────────────────── */

import { normalizeName } from './referentiel';
import type { CcaAssocie } from './types';

export type { CcaAssocie };

/**
 * Termes reconnus dans un libellé bancaire pour désigner un associé.
 *
 * Volontairement limités aux prénoms par défaut : un nom de famille partagé
 * par les deux associés créditerait le mauvais compte courant, et c'est une
 * erreur qu'on ne voit pas passer. Les termes sont donc à compléter à la main
 * depuis la page Comptes Associés, en connaissance de cause (nom de famille,
 * fragment d'IBAN, libellé de virement permanent…).
 */
export const DEFAULT_TRANSFER_TERMS: Record<CcaAssocie, string[]> = {
  justine: ['justine'],
  yohan: ['yohan'],
};

/**
 * Libellés qui ressemblent à un virement mais ne vont jamais à un associé.
 * Purement cosmétique : ils sortent de la liste « à identifier » pour qu'il
 * reste lisible. Aucun rapprochement n'en dépend.
 */
const NON_ASSOCIATE_TERMS = [
  'urssaf', 'dgfip', 'impot', 'tresor public', 'tva', 'cotisation', 'mutuelle',
  'retraite', 'prevoyance', 'salaire', 'paie', 'loyer', 'assurance', 'leasing',
  'credit', 'pret', 'echeance', 'abonnement', 'sacem', 'cvae', 'cfe',
];

export function mergeTransferTerms(stored: unknown): Record<CcaAssocie, string[]> {
  const s = (stored ?? {}) as Partial<Record<CcaAssocie, unknown>>;
  const clean = (v: unknown, fallback: string[]): string[] => {
    const list = Array.isArray(v) ? v.map(t => String(t).trim()).filter(Boolean) : [];
    return list.length > 0 ? list : fallback;
  };
  return {
    justine: clean(s.justine, DEFAULT_TRANSFER_TERMS.justine),
    yohan: clean(s.yohan, DEFAULT_TRANSFER_TERMS.yohan),
  };
}

/**
 * L'associé désigné par un libellé bancaire, ou `null`.
 *
 * Renvoie `null` quand DEUX associés correspondent : mieux vaut une ligne à
 * trancher à la main qu'un compte courant crédité au hasard.
 */
export function matchAssociate(
  description: string,
  terms: Record<CcaAssocie, string[]> = DEFAULT_TRANSFER_TERMS
): CcaAssocie | null {
  const label = normalizeName(description);
  if (!label) return null;
  // La banque coupe et colle les libellés (« VIRDEFARIA ») : on compare aussi
  // sans les espaces, comme pour les fournisseurs.
  const tight = label.replace(/\s+/g, '');

  const hits = (Object.keys(terms) as CcaAssocie[]).filter(associe =>
    terms[associe].some(term => {
      const t = normalizeName(term);
      return t.length > 0 && (label.includes(t) || tight.includes(t.replace(/\s+/g, '')));
    })
  );
  return hits.length === 1 ? hits[0] : null;
}

/** Un libellé de virement émis (le signe du montant dit déjà qu'il sort). */
export function looksLikeTransfer(description: string): boolean {
  const label = normalizeName(description);
  return /(^|[^a-z])vir(ement|t)?([^a-z]|$)/.test(label);
}

/** Un virement dont le bénéficiaire est manifestement autre chose qu'un associé. */
function isObviouslyNotAssociate(description: string, knownPayees: readonly string[]): boolean {
  const label = normalizeName(description);
  if (NON_ASSOCIATE_TERMS.some(t => label.includes(t))) return true;
  return knownPayees.some(p => {
    const name = normalizeName(p);
    return name.length > 3 && label.includes(name);
  });
}

export interface CcaBankLine {
  id: string;
  date: string;
  description: string;
  amount: number;
}

export interface CcaMovementRow extends CcaMovementLike {
  id: string;
  sous_type?: string | null;
  rapproche_banque?: boolean | null;
  bank_transaction_id?: string | null;
  note?: string | null;
}

export interface CcaReconciliation {
  /** Virements sortants vers un associé identifié, sans mouvement de compte courant. */
  unlinked: { line: CcaBankLine; associe: CcaAssocie }[];
  /** Virements sortants dont le bénéficiaire reste à trancher à la main. */
  unidentified: CcaBankLine[];
  /** Remboursements enregistrés sans ligne bancaire en face. */
  refundsWithoutBank: CcaMovementRow[];
  /** Mouvements marqués « rapproché » sans lien réel : le drapeau ment. */
  flaggedWithoutLink: CcaMovementRow[];
  /** Plusieurs mouvements sur UNE ligne bancaire : le virement est compté deux fois. */
  doubleLinked: { bankTransactionId: string; movements: CcaMovementRow[] }[];
  /** Mouvements pointant une ligne bancaire qui n'existe plus. */
  danglingLinks: CcaMovementRow[];
  /** Montant des virements identifiés mais non rapprochés, par associé. */
  unlinkedTotal: Record<CcaAssocie, number>;
}

/**
 * Confronte les mouvements de compte courant au relevé.
 *
 * @param bankLines  lignes du relevé sur la période examinée. Les crédits sont
 *   ignorés : un encaissement n'est pas un remboursement d'associé.
 * @param knownPayees noms de fournisseurs connus, pour ne pas faire passer un
 *   virement fournisseur pour un virement à un associé.
 */
export function analyseCcaReconciliation(
  movements: readonly CcaMovementRow[],
  bankLines: readonly CcaBankLine[],
  terms: Record<CcaAssocie, string[]> = DEFAULT_TRANSFER_TERMS,
  knownPayees: readonly string[] = []
): CcaReconciliation {
  const linked = new Map<string, CcaMovementRow[]>();
  for (const m of movements) {
    if (!m.bank_transaction_id) continue;
    const list = linked.get(m.bank_transaction_id) ?? [];
    list.push(m);
    linked.set(m.bank_transaction_id, list);
  }
  const bankIds = new Set(bankLines.map(l => l.id));

  const unlinked: { line: CcaBankLine; associe: CcaAssocie }[] = [];
  const unidentified: CcaBankLine[] = [];

  for (const line of bankLines) {
    if ((line.amount || 0) >= 0) continue;          // un encaissement ne rembourse rien
    if (linked.has(line.id)) continue;              // déjà rattaché

    const associe = matchAssociate(line.description || '', terms);
    if (associe) { unlinked.push({ line, associe }); continue; }
    if (looksLikeTransfer(line.description || '')
        && !isObviouslyNotAssociate(line.description || '', knownPayees)) {
      unidentified.push(line);
    }
  }

  const byDateDesc = (a: { date: string }, b: { date: string }) => b.date.localeCompare(a.date);
  unlinked.sort((a, b) => byDateDesc(a.line, b.line));
  unidentified.sort(byDateDesc);

  const unlinkedTotal: Record<CcaAssocie, number> = { justine: 0, yohan: 0 };
  for (const { line, associe } of unlinked) {
    unlinkedTotal[associe] = Math.round((unlinkedTotal[associe] + Math.abs(line.amount || 0)) * 100) / 100;
  }

  return {
    unlinked,
    unidentified,
    unlinkedTotal,
    refundsWithoutBank: movements
      .filter(m => m.sens === 'remboursement' && !m.bank_transaction_id)
      .sort(byDateDesc),
    flaggedWithoutLink: movements
      .filter(m => m.rapproche_banque && !m.bank_transaction_id)
      .sort(byDateDesc),
    doubleLinked: [...linked.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([bankTransactionId, list]) => ({ bankTransactionId, movements: list })),
    // Un lien vers une ligne absente de la fenêtre examinée n'est pas un
    // orphelin : on ne signale que ce qu'on a réellement pu contrôler.
    danglingLinks: bankLines.length === 0 ? [] : movements.filter(
      m => m.bank_transaction_id && !bankIds.has(m.bank_transaction_id)
    ),
  };
}
