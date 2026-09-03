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
