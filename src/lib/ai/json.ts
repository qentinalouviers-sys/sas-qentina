/**
 * json.ts — Extraction robuste du JSON renvoyé par Claude.
 * Fusion des 3 parseurs qui existaient (invoices/extract, bank/extract, scanner)
 * en un seul, testable et réutilisable.
 *
 * Stratégie en cascade :
 *  1. Parse direct du bloc {...} le plus large.
 *  2. Nettoyage des virgules terminales.
 *  3. Réparation d'un JSON tronqué (max_tokens atteint) en refermant
 *     au dernier objet complet d'un tableau.
 */
export function extractJson<T = any>(text: string): T {
  let cleaned = text.trim();

  // Isoler le bloc JSON (ignore le markdown ou le texte autour)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  // Virgules terminales : {"a": 1,} → {"a": 1}
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  // Réponse tronquée : refermer au dernier objet complet du tableau racine
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  let lastValidCharIndex = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escape) { escape = false; continue; }
    if (char === '\\') { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') openBraces++;
      else if (char === '}') {
        openBraces--;
        if (openBraces === 1 && openBrackets === 1) lastValidCharIndex = i;
      } else if (char === '[') openBrackets++;
      else if (char === ']') openBrackets--;
    }
  }

  if (lastValidCharIndex !== -1) {
    const repaired = cleaned.substring(0, lastValidCharIndex + 1) + '\n  ]\n}';
    return JSON.parse(repaired);
  }

  throw new Error('JSON non parsable après tentatives de réparation');
}
