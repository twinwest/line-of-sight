import fs from 'node:fs';
import path from 'node:path';
import { SIGHT_DIR } from './paths.js';

export interface SightConfig {
  responder?: 'claude-cli' | 'codex-cli' | 'api';
  apiKey?: string;
  /** Model for responder invocations (claude-cli --model / api model id). Engine default if unset. */
  responderModel?: string;
  /** Effort for responder invocations: low | medium | high | xhigh | max. Engine default if unset. */
  responderEffort?: string;
}

export function readConfig(): SightConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(SIGHT_DIR, 'config.json'), 'utf8')) as SightConfig;
  } catch {
    return {};
  }
}
