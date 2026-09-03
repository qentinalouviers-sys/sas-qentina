import type { ExtractedInvoiceData } from '@/lib/ai/invoice-ocr';

/**
 * invoice-checks.ts — Ce qu'une facture doit vérifier avant d'entrer en base.
 *
 * L'OCR renvoie ce qu'il croit lire, et il se trompe de façon prévisible :
 * une date inventée quand elle est illisible, un total HT recopié dans le
 * TTC, des lignes qui ne somment pas au total. Rien n'arrêtait ces erreurs —
 * la facture entrait telle quelle, et le food cost, la TVA et le lettrage
 * bancaire héritaient du défaut sans qu'aucun écran ne le signale.
 *
 * Deux niveaux :
 *  - `bloquant` : la facture ne peut pas être enregistrée en l'état. Ce sont
 *    des impossibilités (pas de date, HT supérieur au TTC), pas des doutes.
 *  - `a_confirmer` : c'est possible mais inhabituel. L'enregistrement exige
 *    qu'un humain coche explicitement « j'ai vérifié » — c'est le contrôle
 *    humain que l'outil doit exiger, pas suggérer.
 *
 * Fonction pure : elle reçoit la facture et la date du jour, ne touche ni à la
 * base ni à l'horloge. C'est ce qui permet de la tester dans les deux sens —
 * elle refuse ce qu'il faut, et elle se tait quand tout est normal.
 */

export type AnomalyLevel = 'bloquant' | 'a_confirmer';

export interface InvoiceAnomaly {
  code: string;
  level: AnomalyLevel;
  /** Ce qui ne va pas, en une phrase. */
  message: string;
  /** Ce que l'humain doit regarder sur le document pour trancher. */
  verification: string;
}

/** Tolérance sur les égalités d'euros : les arrondis de l'OCR. */
const CENTS = 0.05;

/** Une facture d'achat au-delà de ce montant mérite une seconde lecture. */
const UNUSUAL_TTC = 5000;

/** Au-delà de cet âge, une facture a plus de chances d'être mal datée que vraie. */
const OLD_MONTHS = 18;

function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

const eur = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;

/**
 * Passe une facture au crible. `today` est en ISO (AAAA-MM-JJ).
 * L'ordre de sortie est l'ordre de lecture : bloquants d'abord.
 */
