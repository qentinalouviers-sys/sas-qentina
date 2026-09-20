/**
 * base.ts — Ce que tout outil d'agent partage : types, erreur, petits helpers.
 *
 * Séparé de `tools.ts` pour que le catalogue puisse être réparti sur plusieurs
 * fichiers (lecture, gestion, écritures) sans import circulaire : chaque
 * fichier d'outils importe ce socle, et `tools.ts` les assemble.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolSchema } from './schema';

export interface ToolContext {
  supabase: SupabaseClient;
  /** Date du jour en ISO — paramétrable, ce qui rend les outils testables. */
  today: string;
}

export interface ToolResult {
  /** Réponse déjà rédigée, en français. L'agent peut la citer telle quelle. */
  summary: string;
  data: Record<string, unknown>;
  /** Vrai quand une liste a été coupée par `limit`. */
  truncated?: boolean;
  /** Suites possibles, nommées par leur outil : de quoi enchaîner sans deviner. */
  next?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  schema: ToolSchema;
  /** 'read' ne modifie rien. 'write' exige une clé portant la portée write. */
  scope: 'read' | 'write';
  /**
   * Vrai si l'outil est coûteux (appel à un moteur IA) ou lent : annoncé au
   * modèle pour qu'il ne l'appelle pas en boucle.
   */
  expensive?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Erreur destinée au modèle : le message dit quoi faire, pas ce qui a planté. */
export class ToolError extends Error {
  constructor(message: string, readonly code = 'invalid_request') {
    super(message);
    this.name = 'ToolError';
  }
}

export const eur = (n: number) =>
  `${(Math.round(n * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Le mois demandé, ou le mois en cours. Refuse un mois futur, qui n'a rien à dire. */
export function resolveMonth(args: Record<string, unknown>, ctx: ToolContext): string {
  const month = (args.month as string) || ctx.today.slice(0, 7);
  if (month > ctx.today.slice(0, 7)) {
    throw new ToolError(
      `Le mois ${month} n'a pas encore commencé. Demande un mois écoulé ou le mois en cours (${ctx.today.slice(0, 7)}).`,
      'out_of_range',
    );
  }
  return month;
}

export const MONTH_PROP = {
  type: 'string' as const,
  format: 'month' as const,
  description: 'Mois au format AAAA-MM. Par défaut : le mois en cours.',
};

export const LIMIT_PROP = (def: number, max: number) => ({
  type: 'integer' as const,
  description: `Nombre maximum de lignes renvoyées (défaut ${def}, plafond ${max}).`,
  minimum: 1,
  maximum: max,
  default: def,
});

export const DRY_RUN_PROP = {
  type: 'boolean' as const,
  description: 'true = simuler : contrôles complets, rien n\'est écrit. Défaut : false.',
  default: false,
};

/** Nom d'une relation fournisseur telle que Supabase la rend (objet ou tableau). */
export function relationName(rel: unknown): string | null {
  const r = Array.isArray(rel) ? rel[0] : rel;
  return (r as { name?: string } | null | undefined)?.name ?? null;
}

/**
 * Traduit une erreur Postgres levée par un trigger de verrou en consigne.
 * Le message des triggers (clôture, compte courant) est déjà rédigé pour un
 * humain ; on l'expose tel quel avec le bon code, au lieu d'un « database_error ».
 */
export function toolErrorFromDb(error: { code?: string; message: string }, fallback: string): ToolError {
  const msg = error.message || '';
  if (/cl[oô]tur/i.test(msg)) return new ToolError(msg, 'month_closed');
  if (/d[ée]biteur|compte courant/i.test(msg)) return new ToolError(msg, 'cca_debtor');
  if (error.code === '23505') return new ToolError(`${fallback} : cette écriture existe déjà (contrainte d'unicité).`, 'already_linked');
  return new ToolError(`${fallback} : ${msg}`, 'database_error');
}
