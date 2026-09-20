import { NextRequest, NextResponse } from 'next/server';
import { authenticateAgent } from '@/lib/agent/auth';
import { visibleTools, toMcpTool, toFunctionSpec } from '@/lib/agent/execute';
import { getAppUrl } from '@/lib/env';

/**
 * Découverte — GET /api/agent/tools
 *
 * Le catalogue des outils, dans les deux formats que consomment les agents :
 * `tools` (schéma MCP) et `functions` (function-calling façon OpenAI, que
 * lisent aussi Hermes et Mistral). Un agent qui ne parle pas MCP peut donc
 * s'équiper en une requête.
 *
 * `?format=functions` ne renvoie que le tableau de fonctions, prêt à coller
 * dans un appel de modèle.
 */

export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (auth.error) {
    return NextResponse.json(
      { ok: false, error: { code: auth.error.code, message: auth.error.message } },
      { status: auth.error.status },
    );
  }

  const tools = visibleTools(auth.identity);

  if (request.nextUrl.searchParams.get('format') === 'functions') {
    return NextResponse.json(tools.map(toFunctionSpec));
  }

  let base = '';
  try { base = getAppUrl(); } catch { base = ''; }

  return NextResponse.json({
    ok: true,
    identity: { kind: auth.identity.kind, name: auth.identity.name, scopes: auth.identity.scopes },
    endpoints: {
      mcp: `${base}/api/agent/mcp`,
      call: `${base}/api/agent/call`,
      tools: `${base}/api/agent/tools`,
    },
    conventions: {
      montants: 'euros, nombres décimaux',
      dates: 'AAAA-MM-JJ',
      mois: 'AAAA-MM',
      reponses: 'chaque résultat porte une phrase de synthèse en français, à citer telle quelle',
      ecritures: "idempotentes : rejouer un appel ne duplique rien. Utiliser dry_run pour simuler.",
      guide: 'GET /api/agent/guide (markdown) ou ressource MCP qentina://guide',
    },
    count: tools.length,
    scopes: { read: tools.filter(t => t.scope === 'read').map(t => t.name), write: tools.filter(t => t.scope === 'write').map(t => t.name) },
    expensive: tools.filter(t => t.expensive).map(t => t.name),
    tools: tools.map(toMcpTool),
    functions: tools.map(toFunctionSpec),
  });
}
