/**
 * fetch-all.ts — Lire TOUTES les lignes, pas les mille premières.
 *
 * ── Le défaut que ce fichier corrige ──
 *
 * Supabase plafonne toute réponse de son API REST à **1 000 lignes** (réglage
 * « Max rows », valeur par défaut). Le plafond est silencieux : la requête
 * réussit, `error` est nul, et on reçoit un tableau parfaitement valide —
 * simplement incomplet.
 *
 * Sur une pizzeria qui enregistre 1 788 commandes dans l'année, une vue annuelle
 * en lisait donc 1 000 : le chiffre d'affaires affiché était amputé de 44 %.
 * Et comme le CA est le dénominateur de tous les ratios, le food cost, la marge
 * et le ratio de masse salariale étaient gonflés d'autant — pendant que la TVA
 * collectée était minorée. Le module « À faire » annonçait « des ventes
 * manquantes » en comparant les versements bancaires à un CA tronqué : le
 * constat était juste, la cause n'était pas celle qu'il désignait.
 *
 * Le symptôme reconnaissable est un compte **exactement rond** : 1 000
 * commandes, 1 000 écritures. Une donnée réelle ne tombe pas sur un compte
 * rond ; une limite, si.
 *
 * ── La règle ──
 *
 * Toute lecture dont le nombre de lignes dépend d'une période, d'un volume de
 * ventes ou d'un historique passe par `fetchAllRows`. Les seules requêtes qui
 * peuvent s'en dispenser sont celles bornées par construction : un `.limit(n)`
 * explicite, un `.eq()` sur une clé primaire, ou une table de réglages.
 */

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Taille d'une page. Doit rester ≤ au plafond du serveur pour le détecter. */
const PAGE_SIZE = 1000;

/**
 * Garde-fou : 200 pages = 200 000 lignes. Très au-delà de tout usage réel,
 * mais borne une boucle qui tournerait à cause d'un `.range()` mal appliqué.
 */
const MAX_PAGES = 200;

/**
 * Lit toutes les lignes d'une requête, en paginant.
 *
 * @param buildPage fonction qui construit la requête pour une tranche donnée.
 *   Elle DOIT appliquer `.range(from, to)` — c'est ce qui déplace la fenêtre.
 *
 * @example
 *   const orders = await fetchAllRows(from => to =>
 *     supabase.from('square_orders').select('*').range(from, to)
 *   );
 *
 * @throws si une page échoue. Une lecture partielle qui se tait est exactement
 *   le défaut qu'on corrige ici : mieux vaut une erreur visible.
 */
export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const all: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `Lecture interrompue à la ligne ${from} : ${error.message}. `
        + `Le résultat aurait été incomplet sans le signaler.`,
      );
    }

    const rows = data || [];
    all.push(...rows);

    // Une page incomplète est la dernière. Une page pleine peut l'être aussi —
    // on refait donc un tour, qui reviendra vide. Un aller-retour de plus vaut
    // mieux qu'un tableau tronqué.
    if (rows.length < PAGE_SIZE) return all;
  }

  throw new Error(
    `Lecture abandonnée après ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} lignes). `
    + `La requête ne se termine pas : vérifie que .range() est bien appliqué.`,
  );
}

/**
 * Nombre d'identifiants par requête `in(...)`.
 *
 * Un filtre `in` voyage dans l'URL. Avec 1 788 commandes, la liste d'UUID pèse
 * 66 Ko — au-delà de ce que les passerelles HTTP acceptent, et la requête
 * échoue en bloc. 300 identifiants font une URL d'environ 11 Ko, confortable.
 */
const IN_CHUNK = 300;

/**
 * Lit toutes les lignes dont une colonne appartient à une longue liste de
 * valeurs, en découpant la liste ET en paginant chaque tranche.
 *
 * @param values liste complète (identifiants de commandes, de factures…)
 * @param buildPage requête pour une tranche de valeurs et une fenêtre de lignes
 *
 * @example
 *   const items = await fetchAllRowsIn(orderIds, (ids, from, to) =>
 *     supabase.from('square_items').select('*').in('order_id', ids).range(from, to)
 *   );
 */
export async function fetchAllRowsIn<T, V>(
  values: V[],
  buildPage: (chunk: V[], from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  if (values.length === 0) return [];

  const all: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    const rows = await fetchAllRows<T>((from, to) => buildPage(chunk, from, to));
    all.push(...rows);
  }
  return all;
}
