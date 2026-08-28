import { readConfig, type SightConfig } from '../shared/config.js';
import type { SessionMeta } from '../shared/types.js';
import { apiResponder } from './api.js';
import { claudeCliResponder } from './claudeCli.js';
import { codexCliResponder } from './codexCli.js';
import type { Responder } from './types.js';

export type { Responder, ResponderRequest } from './types.js';
export { ANTHROPIC_OPTIONS } from './types.js';

const ENGINES: Responder[] = [claudeCliResponder, codexCliResponder, apiResponder];

/** Adapter→engine preference — the only coupling between the two vocabularies. */
const PREFERRED: Record<SessionMeta['adapter'], Responder['id']> = {
  'claude-code': 'claude-cli',
  codex: 'codex-cli',
};

/** Pure routing (ARCHITECTURE §6): a config pin is the only candidate — no
 *  silent fallback to an engine the user didn't pick. Otherwise the engine
 *  matching the viewed session's agent goes first, default order after it. */
export function candidates(cfg: SightConfig, adapter?: SessionMeta['adapter']): Responder[] {
  if (cfg.responder) {
    const pinned = ENGINES.find((e) => e.id === cfg.responder);
    return pinned ? [pinned] : [];
  }
  const match = adapter && ENGINES.find((e) => e.id === PREFERRED[adapter]);
  return match ? [match, ...ENGINES.filter((e) => e !== match)] : ENGINES;
}

export async function resolveResponder(adapter?: SessionMeta['adapter']): Promise<Responder | null> {
  for (const engine of candidates(readConfig(), adapter)) {
    if (await engine.available()) return engine;
  }
  return null;
}
