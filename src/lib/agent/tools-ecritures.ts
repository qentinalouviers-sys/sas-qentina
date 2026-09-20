/**
 * tools-ecritures.ts — Lire une facture, l'enregistrer, lettrer, classer,
 * compter le stock : les gestes de pré-comptabilité confiés aux agents.
 *
 * Chaque écriture emprunte EXACTEMENT le chemin de l'écran (lib/scanner.ts,
 * mêmes contrôles, mêmes verrous en base) et se simule avec `dry_run`. Un
 * agent ne bénéficie d'aucun raccourci : ce qu'un humain doit acquitter, il
 * doit l'acquitter aussi, code d'anomalie par code d'anomalie.
 */

import { analyzeInvoiceFiles, registerInvoice, findBankCandidates, matchConfidenceOf } from '@/lib/scanner';
import { findDuplicateInvoice } from '@/lib/invoices';
import { checkInvoice, InvoiceValidationError } from '@/lib/invoice-checks';
import { normalizeExtracted, computeTvaRecoverable } from '@/lib/invoice-normalize';
import { matchIngredient, normalizeName } from '@/lib/referentiel';
import { round2 } from '@/lib/accounting';
import { checkInvoiceLink } from './reports';
import { eur, relationName, toolErrorFromDb, DRY_RUN_PROP, ToolError, type AgentTool } from './base';

const BANK_CATEGORIES = [
  'fixe_loyer', 'fixe_assurance', 'fixe_abonnement', 'variable_fournisseur', 'variable_salaire',
  'impot_taxe', 'recette', 'investissement', 'flux_financier', 'autre',
] as const;
const BANK_STATUSES = ['pending_invoice', 'facture_ok', 'reconciled', 'ignored'] as const;
const ACCOUNTING_CLASSES = ['601', '607', '606', '6061', '61', '62', '63', '64', '455', 'autre'] as const;

// ── Factures ───────────────────────────────────────────────────────────────

