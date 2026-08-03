/**
 * reconciliation.ts — Apparier un mouvement bancaire à une facture.
 *
 * Extrait de la page Banque pour être vérifiable : une suggestion absurde ne
 * casse rien techniquement, elle érode juste la confiance jusqu'à ce que
 * l'utilisateur cesse de lire les suggestions. C'est le genre de défaut qui ne
 * se voit que sur des données réelles, donc le genre qu'il faut figer dans un
 * test.
 */

export interface MatchableTransaction {
  date: string;
  description?: string | null;
  amount?: number | null;
}

export interface MatchableInvoice {
  date: string;
  total_ttc?: number | null;
  supplier?: { name?: string | null } | null;
}

export interface Suggestion<T> {
  invoice: T;
  score: number;
}

/**
 * Factures candidates pour lettrer un mouvement, les mieux notées d'abord.
 *
 * Deux garde-fous, chacun né d'une suggestion réellement observée :
 *
 * 1. **Un encaissement ne paie jamais une facture d'achat.** L'ancien code
 *    comparait `Math.abs(amount)` au TTC de la facture : un virement Square
 *    *reçu* se retrouvait proposé face à une facture EDF, parce que les deux
 *    faisaient le même montant en valeur absolue. Le signe est un fait.
 *
 * 2. **La proximité de date ne prouve rien à elle seule.** Elle valait 30
 *    points, soit exactement le seuil d'acceptation : deux écritures de la même
 *    semaine étaient appariées sans le moindre autre point commun. Il faut
 *    désormais au moins un lien de **montant** ou de **nom** ; la date ne fait
 *    que corroborer.
 */
export function suggestInvoicesForTransaction<T extends MatchableInvoice>(
  tx: MatchableTransaction | null | undefined,
  unlinkedInvoices: T[],
  limit = 3,
): Suggestion<T>[] {
  if (!tx) return [];
  const amount = tx.amount || 0;
  if (amount >= 0) return [];                     // garde-fou 1
  const paid = Math.abs(amount);
  const txDesc = (tx.description || '').toLowerCase();

  return unlinkedInvoices
    .map(inv => {
      // Indice 1 : le montant. Une égalité au centime vaut presque preuve.
      const ttc = inv.total_ttc || 0;
      const diff = Math.abs(paid - ttc);
      const amountScore = diff < 0.01 ? 100 : diff < 1 ? 50 : 0;

      // Indice 2 : le nom du fournisseur dans le libellé bancaire.
      const supplierName = (inv.supplier?.name || '').toLowerCase();
      let nameScore = 0;
      if (supplierName && txDesc) {
        if (txDesc.includes(supplierName) || supplierName.includes(txDesc)) {
          nameScore = 40;
        } else {
          const words = supplierName.split(/\s+/).filter(w => w.length > 2);
          const hits = words.filter(w => txDesc.includes(w)).length;
          if (hits > 0) nameScore = 20 * hits;
        }
      }

      // Indice 3 : la date. Corrobore, ne suffit pas.
      const days = Math.ceil(
        Math.abs(Date.parse(tx.date) - Date.parse(inv.date)) / 86_400_000,
      );
      const dateScore = days <= 3 ? 30 : days <= 7 ? 20 : days <= 15 ? 10 : days <= 30 ? 5 : 0;

      return {
        invoice: inv,
        score: amountScore + nameScore + dateScore,
        hasLink: amountScore > 0 || nameScore > 0,   // garde-fou 2
      };
    })
    .filter(s => s.hasLink && s.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ invoice, score }) => ({ invoice, score }));
}

/**
 * Somme des valeurs absolues des **débits** d'un ensemble de mouvements.
 *
 * Les compteurs de la page Banque sommaient les montants signés puis
 * affichaient la valeur absolue du résultat. Les encaissements annulaient donc
 * les décaissements : 21 000 € de dépenses en attente de facture s'affichaient
 * « 250,91 € ». Une somme de dépenses ne peut pas se compenser — d'où deux
 * précautions plutôt qu'une : on filtre les crédits, ET on additionne des
 * valeurs absolues.
 */
export function sumDebits(rows: { amount?: number | null }[]): number {
  const cents = rows.reduce(
    (s, t) => (t.amount || 0) < 0 ? s + Math.round(Math.abs(t.amount as number) * 100) : s,
    0,
  );
  return cents / 100;
}