export function checkInvoice(inv: ExtractedInvoiceData, today: string): InvoiceAnomaly[] {
  const out: InvoiceAnomaly[] = [];
  const ht = Number(inv.total_ht) || 0;
  const ttc = Number(inv.total_ttc) || 0;
  const tva = inv.tva == null ? null : Number(inv.tva);
  const isTicket = inv.type_document === 'ticket_caisse' || inv.type_document === 'recu';

  // ── Bloquants : des impossibilités ─────────────────────────────────────

  if (!inv.fournisseur || !String(inv.fournisseur).trim()) {
    out.push({
      code: 'fournisseur-manquant', level: 'bloquant',
      message: 'Aucun fournisseur lu sur le document.',
      verification: 'Le nom du vendeur figure en en-tête. Saisis-le avant d\'enregistrer.',
    });
  }

  const date = isIsoDate(inv.date) ? inv.date : null;
  if (!date) {
    out.push({
      code: 'date-manquante', level: 'bloquant',
      message: 'Aucune date exploitable sur le document.',
      verification: 'Sans date, la facture ne peut être rattachée ni à un mois de TVA ni à un exercice.',
    });
  } else if (date > addDays(today, 1)) {
    out.push({
      code: 'date-future', level: 'bloquant',
      message: `Facture datée du ${date.split('-').reverse().join('/')}, dans le futur.`,
      verification: 'L\'OCR a probablement lu une date d\'échéance ou inversé jour et mois.',
    });
  }

  if (ttc <= 0 && ht <= 0) {
    out.push({
      code: 'montant-nul', level: 'bloquant',
      message: 'Aucun montant lu (HT et TTC à zéro).',
      verification: 'Le total est en général en bas à droite, en gras.',
    });
  } else if (ht > ttc + CENTS) {
    out.push({
      code: 'ht-superieur-ttc', level: 'bloquant',
      message: `HT (${eur(ht)}) supérieur au TTC (${eur(ttc)}).`,
      verification: 'Impossible sur une facture : les deux colonnes ont sans doute été inversées.',
    });
  }

  // Un bloquant sur la date rend les contrôles de date suivants sans objet.
  const dateOk = date !== null && date <= addDays(today, 1);

  // ── À confirmer : possible mais inhabituel ─────────────────────────────

  if (dateOk && /-01-01$/.test(date)) {
    out.push({
      code: 'date-premier-janvier', level: 'a_confirmer',
      message: 'Facture datée d\'un 1er janvier.',
      verification: 'C\'est la date que l\'OCR invente quand il ne lit pas la vraie. Vérifie-la sur le document.',
    });
  }

  if (dateOk && date < addMonths(today, -OLD_MONTHS)) {
    out.push({
      code: 'date-ancienne', level: 'a_confirmer',
      message: `Facture de plus de ${OLD_MONTHS} mois.`,
      verification: 'Une facture ancienne relève peut-être d\'un exercice déjà clos : elle n\'y a plus sa place.',
    });
  }

  if (!isTicket && !inv.numero_facture) {
    out.push({
      code: 'numero-manquant', level: 'a_confirmer',
      message: 'Pas de numéro de facture.',
      verification: 'L\'article 242 nonies A du CGI l\'impose : sans numéro, la déduction de TVA est contestable. S\'il figure sur le document, saisis-le.',
    });
  }

  if (tva != null && tva > 0 && Math.abs(ht + tva - ttc) > CENTS) {
    out.push({
      code: 'tva-incoherente', level: 'a_confirmer',
      message: `HT + TVA (${eur(ht + tva)}) ne fait pas le TTC (${eur(ttc)}).`,
      verification: 'Un des trois montants est mal lu. Le TTC est celui qui a été payé : pars de lui.',
    });
  }

  if (!isTicket && ttc > 0 && Math.abs(ht - ttc) <= CENTS) {
    out.push({
      code: 'sans-tva', level: 'a_confirmer',
      message: 'Aucune TVA sur cette facture (HT = TTC).',
      verification: 'Légitime seulement si le document porte « TVA non applicable, art. 293 B du CGI ». Sinon la TVA a été oubliée par l\'OCR.',
    });
  }

  const lignes = inv.lignes ?? [];
  if (lignes.length > 0 && ht > 0) {
    const sum = lignes.reduce((s, l) => s + (Number(l.prix_total_ht) || 0), 0);
    const tolerance = Math.max(1, ht * 0.01);
    if (Math.abs(sum - ht) > tolerance) {
      out.push({
        code: 'lignes-incoherentes', level: 'a_confirmer',
        message: `Les ${lignes.length} lignes font ${eur(sum)}, le total HT ${eur(ht)}.`,
        verification: 'Il manque des lignes, ou une remise globale n\'a pas été lue. Le total HT fait foi pour la compta ; les lignes servent aux prix d\'achat.',
      });
    }
  }

  if (ttc > UNUSUAL_TTC) {
    out.push({
      code: 'montant-inhabituel', level: 'a_confirmer',
      message: `Montant inhabituel : ${eur(ttc)} TTC.`,
      verification: 'Vérifie qu\'il ne s\'agit pas d\'un relevé mensuel ou d\'un devis.',
    });
  }

  return out;
}

export class InvoiceValidationError extends Error {
  constructor(public readonly anomalies: InvoiceAnomaly[]) {
    const blocking = anomalies.filter(a => a.level === 'bloquant');
    super(
      blocking.length > 0
        ? `Facture refusée : ${blocking.map(a => a.message).join(' ')}`
        : `Facture non confirmée : ${anomalies.map(a => a.message).join(' ')} Coche « j'ai vérifié » pour chaque point.`
    );
    this.name = 'InvoiceValidationError';
  }
}

/**
 * Lève une erreur si la facture ne peut pas être enregistrée : un bloquant, ou
 * un point à confirmer que l'humain n'a pas explicitement acquitté.
 */
export function assertInvoiceAccepted(
  inv: ExtractedInvoiceData,
  today: string,
  confirmations: readonly string[] = [],
): InvoiceAnomaly[] {
  const anomalies = checkInvoice(inv, today);
  const refused = anomalies.filter(a => a.level === 'bloquant' || !confirmations.includes(a.code));
  if (refused.length > 0) throw new InvoiceValidationError(refused);
  return anomalies;
}