const analyzeInvoiceDocument: AgentTool = {
  name: 'analyze_invoice_document',
  description:
    "Lit une facture fournisseur, un ticket ou un reçu (PDF ou image en base64) avec l'OCR de "
    + "l'application : double lecture (moteur principal + contrôle), totaux et ventilation de TVA, "
    + "lignes, champs incertains, anomalies à vérifier, doublon probable, mouvements bancaires "
    + "candidats. N'enregistre rien — la pièce est déposée dans le stockage (file_url) pour "
    + "register_invoice. COÛTEUX (deux appels IA) : un appel par document, jamais en boucle.",
  scope: 'read',
  expensive: true,
  schema: {
    type: 'object',
    properties: {
      file_base64: { type: 'string', description: 'Contenu du fichier encodé en base64, sans préfixe data:.' },
      mime_type: { type: 'string', enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'], description: 'Type MIME du fichier.' },
      filename: { type: 'string', description: 'Nom du fichier d\'origine, pour la pièce jointe (facultatif).' },
    },
    required: ['file_base64', 'mime_type'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const b64 = String(args.file_base64);
    if (b64.length < 100) throw new ToolError('Le fichier est vide ou tronqué : envoie le contenu complet en base64.', 'invalid_arguments');
    if (b64.length > 18 * 1024 * 1024) throw new ToolError('Fichier trop volumineux (plus de 13 Mo) : réduis la résolution ou découpe le document.', 'invalid_arguments');

    let analysis;
    try {
      analysis = await analyzeInvoiceFiles(ctx.supabase, [{ fileBase64: b64, mimeType: String(args.mime_type) }], (args.filename as string) || null, ctx.today);
    } catch (e) {
      throw new ToolError(`Lecture impossible : ${e instanceof Error ? e.message : String(e)}`, 'tool_failed');
    }

    const ex = analysis.extracted;
    const toConfirm = analysis.anomalies.filter(a => a.level === 'a_confirmer');
    const blocking = analysis.anomalies.filter(a => a.level === 'bloquant');
    return {
      summary:
        `${ex.type_document === 'facture' ? 'Facture' : ex.type_document} ${ex.numero_facture ?? 'sans numéro'} — ${ex.fournisseur ?? 'fournisseur illisible'}, `
        + `${ex.date ?? 'date illisible'} : ${eur(ex.total_ht)} HT + ${eur(ex.tva ?? 0)} TVA = ${eur(ex.total_ttc)} TTC, ${ex.lignes?.length ?? 0} ligne(s). `
        + (blocking.length > 0 ? `${blocking.length} point(s) BLOQUANT(S) à corriger dans extracted avant d'enregistrer. ` : '')
        + (toConfirm.length > 0 ? `${toConfirm.length} point(s) à vérifier puis à acquitter dans confirmations : ${toConfirm.map(a => a.code).join(', ')}. ` : 'Aucune anomalie. ')
        + (analysis.is_duplicate ? 'DOUBLON PROBABLE : vérifie avant d\'enregistrer. ' : '')
        + (analysis.match_confidence === 'high' ? `Mouvement bancaire trouvé (${analysis.bank_candidates[0].id}).` : `Rapprochement bancaire : ${analysis.match_confidence === 'none' ? 'aucun candidat' : `${analysis.bank_candidates.length} candidat(s), à vérifier`}.`),
      data: {
        extracted: ex,
        anomalies: analysis.anomalies,
        ocr_engine: analysis.ocr_engine,
        file_url: analysis.file_url,
        is_duplicate: analysis.is_duplicate,
        bank_candidates: analysis.bank_candidates,
        match_confidence: analysis.match_confidence,
      },
      next: ['register_invoice'],
    };
  },
};

const registerInvoiceTool: AgentTool = {
  name: 'register_invoice',
  description:
    "Enregistre une facture fournisseur (facture + lignes, mercuriale, compte courant si payée par un "
    + "associé, lettrage bancaire). Prend l'objet `extracted` rendu par analyze_invoice_document, "
    + "corrigé si besoin. Le serveur re-normalise, recherche un doublon, recompte les anomalies et "
    + "REFUSE tout point à confirmer non acquitté dans `confirmations` (par son code) et tout point "
    + "bloquant. Toujours d'abord avec dry_run: true, qui rend les anomalies restantes sans rien écrire.",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      extracted: { type: 'object', description: "La facture telle que rendue par analyze_invoice_document (champs fournisseur, date, numero_facture, total_ht, tva, total_ttc, tva_ventilation, lignes, type_document, compte_comptable, nom_entreprise_present), corrigée si nécessaire." },
      confirmations: { type: 'array', items: { type: 'string' }, description: 'Codes des anomalies « à confirmer » que tu as vérifiées (ex. ["numero-manquant", "lecture-divergente"]). Vide si aucune.' },
      file_url: { type: 'string', description: 'file_url rendu par analyze_invoice_document : la pièce justificative.' },
      payment_method: { type: 'string', enum: ['bank', 'cash', 'card_perso'], description: 'bank = compte société (défaut), cash = espèces, card_perso = carte personnelle d\'un associé.', default: 'bank' },
      associe: { type: 'string', enum: ['justine', 'yohan'], description: 'Associé qui a payé de sa poche (obligatoire avec card_perso ; avec cash si un associé a avancé). Crée un apport en compte courant.' },
      bank_transaction_id: { type: 'string', format: 'uuid', description: 'Mouvement bancaire à lettrer (un candidat de analyze_invoice_document dont le montant correspond).' },
      payment_notes: { type: 'string', description: 'Note libre sur le règlement (facultatif).' },
      dry_run: DRY_RUN_PROP,
    },
    required: ['extracted'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const paymentMethod = String(args.payment_method ?? 'bank');
    if (paymentMethod === 'card_perso' && !args.associe) {
      throw new ToolError('Avec payment_method card_perso, indique associe (justine ou yohan) : c\'est son compte courant qui est crédité.', 'invalid_arguments');
    }

    if (args.dry_run) {
      const extracted = normalizeExtracted(args.extracted);
      extracted.tva_recoverable = computeTvaRecoverable(extracted);
      extracted.doublon = await findDuplicateInvoice(ctx.supabase, extracted);
      const anomalies = checkInvoice(extracted, ctx.today);
      const confirmations = (args.confirmations as string[] | undefined) ?? [];
      const refused = anomalies.filter(a => a.level === 'bloquant' || (a.level === 'a_confirmer' && !confirmations.includes(a.code)));
      const candidates = args.bank_transaction_id ? [] : await findBankCandidates(ctx.supabase, extracted);
      return {
        summary: refused.length === 0
          ? `Simulation : la facture ${extracted.numero_facture ?? 'sans numéro'} de ${extracted.fournisseur} (${eur(extracted.total_ttc)} TTC, TVA ${extracted.tva_recoverable ? `déductible ${eur(extracted.tva ?? 0)}` : 'non déductible'}) serait enregistrée. Rejoue sans dry_run.`
          : `Simulation : enregistrement REFUSÉ en l'état — ${refused.map(a => `${a.code} (${a.level})`).join(', ')}. `
            + 'Corrige les bloquants dans extracted, vérifie les points à confirmer sur le document et acquitte-les par leur code.',
        data: {
          dry_run: true, would_register: refused.length === 0, extracted, anomalies, refused: refused.map(a => a.code),
          bank_candidates: candidates, match_confidence: matchConfidenceOf(candidates),
        },
      };
    }

    try {
      const saved = await registerInvoice(ctx.supabase, {
        extracted: args.extracted,
        fileUrl: (args.file_url as string) ?? null,
        bankTxId: (args.bank_transaction_id as string) ?? null,
        paymentMethod,
        paymentNotes: (args.payment_notes as string) ?? null,
        associe: (args.associe as string) ?? null,
        confirmations: (args.confirmations as string[] | undefined) ?? [],
        today: ctx.today,
      });
      return {
        summary: `Facture enregistrée sous la référence ${saved.accountingRef}`
          + (saved.reconciled ? ', lettrée avec le mouvement bancaire' : '')
          + (args.associe && paymentMethod !== 'bank' ? `, apport porté au compte courant de ${args.associe}` : '')
          + `. Mercuriale : ${saved.mercuriale.updated} prix mis à jour`
          + (saved.mercuriale.unmatched.length > 0 ? `, ${saved.mercuriale.unmatched.length} désignation(s) à rattacher dans Réglages` : '') + '.',
        data: { invoice_id: saved.invoiceId, accounting_ref: saved.accountingRef, reconciled: saved.reconciled, mercuriale: saved.mercuriale },
        next: ['get_invoice', 'get_vat_report'],
      };
    } catch (e) {
      if (e instanceof InvoiceValidationError) {
        throw new ToolError(`${e.message} Codes : ${e.anomalies.map(a => `${a.code} (${a.level})`).join(', ')}.`, 'invoice_refused');
      }
      if (e && typeof e === 'object' && 'message' in e) throw toolErrorFromDb(e as { code?: string; message: string }, 'Enregistrement refusé');
      throw e;
    }
  },
};

const linkInvoiceToBank: AgentTool = {
  name: 'link_invoice_to_bank_transaction',
  description:
    "Lettre une facture déjà enregistrée avec son paiement bancaire (dépense en attente de facture). "
    + "Vérifie que le mouvement est un débit non lettré, que la facture n'a pas déjà un paiement, et "
    + "que le montant correspond au centime — sinon refuse, sauf force: true pour un règlement partiel "
    + "ou groupé assumé. Identifiants : list_invoices (bank_link: unlinked) et list_bank_transactions "
    + "(status: pending_invoice).",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', format: 'uuid', description: 'Identifiant de la facture (list_invoices).' },
      bank_transaction_id: { type: 'string', format: 'uuid', description: 'Identifiant du mouvement bancaire (list_bank_transactions).' },
      force: { type: 'boolean', description: 'true = accepter un écart de montant (paiement partiel ou groupé). Défaut : false.', default: false },
      dry_run: DRY_RUN_PROP,
    },
    required: ['invoice_id', 'bank_transaction_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const invoiceId = args.invoice_id as string;
    const txId = args.bank_transaction_id as string;
    const [{ data: inv }, { data: tx }, { data: linked }] = await Promise.all([
      ctx.supabase.from('invoices').select('id, date, invoice_number, total_ttc, accounting_class, supplier:suppliers(name)').eq('id', invoiceId).maybeSingle(),
      ctx.supabase.from('bank_transactions').select('id, date, description, amount, invoice_id, status').eq('id', txId).maybeSingle(),
      ctx.supabase.from('bank_transactions').select('id').eq('invoice_id', invoiceId).limit(1).maybeSingle(),
    ]);
    if (!inv) throw new ToolError(`Aucune facture avec l'identifiant ${invoiceId}. Utilise list_invoices.`, 'not_found');
    if (!tx) throw new ToolError(`Aucun mouvement bancaire avec l'identifiant ${txId}. Utilise list_bank_transactions.`, 'not_found');

    const check = checkInvoiceLink(tx, inv, linked, args.force === true);
    if (!check.ok) throw new ToolError(check.message, check.code === 'amount_mismatch' ? 'amount_mismatch' : check.code === 'not_debit' ? 'invalid_request' : 'already_linked');

    const supplier = relationName(inv.supplier) ?? 'fournisseur inconnu';
    const desc = `facture ${inv.invoice_number ?? 'sans numéro'} de ${supplier} (${eur(Number(inv.total_ttc) || 0)}) ↔ « ${tx.description ?? ''} » du ${tx.date} (${eur(Math.abs(tx.amount ?? 0))})`;

    if (args.dry_run) {
      return {
        summary: `Simulation : lettrage possible — ${desc}.` + (check.warnings.length > 0 ? ` Avertissement : ${check.warnings.join(' ')}` : ''),
        data: { dry_run: true, ...check, invoice_id: invoiceId, bank_transaction_id: txId },
      };
    }

    const { error } = await ctx.supabase.from('bank_transactions')
      .update({ status: 'reconciled', invoice_id: invoiceId, accounting_class: inv.accounting_class || '601' })
      .eq('id', txId).is('invoice_id', null);
    if (error) throw toolErrorFromDb(error, 'Lettrage refusé');
    await ctx.supabase.from('invoices').update({ payment_method: 'bank' }).eq('id', invoiceId);

    return {
      summary: `Lettrage enregistré — ${desc}.` + (check.warnings.length > 0 ? ` ${check.warnings.join(' ')}` : ''),
      data: { invoice_id: invoiceId, bank_transaction_id: txId, amount_diff: check.amount_diff, days_apart: check.days_apart },
      next: ['get_vat_report'],
    };
  },
};

