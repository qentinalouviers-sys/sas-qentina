import { NextRequest, NextResponse } from 'next/server';
import { authenticateAgent } from '@/lib/agent/auth';
import { executeTool } from '@/lib/agent/execute';

/**
 * Appel direct d'un outil — POST /api/agent/call
 *
 * La même chose que MCP, sans le protocole : pour un script, un plugin Python,
 * un curl de mise au point. Corps attendu :
 *
 *   { "tool": "get_monthly_summary", "arguments": { "month": "2026-06" } }
 *
 * Réponse : { ok, summary, data, truncated?, next? } ou { ok: false, error }.
 * Le code HTTP suit le fond — 400 pour un appel mal formé, 403 pour une portée
 * insuffisante — pour qu'un client HTTP ordinaire réagisse correctement sans
 * lire le corps.
 */

export const maxDuration = 60;

const STATUS_BY_CODE: Record<string, number> = {
  unknown_tool: 404,
  not_found: 404,
  invalid_arguments: 400,
  invalid_request: 400,
  out_of_range: 400,
  month_closed: 409,
  already_linked: 409,
  cca_debtor: 409,
  amount_mismatch: 409,
  invoice_refused: 422,
  insufficient_scope: 403,
  database_error: 502,
  tool_failed: 500,
};

export async function POST(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (auth.error) {
    return NextResponse.json(
      { ok: false, error: { code: auth.error.code, message: auth.error.message } },
      { status: auth.error.status },
    );
  }

  let body: { tool?: string; arguments?: unknown; args?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_json', message: 'Corps de requête illisible : envoie du JSON.' } },
      { status: 400 },
    );
  }

  const tool = String(body.tool ?? '');
  if (!tool) {
    return NextResponse.json(
      { ok: false, error: { code: 'missing_tool', message: 'Champ « tool » manquant. La liste des outils est sur GET /api/agent/tools.' } },
      { status: 400 },
    );
  }

  // « arguments » est le nom MCP, « args » celui que tout le monde tape.
  const outcome = await executeTool(tool, body.arguments ?? body.args, auth.identity);

  if (!outcome.ok || !outcome.result) {
    const code = outcome.error?.code ?? 'tool_failed';
    return NextResponse.json({ ok: false, error: outcome.error }, { status: STATUS_BY_CODE[code] ?? 400 });
  }

  return NextResponse.json({
    ok: true,
    tool,
    summary: outcome.result.summary,
    data: outcome.result.data,
    truncated: outcome.result.truncated ?? false,
    next: outcome.result.next ?? [],
  });
}
