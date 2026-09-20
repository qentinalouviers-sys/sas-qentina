import { NextResponse } from 'next/server';
import { GUIDE_MARKDOWN } from '@/lib/agent/guide';

/**
 * Le guide de l'agent, en markdown — GET /api/agent/guide
 *
 * Sans authentification : il ne contient aucune donnée, seulement les règles
 * et la méthode. Un agent qui ne parle pas MCP (script, plugin) peut ainsi
 * l'injecter dans son contexte avant son premier appel.
 */
export async function GET() {
  return new NextResponse(GUIDE_MARKDOWN, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
