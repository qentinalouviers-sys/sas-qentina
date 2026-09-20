import type { ExtractedInvoiceData } from '@/lib/invoice-normalize';
import { TVA_RATES } from '@/lib/invoice-normalize';

/**
 * invoice-checks.ts — Ce qu'une facture doit vérifier avant d'entrer en base.
 *
 * L'OCR renvoie ce qu'il croit lire, et il se trompe de façon prévisible :
 * une date inventée quand elle est illisible, un total HT recopié dans le
 * TTC, des lignes qui ne somment pas au total. Rien n'arrêtait ces erreurs —
 * la facture entrait telle quelle, et le food cost, la TVA et le lettrage
 * bancaire héritaient du défaut sans qu'aucun écran ne le signale.
 *
 * Trois niveaux :
 *  - `bloquant` : la facture ne peut pas être enregistrée en l'état. Ce sont
 *    des impossibilités (pas de date, HT supérieur au TTC), pas des doutes.
 *    Depuis que l'écran permet de corriger, un bloquant se lève en corrigeant.
 *  - `a_confirmer` : c'est possible mais inhabituel. L'enregistrement exige
 *    qu'un humain coche explicitement « j'ai vérifié » — c'est le contrôle
 *    humain que l'outil doit exiger, pas suggérer.
 *  - `info` : une conséquence à connaître (TVA non déduite sur un reçu), qui
 *    n'appelle ni correction ni coche.
 *
 * Fonction pure : elle reçoit la facture et la date du jour, ne touche ni à la
 * base ni à l'horloge. C'est ce qui permet de la tester dans les deux sens —
 * elle refuse ce qu'il faut, et elle se tait quand tout est normal. Elle
 * tourne à l'identique dans le navigateur (à chaque correction) et sur le
 * serveur (à l'enregistrement) : l'écran ne peut rien faire passer que le
 * serveur ne recompte.
 */

export type AnomalyLevel = 'bloquant' | 'a_confirmer' | 'info';

export interface InvoiceAnomaly {
  code: string;
  level: AnomalyLevel;
  /** Ce qui ne va pas, en une phrase. */
  message: string;
  /** Ce que l'humain doit regarder sur le document pour trancher. */
  verification: string;
  /** Champs du formulaire concernés, pour les mettre en évidence. */
  fields?: string[];
}

/** Tolérance sur les égalités d'euros : les arrondis de l'OCR. */
const CENTS = 0.05;

/** Une facture d'achat au-delà de ce montant mérite une seconde lecture. */
const UNUSUAL_TTC = 5000;

/** Au-delà de cet âge, une facture a plus de chances d'être mal datée que vraie. */
const OLD_MONTHS = 18;

/** Taux de TVA le plus élevé en France : un taux implicite au-delà est une lecture fausse. */
const MAX_RATE = 0.206;

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
const fr = (iso: string) => iso.split('-').reverse().join('/');
const pct = (r: number) => `${(r * 100).toFixed(1).replace('.', ',').replace(/,0$/, '')} %`;

/** Numéro de facture comparable : casse, espaces et tirets ignorés. */
export function normalizeInvoiceNumber(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[\s\-_./]/g, '');
}

const FIELD_LABELS: Record<string, string> = {
  fournisseur: 'fournisseur', date: 'date', numero_facture: 'numéro', total_ht: 'total HT',
  total_tva: 'TVA', total_ttc: 'total TTC', tva_ventilation: 'ventilation TVA', lignes: 'lignes',
};

/**
 * Passe une facture au crible. `today` est en ISO (AAAA-MM-JJ).
 * L'ordre de sortie est l'ordre de lecture : bloquants d'abord.
 */
