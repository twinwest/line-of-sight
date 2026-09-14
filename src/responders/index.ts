import type { SessionMeta } from '../shared/types.js';
import { claudeCliResponder } from './claudeCli.js';
import { codexCliResponder } from './codexCli.js';
import type { Responder } from './types.js';

export type { Responder, ResponderRequest } from './types.js';
export { ANTHROPIC_OPTIONS } from './types.js';

const ENGINES: Responder[] = [claudeCliResponder, codexCliResponder];

/** A session is answered only by its own agent's CLI. */
const PREFERRED: Record<SessionMeta['adapter'], Responder['id']> = {
  'claude-code': 'claude-cli',
  codex: 'codex-cli',
};

/** Unknown/missing session context has no candidate. Never cross-fallback
 *  (decided 2026-09-13); a `responder` key left in an old config is ignored. */
export function candidates(adapter?: SessionMeta['adapter']): Responder[] {
  const match = adapter && ENGINES.find((e) => e.id === PREFERRED[adapter]);
  return match ? [match] : [];
}

export async function resolveResponder(adapter?: SessionMeta['adapter']): Promise<Responder | null> {
  for (const engine of candidates(adapter)) {
    if (await engine.available()) return engine;
  }
  return null;
}
