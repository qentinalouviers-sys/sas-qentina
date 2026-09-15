/**
 * schema.ts — Validation des arguments d'un outil, sans dépendance.
 *
 * Un agent n'est pas un formulaire : il invente des paramètres, les type mal,
 * envoie « juin 2026 » là où on attend « 2026-06 », et oublie les obligatoires.
 * Rejeter ces appels avec un message PRÉCIS vaut mieux que de les laisser
 * atteindre la base : le modèle corrige son appel au tour suivant s'il sait
 * exactement ce qui cloche, alors qu'un « 500 Internal Error » le fait
 * abandonner ou inventer une réponse.
 *
 * Volontairement minimal : le sous-ensemble de JSON Schema que les outils
 * utilisent réellement. Ce qui n'est pas décrit ici n'est pas descriptible dans
 * un outil — c'est une contrainte, pas un manque.
 */

export type PropType = 'string' | 'number' | 'integer' | 'boolean';

export interface PropSchema {
  type: PropType;
  /** Décrit le paramètre POUR LE MODÈLE : formats attendus, valeur par défaut. */
  description: string;
  enum?: readonly string[];
  /** Format contrôlé : mois « AAAA-MM », date « AAAA-MM-JJ », année. */
  format?: 'month' | 'date' | 'year' | 'uuid';
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, PropSchema>;
  required?: readonly string[];
  additionalProperties?: false;
}

export interface ValidationError {
  /** Nom du paramètre fautif, ou '' si l'erreur porte sur l'ensemble. */
  field: string;
  message: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkFormat(value: string, format: PropSchema['format']): string | null {
  switch (format) {
    case 'month':
      return MONTH_RE.test(value) ? null : 'format attendu « AAAA-MM » (ex. « 2026-06 »)';
    case 'date':
      return DATE_RE.test(value) ? null : 'format attendu « AAAA-MM-JJ » (ex. « 2026-06-14 »)';
    case 'uuid':
      return UUID_RE.test(value) ? null : 'identifiant attendu au format UUID';
    default:
      return null;
  }
}

/**
 * Valide et normalise les arguments d'un appel d'outil.
 *
 * Applique aussi les valeurs par défaut : un agent qui omet `limit` obtient la
 * même réponse bornée qu'un agent qui la précise.
 *
 * @returns les arguments normalisés, ou la liste des erreurs.
 */
export function validateArgs(
  schema: ToolSchema,
  raw: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, errors: [{ field: '', message: 'les arguments doivent être un objet JSON' }] };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Un paramètre inconnu est presque toujours une confusion entre deux outils :
  // le signaler en nommant les paramètres admis coûte un tour et évite une
  // réponse calculée sur un filtre ignoré en silence.
  for (const key of Object.keys(input)) {
    if (!(key in schema.properties)) {
      errors.push({
        field: key,
        message: `paramètre inconnu. Admis : ${Object.keys(schema.properties).join(', ') || 'aucun'}`,
      });
    }
  }

  for (const [name, prop] of Object.entries(schema.properties)) {
    const present = input[name] !== undefined && input[name] !== null && input[name] !== '';
    if (!present) {
      if (schema.required?.includes(name)) {
        errors.push({ field: name, message: `paramètre obligatoire manquant — ${prop.description}` });
      } else if (prop.default !== undefined) {
        out[name] = prop.default;
      }
      continue;
    }

    const value = input[name];

    if (prop.type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ field: name, message: `attendu : une chaîne de caractères` });
        continue;
      }
      const trimmed = value.trim();
      if (prop.enum && !prop.enum.includes(trimmed)) {
        errors.push({ field: name, message: `valeur non admise. Attendu : ${prop.enum.join(' | ')}` });
        continue;
      }
      const formatError = checkFormat(trimmed, prop.format);
      if (formatError) { errors.push({ field: name, message: formatError }); continue; }
      out[name] = trimmed;
      continue;
    }

    if (prop.type === 'boolean') {
      // Un modèle envoie volontiers la chaîne « true » : l'accepter évite un
      // aller-retour sans rien masquer d'ambigu.
      if (typeof value === 'boolean') { out[name] = value; continue; }
      if (value === 'true' || value === 'false') { out[name] = value === 'true'; continue; }
      errors.push({ field: name, message: 'attendu : true ou false' });
      continue;
    }

    // number / integer
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      errors.push({ field: name, message: 'attendu : un nombre' });
      continue;
    }
    if (prop.type === 'integer' && !Number.isInteger(num)) {
      errors.push({ field: name, message: 'attendu : un nombre entier' });
      continue;
    }
    if (prop.format === 'year' && (num < 2000 || num > 2100)) {
      errors.push({ field: name, message: 'année attendue entre 2000 et 2100' });
      continue;
    }
    if (prop.minimum !== undefined && num < prop.minimum) {
      errors.push({ field: name, message: `minimum ${prop.minimum}` });
      continue;
    }
    // Un agent demande « limit: 5000 » pour « tout voir ». On ne refuse pas :
    // on ramène au plafond, et la réponse dit qu'elle est tronquée.
    out[name] = prop.maximum !== undefined ? Math.min(num, prop.maximum) : num;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/** Message d'erreur unique, lisible par un modèle comme par un humain. */
export function describeErrors(tool: string, errors: readonly ValidationError[]): string {
  return `Appel refusé pour l'outil « ${tool} » :\n`
    + errors.map(e => `  - ${e.field ? `${e.field} : ` : ''}${e.message}`).join('\n');
}

/** Le schéma tel qu'un client MCP ou une API de function-calling l'attend. */
export function toJsonSchema(schema: ToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const entry: Record<string, unknown> = {
      type: prop.type === 'integer' ? 'integer' : prop.type,
      description: prop.description,
    };
    if (prop.enum) entry.enum = [...prop.enum];
    if (prop.minimum !== undefined) entry.minimum = prop.minimum;
    if (prop.maximum !== undefined) entry.maximum = prop.maximum;
    if (prop.default !== undefined) entry.default = prop.default;
    properties[name] = entry;
  }
  return {
    type: 'object',
    properties,
    required: [...(schema.required ?? [])],
    additionalProperties: false,
  };
}