// ── Banque ─────────────────────────────────────────────────────────────────

const updateBankTransaction: AgentTool = {
  name: 'update_bank_transaction',
  description:
    "Corrige un mouvement bancaire à la source : sa catégorie (le P&L, la TVA et le tableau de bord "
    + "suivent), son statut (ignored pour un mouvement hors gestion, pending_invoice pour le remettre "
    + "en attente de facture) ou sa classe comptable. Un mouvement lettré avec une facture ne se "
    + "recatégorise pas (délie-le d'abord depuis l'écran Banque). Un mois clôturé refuse.",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      bank_transaction_id: { type: 'string', format: 'uuid', description: 'Identifiant du mouvement (list_bank_transactions).' },
      category: { type: 'string', enum: BANK_CATEGORIES, description: 'Nouvelle catégorie. flux_financier = prêt, apport, compte courant, virement interne (hors résultat).' },
      status: { type: 'string', enum: BANK_STATUSES, description: 'Nouveau statut. reconciled n\'est pas admis ici : passe par link_invoice_to_bank_transaction.' },
      accounting_class: { type: 'string', enum: ACCOUNTING_CLASSES, description: 'Classe comptable (601 matières, 607 boissons, 606 fournitures, 6061 énergie, 61 loyer, 62 services, 63 impôts, 64 personnel, 455 compte courant).' },
      dry_run: DRY_RUN_PROP,
    },
    required: ['bank_transaction_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const txId = args.bank_transaction_id as string;
    const patch: Record<string, string> = {};
    if (args.category) patch.category = String(args.category);
    if (args.status) patch.status = String(args.status);
    if (args.accounting_class) patch.accounting_class = String(args.accounting_class);
    if (Object.keys(patch).length === 0) throw new ToolError('Rien à modifier : indique category, status ou accounting_class.', 'invalid_arguments');
    if (patch.status === 'reconciled') throw new ToolError('Le statut reconciled se pose en lettrant une facture : utilise link_invoice_to_bank_transaction.', 'invalid_arguments');

    const { data: tx } = await ctx.supabase.from('bank_transactions')
      .select('id, date, description, amount, category, status, accounting_class, invoice_id').eq('id', txId).maybeSingle();
    if (!tx) throw new ToolError(`Aucun mouvement bancaire avec l'identifiant ${txId}.`, 'not_found');
    if (tx.invoice_id && (patch.category || patch.status)) {
      throw new ToolError('Ce mouvement est lettré avec une facture : sa catégorie et son statut viennent d\'elle. Délie-le d\'abord depuis l\'écran Banque.', 'already_linked');
    }

    const changes = Object.entries(patch).filter(([k, v]) => (tx as Record<string, unknown>)[k] !== v);
    if (changes.length === 0) {
      return { summary: 'Rien à changer : le mouvement porte déjà ces valeurs.', data: { transaction: tx, changed: [] } };
    }
    const desc = `« ${tx.description ?? ''} » du ${tx.date} (${eur(tx.amount ?? 0)}) : ${changes.map(([k, v]) => `${k} ${(tx as Record<string, unknown>)[k] ?? '—'} → ${v}`).join(', ')}`;

    if (args.dry_run) return { summary: `Simulation : ${desc}.`, data: { dry_run: true, transaction: tx, patch } };

    const { error } = await ctx.supabase.from('bank_transactions').update(patch).eq('id', txId);
    if (error) throw toolErrorFromDb(error, 'Modification refusée');
    return {
      summary: `Mouvement mis à jour — ${desc}.`,
      data: { bank_transaction_id: txId, changed: changes.map(([k]) => k), patch },
      next: ['get_pnl_breakdown'],
    };
  },
};

