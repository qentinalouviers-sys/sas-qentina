import { NextRequest, NextResponse } from 'next/server';
import { authenticateAgent } from '@/lib/agent/auth';
import { executeTool, visibleTools } from '@/lib/agent/execute';
import { handleBody, SERVER_INFO, SUPPORTED_PROTOCOLS, type McpDeps } from '@/lib/agent/mcp';

/**
 * Serveur MCP (Model Context Protocol) — POST /api/agent/mcp
 *
 * C'est la porte par laquelle un agent branche QENTINA : Hermes Agent, Claude
 * Desktop, Cursor, VS Code parlent tous ce protocole. Transport « Streamable
 * HTTP » en mode simple : JSON-RPC 2.0, une requête POST = une réponse JSON,
 * pas de flux SSE ni de session (le serveur est sans état, chaque appel porte
 * sa clé). Le protocole lui-même vit dans lib/agent/mcp.ts, testé à part.
 *
 * Authentification : en-tête « Authorization: Bearer qk_live_… ». La portée de
 * la clé décide de ce que l'agent VOIT : une clé en lecture seule ne se voit
 * même pas proposer les outils d'écriture.
 */

export const maxDuration = 60;

function deps(request: NextRequest): McpDeps {
  return {
    authenticate: () => authenticateAgent(request),
    tools: identity => visibleTools(identity),
    execute: (name, args, identity) => executeTool(name, args, identity),
  };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON illisible dans le corps de la requête.' } }, { status: 400 });
  }

  const response = await handleBody(body, deps(request));

  // Une notification (ou un lot de notifications) n'attend aucune réponse :
  // le protocole veut un 202 sans corps. Répondre un objet JSON-RPC ici fait
  // échouer l'initialisation chez les clients stricts.
  if (response === null) return new NextResponse(null, { status: 202 });

  // Une erreur d'authentification garde son code HTTP : un client HTTP
  // ordinaire (et le préflight de certains agents) s'appuie dessus.
  const single = Array.isArray(response) ? null : response;
  const authData = single?.error?.data as { status?: number } | undefined;
  const status = single?.error?.code === -32001 && authData?.status ? authData.status : 200;

  return NextResponse.json(response, { status });
}

/**
 * GET : un client MCP qui ouvre un flux SSE (Accept: text/event-stream) reçoit
 * 405, comme le transport le prévoit pour un serveur sans flux. Un navigateur
 * qui colle l'URL reçoit une description lisible.
 */
export async function GET(request: NextRequest) {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
  }
  return NextResponse.json({
    server: SERVER_INFO,
    protocol: 'Model Context Protocol',
    transport: 'Streamable HTTP, mode JSON (POST une requête JSON-RPC 2.0 ; pas de flux SSE, pas de session)',
    protocolVersions: SUPPORTED_PROTOCOLS,
    methods: ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'],
    authentication: 'Authorization: Bearer qk_live_… (Réglages → Agents IA)',
    documentation: '/api/agent/tools',
  }, { status: 200 });
}

/** Pas de session à terminer : le serveur est sans état. */
export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
