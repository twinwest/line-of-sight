import { readConfig } from '../shared/config.js';
import { apiResponder } from './api.js';
import { claudeCliResponder } from './claudeCli.js';
import type { Responder } from './types.js';

export type { Responder, ResponderRequest } from './types.js';

// Resolution order (ARCHITECTURE §6): config override, else claude-cli if on
// PATH, else api if key configured. codex-cli ships v1.5 (not installed, S3).
const ENGINES: Responder[] = [claudeCliResponder, apiResponder];

export async function resolveResponder(): Promise<Responder | null> {
  const preferred = readConfig().responder;
  if (preferred) {
    const engine = ENGINES.find((e) => e.id === preferred);
    if (engine && await engine.available()) return engine;
  }
  for (const engine of ENGINES) {
    if (await engine.available()) return engine;
  }
  return null;
}