// ── Stock ──────────────────────────────────────────────────────────────────

const recordInventoryCount: AgentTool = {
  name: 'record_inventory_count',
  description:
    "Enregistre le comptage d'un ingrédient (inventaire physique) : quantité dans l'unité de la "
    + "mercuriale, à une date donnée, valorisée au dernier prix connu sauf prix indiqué. L'ingrédient "
    + "est reconnu par son nom exact ou un alias validé (get_ingredient_prices pour les noms). Un "
    + "comptage par appel ; plusieurs ingrédients = plusieurs appels, le même jour, pour former un "
    + "inventaire complet qui permettra de mesurer le coût matières consommé.",
  scope: 'write',
  schema: {
    type: 'object',
    properties: {
      ingredient: { type: 'string', description: 'Nom exact de l\'ingrédient (ou alias validé), tel que get_ingredient_prices le rend.' },
      quantity: { type: 'number', description: 'Quantité comptée, dans l\'unité de l\'ingrédient (kg, L, unité…). 0 est admis.', minimum: 0 },
      unit_price: { type: 'number', description: 'Prix unitaire HT pour la valorisation. Par défaut : le dernier prix d\'achat connu.', minimum: 0 },
      counted_at: { type: 'string', format: 'date', description: 'Jour du comptage (AAAA-MM-JJ). Par défaut : aujourd\'hui.' },
      dry_run: DRY_RUN_PROP,
    },
    required: ['ingredient', 'quantity'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const [{ data: ingredients }, { data: aliases }] = await Promise.all([
      ctx.supabase.from('ingredients').select('id, name, unit, last_unit_price'),
      ctx.supabase.from('ingredient_aliases').select('alias, ingredient_id'),
    ]);
    const all = (ingredients ?? []) as { id: string; name: string; unit: string | null; last_unit_price: number | null }[];
    const match = matchIngredient(String(args.ingredient), all, aliases ?? []);
    if (!match) {
      const key = normalizeName(String(args.ingredient));
      const close = all.filter(i => normalizeName(i.name).includes(key) || key.includes(normalizeName(i.name))).slice(0, 5).map(i => i.name);
      throw new ToolError(
        `Aucun ingrédient nommé « ${args.ingredient} ».`
        + (close.length > 0 ? ` Voulais-tu dire : ${close.join(', ')} ? Reprends le nom exact.` : ' Cherche le nom exact avec get_ingredient_prices ; un nouvel ingrédient se crée depuis l\'écran Stock.'),
        'not_found',
      );
    }

    const quantity = Number(args.quantity);
    const unitPrice = args.unit_price !== undefined ? Number(args.unit_price) : (match.last_unit_price ?? null);
    const day = (args.counted_at as string) || ctx.today;
    const valeur = unitPrice !== null ? round2(quantity * unitPrice) : null;
    const desc = `${match.name} : ${quantity} ${match.unit ?? 'unité'} au ${day}${valeur !== null ? `, valorisé ${eur(valeur)}` : ' (sans prix connu : non valorisé)'}`;

    if (args.dry_run) return { summary: `Simulation : ${desc}.`, data: { dry_run: true, ingredient_id: match.id, quantity, unit_price: unitPrice, counted_at: day, value: valeur } };

    const { data, error } = await ctx.supabase.from('inventory_counts')
      .insert({ ingredient_id: match.id, quantity, unit_price: unitPrice, counted_at: `${day}T21:00:00Z` })
      .select('id').single();
    if (error) throw toolErrorFromDb(error, 'Comptage refusé');
    return {
      summary: `Comptage enregistré — ${desc}.`,
      data: { count_id: data?.id, ingredient_id: match.id, ingredient: match.name, quantity, unit: match.unit, unit_price: unitPrice, counted_at: day, value: valeur },
      next: ['get_monthly_summary'],
    };
  },
};

export const ECRITURE_TOOLS: readonly AgentTool[] = [
  analyzeInvoiceDocument, registerInvoiceTool, linkInvoiceToBank, updateBankTransaction, recordInventoryCount,
];
