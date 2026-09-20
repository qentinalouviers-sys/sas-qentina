/**
 * manifest.ts — Décrire les outils à un agent, sans rien exécuter.
 *
 * Séparé de l'exécution pour une raison pratique : ces fonctions ne touchent ni
 * à la base ni à la requête HTTP, donc elles se testent directement dans
 * `npm run verify:compta`. Un schéma d'outil cassé est un défaut qu'on veut
 * voir en test, pas en production quand l'agent choisit l'outil à l'aveugle.
 */

import { AGENT_TOOLS } from './tools';
import type { AgentTool, ToolResult } from './base';
import { toJsonSchema } from './schema';

/** Les outils visibles pour une identité donnée : une clé lecture ne voit pas les écritures. */
export function visibleTools(identity: { scopes: readonly string[] }) {
  return AGENT_TOOLS.filter(t => identity.scopes.includes(t.scope));
}

/** Description d'un outil au format attendu par MCP (`tools/list`). */
export function toMcpTool(tool: AgentTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.schema),
    annotations: {
      title: tool.name,
      readOnlyHint: tool.scope === 'read',
      // Aucun outil ne supprime : les écritures ajoutent ou corrigent, et un
      // mois clôturé les refuse. Toutes sont rejouables sans doublon.
      destructiveHint: false,
      idempotentHint: true,
      // Tout se passe dans la base du restaurant : pas d'accès au monde extérieur.
      openWorldHint: false,
    },
  };
}

/** Description au format « function calling » (OpenAI, Hermes, Mistral…). */
export function toFunctionSpec(tool: AgentTool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.schema),
    },
  };
}

/**
 * Le texte que lit le modèle dans un résultat MCP.
 *
 * La synthèse d'abord, le JSON ensuite : un modèle qui s'arrête à la première
 * ligne a déjà la réponse, celui qui a besoin du détail le trouve dessous.
 */
export function renderResultText(result: ToolResult): string {
  const parts = [result.summary];
  if (result.truncated) parts.push('(liste tronquée : augmente « limit » ou resserre la période)');
  if (result.next?.length) parts.push(`Pour aller plus loin : ${result.next.join(', ')}.`);
  parts.push('```json\n' + JSON.stringify(result.data, null, 2) + '\n```');
  return parts.join('\n\n');
}