export function checkInvoice(inv: ExtractedInvoiceData, today: string): InvoiceAnomaly[] {
  const out: InvoiceAnomaly[] = [];
  const ht = Number(inv.total_ht) || 0;
  const ttc = Number(inv.total_ttc) || 0;
  const tva = inv.tva == null ? null : Number(inv.tva);
  const typeDoc = inv.type_document || 'facture';
  const isTicket = typeDoc === 'ticket_caisse' || typeDoc === 'recu';

  // ── Bloquants : des impossibilités ─────────────────────────────────────

  if (!inv.fournisseur || !String(inv.fournisseur).trim()) {
    out.push({
      code: 'fournisseur-manquant', level: 'bloquant', fields: ['fournisseur'],
      message: 'Aucun fournisseur lu sur le document.',
      verification: 'Le nom du vendeur figure en en-tête. Saisis-le dans le champ Fournisseur.',
    });
  }

  const date = isIsoDate(inv.date) ? inv.date : null;
  if (!date) {
    out.push({
      code: 'date-manquante', level: 'bloquant', fields: ['date'],
      message: 'Aucune date exploitable sur le document.',
      verification: 'Sans date, la facture ne peut être rattachée ni à un mois de TVA ni à un exercice. Saisis-la.',
    });
  } else if (date > addDays(today, 1)) {
    out.push({
      code: 'date-future', level: 'bloquant', fields: ['date'],
      message: `Facture datée du ${fr(date)}, dans le futur.`,
      verification: 'L\'OCR a probablement lu une date d\'échéance ou inversé jour et mois. Corrige la date.',
    });
  }

  if (ttc <= 0 && ht <= 0) {
    out.push({
      code: 'montant-nul', level: 'bloquant', fields: ['total_ht', 'total_ttc'],
      message: 'Aucun montant lu (HT et TTC à zéro).',
      verification: 'Le total est en général en bas à droite, en gras. Saisis HT et TTC.',
    });
  } else if (ht > ttc + CENTS) {
    out.push({
      code: 'ht-superieur-ttc', level: 'bloquant', fields: ['total_ht', 'total_ttc'],
      message: `HT (${eur(ht)}) supérieur au TTC (${eur(ttc)}).`,
      verification: 'Impossible sur une facture : les deux colonnes ont sans doute été inversées.',
    });
  }

  // Un bloquant sur la date rend les contrôles de date suivants sans objet.
  const dateOk = date !== null && date <= addDays(today, 1);

  // ── À confirmer : possible mais inhabituel ─────────────────────────────

  // La seconde lecture ne s'accorde pas avec la première : l'un des deux
  // moteurs a mal lu, et rien ne dit lequel. C'est LE signal qui justifie le
  // second appel — il ne coûte que quand il a quelque chose à dire.
  const ctrl = inv.controle_lecture;
  if (ctrl) {
    const diffs: string[] = [];
    const fields: string[] = [];
    const cmpNum = (label: string, field: string, a: number | null, b: number | null) => {
      if (a === null || b === null) return;
      if (Math.abs(a - b) > CENTS) { diffs.push(`${label} ${eur(a)} / ${eur(b)}`); fields.push(field); }
    };
    cmpNum('TTC', 'total_ttc', ttc, ctrl.total_ttc);
    cmpNum('HT', 'total_ht', ht, ctrl.total_ht);
    cmpNum('TVA', 'total_tva', tva, ctrl.total_tva);
    if (date && ctrl.date && isIsoDate(ctrl.date) && ctrl.date !== date) { diffs.push(`date ${fr(date)} / ${fr(ctrl.date)}`); fields.push('date'); }
    if (inv.numero_facture && ctrl.numero_facture
        && normalizeInvoiceNumber(inv.numero_facture) !== normalizeInvoiceNumber(ctrl.numero_facture)) {
      diffs.push(`numéro ${inv.numero_facture} / ${ctrl.numero_facture}`); fields.push('numero_facture');
    }
    if (diffs.length > 0) {
      out.push({
        code: 'lecture-divergente', level: 'a_confirmer', fields,
        message: `Les deux lectures ne s'accordent pas : ${diffs.join(' ; ')}.`,
        verification: `Première valeur : lecture principale ; seconde : contrôle par ${ctrl.moteur}. Regarde le document et corrige le champ qui est faux.`,
      });
    }
  }

  if ((inv.champs_incertains?.length ?? 0) > 0) {
    const fields = inv.champs_incertains!;
    out.push({
      code: 'champs-incertains', level: 'a_confirmer', fields,
      message: `L'OCR n'est pas sûr de : ${fields.map(f => FIELD_LABELS[f] ?? f).join(', ')}.`,
      verification: 'Ces champs sont surlignés dans le formulaire. Compare-les au document avant de cocher.',
    });
  }

  if ((inv.champs_non_lus ?? []).some(f => f === 'total_ht' || f === 'total_ttc')) {
    out.push({
      code: 'total-non-lu', level: 'a_confirmer', fields: inv.champs_non_lus!.filter(f => f === 'total_ht' || f === 'total_ttc'),
      message: 'Un total n\'a pas été lu du tout (mis à 0 par défaut).',
      verification: 'Un montant absent n\'est pas un montant nul. Saisis-le depuis le document.',
    });
  }

  if (dateOk && /-01-01$/.test(date)) {
    out.push({
      code: 'date-premier-janvier', level: 'a_confirmer', fields: ['date'],
      message: 'Facture datée d\'un 1er janvier.',
      verification: 'C\'est la date que l\'OCR invente quand il ne lit pas la vraie. Vérifie-la sur le document.',
    });
  }

  if (dateOk && date < addMonths(today, -OLD_MONTHS)) {
    out.push({
      code: 'date-ancienne', level: 'a_confirmer', fields: ['date'],
      message: `Facture de plus de ${OLD_MONTHS} mois.`,
      verification: 'Une facture ancienne relève peut-être d\'un exercice déjà clos : elle n\'y a plus sa place.',
    });
  }

  if (!isTicket && !inv.numero_facture) {
    out.push({
      code: 'numero-manquant', level: 'a_confirmer', fields: ['numero_facture'],
      message: 'Pas de numéro de facture.',
      verification: 'L\'article 242 nonies A du CGI l\'impose : sans numéro, la déduction de TVA est contestable. S\'il figure sur le document, saisis-le.',
    });
  }

  if (tva != null && tva > 0 && Math.abs(ht + tva - ttc) > CENTS) {
    out.push({
      code: 'tva-incoherente', level: 'a_confirmer', fields: ['total_ht', 'total_tva', 'total_ttc'],
      message: `HT + TVA (${eur(ht + tva)}) ne fait pas le TTC (${eur(ttc)}).`,
      verification: 'Un des trois montants est mal lu — sauf si le document porte une consigne ou des frais hors TVA. Le TTC est celui qui a été payé : pars de lui.',
    });
  }

  // Un taux implicite au-dessus de 20 % n'existe pas : le HT lu est un
  // sous-total (avant remise, avant une page), ou le TTC porte des frais.
  if (ht > 0 && ttc > ht + CENTS) {
    const implied = (ttc - ht) / ht;
    if (implied > MAX_RATE) {
      out.push({
        code: 'taux-implicite-anormal', level: 'a_confirmer', fields: ['total_ht', 'total_ttc'],
        message: `TVA implicite de ${pct(implied)} entre HT et TTC : aucun taux français ne dépasse 20 %.`,
        verification: 'Le HT lu est sans doute un sous-total. Cherche le « Total HT » définitif, juste au-dessus du TTC.',
      });
    }
  }

  // Ventilation par taux : elle doit tomber juste avec elle-même ET avec les
  // totaux. C'est elle qui fait la déclaration, ligne par ligne.
  const vent = inv.tva_ventilation ?? [];
  if (vent.length > 0) {
    const problems: string[] = [];
    let sumBase = 0, sumTva = 0;
    for (const v of vent) {
      sumBase += v.base_ht; sumTva += v.montant_tva;
      if (!(TVA_RATES as readonly number[]).includes(v.taux)) {
        problems.push(`taux ${String(v.taux).replace('.', ',')} % inconnu`);
        continue;
      }
      const expected = v.base_ht * v.taux / 100;
      if (Math.abs(expected - v.montant_tva) > CENTS + v.base_ht * 0.001) {
        problems.push(`${eur(v.base_ht)} à ${String(v.taux).replace('.', ',')} % devrait donner ${eur(expected)}, lu ${eur(v.montant_tva)}`);
      }
    }
    if (ht > 0 && Math.abs(sumBase - ht) > CENTS) problems.push(`bases ${eur(sumBase)} ≠ HT ${eur(ht)}`);
    if (tva != null && Math.abs(sumTva - tva) > CENTS) problems.push(`TVA ventilée ${eur(sumTva)} ≠ TVA totale ${eur(tva)}`);
    if (problems.length > 0) {
      out.push({
        code: 'ventilation-tva-incoherente', level: 'a_confirmer', fields: ['tva_ventilation'],
        message: `La ventilation par taux ne tombe pas juste : ${problems.join(' ; ')}.`,
        verification: 'Le tableau de TVA est en pied de facture. Corrige la ligne fausse, ou supprime la ventilation si le document n\'en porte pas.',
      });
    }
  }

  if (!isTicket && ttc > 0 && Math.abs(ht - ttc) <= CENTS) {
    out.push({
      code: 'sans-tva', level: 'a_confirmer', fields: ['total_ht', 'total_ttc'],
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
        code: 'lignes-incoherentes', level: 'a_confirmer', fields: ['lignes'],
        message: `Les ${lignes.length} lignes font ${eur(sum)}, le total HT ${eur(ht)}.`,
        verification: 'Il manque des lignes, ou une remise globale n\'a pas été lue. Le total HT fait foi pour la compta ; les lignes servent aux prix d\'achat.',
      });
    }
  }

  if (ttc > UNUSUAL_TTC) {
    out.push({
      code: 'montant-inhabituel', level: 'a_confirmer', fields: ['total_ttc'],
      message: `Montant inhabituel : ${eur(ttc)} TTC.`,
      verification: 'Vérifie qu\'il ne s\'agit pas d\'un relevé mensuel ou d\'un devis.',
    });
  }

  if (inv.doublon) {
    const d = inv.doublon;
    out.push({
      code: 'doublon-probable', level: 'a_confirmer',
      message: d.raison === 'numero'
        ? `Le numéro ${d.invoice_number} existe déjà (${d.supplier ?? 'fournisseur inconnu'}, ${fr(d.date)}, ${eur(d.total_ttc ?? 0)} TTC, réf. ${d.accounting_ref ?? d.id.slice(0, 8)}).`
        : `Une facture du même jour et du même montant existe déjà (${d.supplier ?? 'fournisseur inconnu'}, ${fr(d.date)}, ${eur(d.total_ttc ?? 0)} TTC, réf. ${d.accounting_ref ?? d.id.slice(0, 8)}).`,
      verification: 'Si c\'est le même document, retire-le de la file : l\'enregistrer deux fois double la charge et la TVA déduite. Ne coche que si c\'est bien une autre facture.',
    });
  }

  // ── Informations : des conséquences à connaître ───────────────────────

  if (typeDoc === 'recu' || typeDoc === 'bon_livraison') {
    out.push({
      code: 'tva-non-recuperable', level: 'info',
      message: typeDoc === 'recu'
        ? 'Reçu de carte bancaire : la TVA ne sera pas déduite.'
        : 'Bon de livraison : la TVA ne sera pas déduite.',
      verification: 'Seule une facture ouvre droit à déduction (art. 271 CGI). Si tu as la facture correspondante, scanne-la à la place.',
    });
  } else if (typeDoc === 'facture' && !inv.nom_entreprise_present) {
    out.push({
      code: 'tva-non-recuperable', level: 'info',
      message: 'Le nom de la société n\'a pas été trouvé sur la facture : la TVA ne sera pas déduite.',
      verification: 'Si « TEKOTEK » ou « QENTINA » figure bien en adresse client, coche « Nom de la société présent ».',
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
 * un point à confirmer que l'humain n'a pas explicitement acquitté. Les
 * informations n'entrent pas en ligne de compte.
 */
export function assertInvoiceAccepted(
  inv: ExtractedInvoiceData,
  today: string,
  confirmations: readonly string[] = [],
): InvoiceAnomaly[] {
  const anomalies = checkInvoice(inv, today);
  const refused = anomalies.filter(a => a.level === 'bloquant' || (a.level === 'a_confirmer' && !confirmations.includes(a.code)));
  if (refused.length > 0) throw new InvoiceValidationError(refused);
  return anomalies;
}
