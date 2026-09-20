/**
 * mcp.ts — Le serveur MCP (Model Context Protocol), sans HTTP.
 *
 * La route `/api/agent/mcp` ne fait que lire le corps et poser les en-têtes :
 * tout le protocole est ici, avec ses dépendances injectées (authentification,
 * exécution, catalogue), pour être exercé dans `npm run verify:compta` sans
 * base ni réseau. Un serveur MCP qui casse à l'initialisation rend l'agent
 * muet sans message ; c'est en test qu'on veut le voir.
 *
 * Méthodes servies : initialize, ping, tools/list, tools/call, resources/list,
 * resources/read, prompts/list, prompts/get, plus les notifications (sans
 * réponse). Les lots JSON-RPC (tableaux) sont acceptés : chaque message est
 * traité, les réponses sont rendues dans un tableau.
 */

import type { AgentIdentity, AuthFailure } from './auth';
import type { ExecuteOutcome } from './execute';
import type { AgentTool } from './base';
import { toMcpTool, renderResultText } from './manifest';
import { GUIDE_MARKDOWN, GUIDE_SHORT } from './guide';

/** Versions du protocole que ce serveur sait parler, la plus récente d'abord. */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'qentina', title: 'QENTINA — gestion du restaurant', version: '1.1.0' };

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Ce dont le protocole a besoin, fourni par la route (ou par un test). */
export interface McpDeps {
  authenticate: () => Promise<{ identity: AgentIdentity; error: null } | { identity: null; error: AuthFailure }>;
  tools: (identity: AgentIdentity) => readonly AgentTool[];
  execute: (name: string, args: unknown, identity: AgentIdentity) => Promise<ExecuteOutcome>;
}

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

// ── Ressources ─────────────────────────────────────────────────────────────

export const RESOURCES = [
  {
    uri: 'qentina://guide',
    name: 'guide',
    title: 'Guide de l\'agent QENTINA',
    description: 'Conventions, méthode, procédure facture et lettrage, règles métier, pièges. À lire en début de session.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'qentina://tools',
    name: 'catalogue',
    title: 'Catalogue des outils',
    description: 'Les outils visibles pour cette clé, avec leur portée (lecture/écriture) et leur schéma.',
    mimeType: 'application/json',
  },
] as const;

// ── Prompts ────────────────────────────────────────────────────────────────

const MONTH_ARG = { name: 'month', description: 'Mois au format AAAA-MM (défaut : le mois en cours).', required: false };

export const PROMPTS = [
  {
    name: 'bilan_du_mois',
    title: 'Bilan du mois',
    description: 'Santé, chiffres, ventes, TVA et compte de résultat d\'un mois, avec ce qui reste à faire.',
    arguments: [MONTH_ARG],
    build: (a: Record<string, string>) =>
      `Fais le bilan de gestion ${a.month ? `de ${a.month}` : 'du mois en cours'} pour QENTINA. `
      + 'Dans cet ordre : get_business_health (signale tout point critique en premier), get_monthly_summary, '
      + 'get_sales_report, get_pnl_breakdown, get_vat_report. Présente : ce qui empêche les chiffres d\'être '
      + 'justes, le chiffre d\'affaires et son évolution, le coût matières (mesuré ou estimé, dis lequel), '
      + 'les charges principales, la TVA à provisionner, et une liste d\'actions concrètes. Cite les phrases '
      + 'de synthèse des outils plutôt que de recalculer.',
  },
  {
    name: 'preparer_tva',
    title: 'Préparer la déclaration de TVA',
    description: 'Ce qui est déclarable, ce qui ne l\'est pas encore, et ce qu\'il faut rattacher avant de déclarer.',
    arguments: [MONTH_ARG],
    build: (a: Record<string, string>) =>
      `Prépare la déclaration de TVA ${a.month ? `de ${a.month}` : 'du mois en cours'}. Appelle get_vat_report, `
      + 'puis list_bank_transactions (status pending_invoice, direction debit, sur le mois) pour les dépenses sans '
      + 'facture, et list_invoices (bank_link unlinked) pour les factures sans paiement. Rends : TVA collectée par '
      + 'taux, TVA déductible, solde net, montant de TVA non ventilée (non déclarable en l\'état), et la liste des '
      + 'factures à réclamer aux fournisseurs avec la TVA en jeu. N\'invente aucune déduction sans facture.',
  },
  {
    name: 'traiter_facture',
    title: 'Traiter une facture',
    description: 'Lire, vérifier, corriger et enregistrer une facture fournisseur, avec lettrage bancaire.',
    arguments: [],
    build: () =>
      'Je vais te donner une facture (fichier). Procède ainsi : 1) analyze_invoice_document ; 2) relis extracted '
      + 'champ par champ contre le document et corrige ce qui est faux ; 3) pour chaque anomalie « a_confirmer », '
      + 'dis-moi ce que tu as vérifié et acquitte-la par son code ; 4) register_invoice avec dry_run: true, montre-moi '
      + 'le résultat, puis enregistre. Si un mouvement bancaire candidat correspond au centime, passe-le en '
      + 'bank_transaction_id. Ne force jamais un point qui te paraît faux.',
  },
  {
    name: 'lettrage_banque',
    title: 'Lettrer la banque',
    description: 'Rapprocher les dépenses en attente de facture avec les factures sans paiement.',
    arguments: [MONTH_ARG],
    build: (a: Record<string, string>) =>
      `Fais le lettrage bancaire ${a.month ? `de ${a.month}` : 'du mois en cours'} : list_bank_transactions `
      + '(status pending_invoice, direction debit) et list_invoices (bank_link unlinked). Propose les paires dont le '
      + 'montant est égal au centime et les dates proches, vérifie chacune avec link_invoice_to_bank_transaction en '
      + 'dry_run, puis lettre-les. Liste ensuite ce qui reste sans facture, par fournisseur, avec la TVA non récupérée.',
  },
] as const;

