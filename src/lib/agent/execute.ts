/**
 * execute.ts — Exécuter un outil, d'où que vienne l'appel.
 *
 * Trois portes mènent aux mêmes outils : MCP (Hermes Agent, Claude Desktop…),
 * l'appel REST direct, et le manifeste de function-calling. Elles partagent
 * cette fonction pour que les contrôles — portée de la clé, validation des
 * arguments, journalisation — ne puissent pas diverger d'une porte à l'autre.
 *
 * Aucune exception ne remonte : un agent reçoit toujours un objet exploitable,
 * jamais une pile d'appels. Un message d'erreur est une consigne, pas un
 * diagnostic technique.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { findTool, suggestTools, ToolError, type ToolResult } from './tools';
import { validateArgs, describeErrors } from './schema';
import { checkScope, logAgentCall, type AgentIdentity } from './auth';

export { visibleTools, toMcpTool, toFunctionSpec, renderResultText } from './manifest';

export interface ExecuteOutcome {
  ok: boolean;
  result?: ToolResult;
  error?: { code: string; message: string };
}

/** Le jour courant, en ISO. Isolé ici pour rester testable. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  identity: AgentIdentity,
  today = todayIso(),
): Promise<ExecuteOutcome> {
  const started = Date.now();
  const tool = findTool(name);

  const fail = async (code: string, message: string, scope?: string): Promise<ExecuteOutcome> => {
    await logAgentCall({
      identity, tool: name, args: rawArgs, ok: false, errorCode: code,
      durationMs: Date.now() - started, scope: scope ?? tool?.scope ?? null,
    });
    return { ok: false, error: { code, message } };
  };

  if (!tool) {
    return fail(
      'unknown_tool',
      `Outil inconnu : « ${name} ». Outils les plus proches : ${suggestTools(name).join(', ')}. `
      + `La liste complète est renvoyée par tools/list (MCP) ou GET /api/agent/tools.`,
    );
  }

  const scopeError = checkScope(identity, tool.scope);
  if (scopeError) return fail(scopeError.code, scopeError.message);

  const parsed = validateArgs(tool.schema, rawArgs);
  if (!parsed.ok) return fail('invalid_arguments', describeErrors(tool.name, parsed.errors));

  try {
    const result = await tool.handler(parsed.value, {
      supabase: createServiceRoleClient(),
      today,
    });
    await logAgentCall({
      identity, tool: tool.name, args: parsed.value, ok: true,
      durationMs: Date.now() - started, scope: tool.scope,
    });
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message);
    // Un défaut de l'outil, pas de l'appel : on le dit comme tel, pour que
    // l'agent cesse de réessayer un appel pourtant bien formé.
    console.error(`[Agent] ${tool.name} :`, e);
    return fail(
      'tool_failed',
      `L'outil « ${tool.name} » a échoué : ${e instanceof Error ? e.message : String(e)}. `
      + `L'appel était valide : inutile de le réessayer à l'identique, signale le problème.`,
    );
  }
}
