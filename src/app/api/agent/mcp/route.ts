import { NextRequest, NextResponse } from 'next/server';
import { authenticateAgent } from '@/lib/agent/auth';
import { executeTool, visibleTools, toMcpTool, renderResultText } from '@/lib/agent/execute';

/**
 * Serveur MCP (Model Context Protocol) — POST /api/agent/mcp
 *
 * C'est la porte par laquelle un agent branche QENTINA : Hermes Agent, Claude
 * Desktop, Cursor, VS Code parlent tous ce protocole. Transport HTTP, JSON-RPC
 * 2.0, une requête = une réponse.
 *
 * Pourquoi ne pas avoir pris un SDK : le protocole tient en quatre méthodes
 * (initialize, ping, tools/list, tools/call), et une dépendance de plus à
 * suivre pour 120 lignes de JSON-RPC coûte plus cher qu'elle ne rapporte —
 * d'autant que la version du protocole se négocie, justement, dans ces lignes.
 *
 * Authentification : en-tête « Authorization: Bearer qk_live_… ». La portée de
 * la clé décide de ce que l'agent VOIT : une clé en lecture seule ne se voit
 * même pas proposer les outils d'écriture, ce qui évite qu'un modèle passe son
 * tour à essayer un outil qu'il ne peut pas appeler.
 */

export const maxDuration = 60;

/** Versions du protocole que ce serveur sait parler, la plus récente d'abord. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'qentina', title: 'QENTINA — gestion du restaurant', version: '1.0.0' };

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  let body: { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'JSON illisible dans le corps de la requête.', 400);
  }

  const id = body.id ?? null;
  const method = body.method ?? '';
  const params = body.params ?? {};

  // Une notification (pas d'identifiant) n'attend aucune réponse : le protocole
  // veut un 202 sans corps. Répondre un objet JSON-RPC ici fait échouer
  // l'initialisation chez les clients stricts.
  const isNotification = body.id === undefined || body.id === null;

  if (method === 'initialize') {
    const asked = String(params.protocolVersion ?? '');
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
    // L'initialisation ne demande pas de clé : un client doit pouvoir découvrir
    // le serveur avant d'être autorisé. Aucune donnée n'est exposée ici.
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Outils de gestion d'un restaurant (comptabilité, TVA, banque, comptes d'associés, frais "
        + "kilométriques). Commence par get_business_health pour savoir ce qui ne va pas, puis "
        + "get_monthly_summary pour les chiffres d'un mois. Chaque réponse contient une phrase de "
        + "synthèse en français : cite-la plutôt que de recalculer. Les montants sont en euros, les "
        + "dates au format AAAA-MM-JJ, les mois au format AAAA-MM.",
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return new NextResponse(null, { status: 202 });
  }

  if (method === 'ping') return rpcResult(id, {});

  // Tout le reste touche aux données : la clé devient obligatoire.
  const auth = await authenticateAgent(request);
  if (auth.error) {
    return rpcError(id, -32001, auth.error.message, auth.error.status);
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: visibleTools(auth.identity).map(toMcpTool) });
  }

  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const outcome = await executeTool(name, params.arguments, auth.identity);

    if (!outcome.ok || !outcome.result) {
      // Une erreur d'OUTIL se renvoie dans le résultat avec isError, pas comme
      // erreur JSON-RPC : le modèle doit la lire et corriger son appel, alors
      // qu'une erreur de protocole est traitée comme une panne par le client.
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.error?.message ?? 'Échec inconnu.' }],
        isError: true,
      });
    }

    return rpcResult(id, {
      content: [{ type: 'text', text: renderResultText(outcome.result) }],
      structuredContent: outcome.result.data,
      isError: false,
    });
  }

  if (isNotification) return new NextResponse(null, { status: 202 });

  return rpcError(id, -32601, `Méthode inconnue : « ${method} ». Ce serveur expose initialize, ping, tools/list et tools/call.`);
}

/** Un GET sur un serveur MCP arrive quand on colle l'URL dans un navigateur. */
export async function GET() {
  return NextResponse.json({
    server: SERVER_INFO,
    protocol: 'Model Context Protocol',
    transport: 'HTTP (JSON-RPC 2.0) — envoie une requête POST',
    protocolVersions: SUPPORTED_PROTOCOLS,
    authentication: 'Authorization: Bearer qk_live_… (Réglages → Agents IA)',
    documentation: '/api/agent/tools',
  }, { status: 200 });
}