// ── Le protocole ───────────────────────────────────────────────────────────

/**
 * Traite UN message JSON-RPC. Renvoie null pour une notification (le client
 * n'attend rien). L'authentification n'est demandée qu'aux méthodes qui
 * touchent aux données : un client doit pouvoir découvrir le serveur avant
 * d'être autorisé, et aucune donnée n'est exposée par initialize ou ping.
 */
export async function handleMessage(msg: JsonRpcMessage, deps: McpDeps): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  if (!method) return isNotification ? null : fail(id, -32600, 'Requête invalide : « method » manquant.');
  if (method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    const asked = String(params.protocolVersion ?? '');
    return ok(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: GUIDE_SHORT,
    });
  }

  if (method === 'ping') return ok(id, {});

  // Tout le reste touche aux données : la clé devient obligatoire.
  const auth = await deps.authenticate();
  if (auth.error) return fail(id, -32001, auth.error.message, { code: auth.error.code, status: auth.error.status });
  const identity = auth.identity;

  switch (method) {
    case 'tools/list':
      return ok(id, { tools: deps.tools(identity).map(toMcpTool) });

    case 'tools/call': {
      const name = String(params.name ?? '');
      const outcome = await deps.execute(name, params.arguments, identity);
      if (!outcome.ok || !outcome.result) {
        // Une erreur d'OUTIL se renvoie dans le résultat avec isError, pas comme
        // erreur JSON-RPC : le modèle doit la lire et corriger son appel, alors
        // qu'une erreur de protocole est traitée comme une panne par le client.
        return ok(id, {
          content: [{ type: 'text', text: `[${outcome.error?.code ?? 'error'}] ${outcome.error?.message ?? 'Échec inconnu.'}` }],
          isError: true,
        });
      }
      return ok(id, {
        content: [{ type: 'text', text: renderResultText(outcome.result) }],
        structuredContent: outcome.result.data,
        isError: false,
      });
    }

    case 'resources/list':
      return ok(id, { resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType })) });

    case 'resources/read': {
      const uri = String(params.uri ?? '');
      if (uri === 'qentina://guide') return ok(id, { contents: [{ uri, mimeType: 'text/markdown', text: GUIDE_MARKDOWN }] });
      if (uri === 'qentina://tools') {
        const tools = deps.tools(identity).map(t => ({ name: t.name, scope: t.scope, expensive: !!t.expensive, description: t.description, inputSchema: toMcpTool(t).inputSchema }));
        return ok(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ identity: { name: identity.name, scopes: identity.scopes }, tools }, null, 2) }] });
      }
      return fail(id, -32002, `Ressource inconnue : « ${uri} ». Disponibles : ${RESOURCES.map(r => r.uri).join(', ')}.`);
    }

    case 'prompts/list':
      return ok(id, { prompts: PROMPTS.map(p => ({ name: p.name, title: p.title, description: p.description, arguments: [...p.arguments] })) });

    case 'prompts/get': {
      const name = String(params.name ?? '');
      const prompt = PROMPTS.find(p => p.name === name);
      if (!prompt) return fail(id, -32602, `Prompt inconnu : « ${name} ». Disponibles : ${PROMPTS.map(p => p.name).join(', ')}.`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, string>;
      return ok(id, {
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }],
      });
    }

    default:
      if (isNotification) return null;
      return fail(id, -32601, `Méthode inconnue : « ${method} ». Ce serveur expose initialize, ping, tools/list, tools/call, resources/list, resources/read, prompts/list et prompts/get.`);
  }
}

/**
 * Traite un corps de requête : un message, ou un lot (tableau). Renvoie la
 * ou les réponses, ou null si rien n'est attendu (notifications seules).
 */
export async function handleBody(body: unknown, deps: McpDeps): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return fail(null, -32600, 'Lot vide.');
    const responses: JsonRpcResponse[] = [];
    for (const msg of body) {
      const r = await handleMessage((msg && typeof msg === 'object' ? msg : {}) as JsonRpcMessage, deps);
      if (r) responses.push(r);
    }
    return responses.length > 0 ? responses : null;
  }
  if (!body || typeof body !== 'object') return fail(null, -32600, 'Requête invalide : un objet JSON-RPC est attendu.');
  return handleMessage(body as JsonRpcMessage, deps);
}
