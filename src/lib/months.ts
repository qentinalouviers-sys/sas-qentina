/**
 * months.ts — Arithmétique de mois « AAAA-MM », sans passer par les fuseaux.
 * Partagé par le serveur (clôtures, export) et les écrans.
 */

/** « 2026-09 » → bornes ISO du mois. */
export function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Mois invalide : « ${month} » (attendu AAAA-MM)`);
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) throw new Error(`Mois invalide : « ${month} »`);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** Libellé français d'un mois : « septembre 2026 ». */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Les N derniers mois (le mois en cours compris), du plus récent au plus ancien. */
export function recentMonths(today: string, n = 12): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}

/** Vrai si le mois est entièrement écoulé à la date donnée. */
export function isMonthOver(month: string, today: string): boolean {
  return monthBounds(month).end < today;
}
