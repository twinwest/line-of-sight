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

const CONFIG_FILE = path.join(SIGHT_DIR, 'config.json');

export function readConfig(file = CONFIG_FILE): SightConfig {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SightConfig;
  } catch {
    return {};
  }
}

/** Merge a partial config into the file. undefined = leave untouched; '' = clear the key. */
export function writeConfig(patch: Partial<SightConfig>, file = CONFIG_FILE): SightConfig {
  const merged: Record<string, unknown> = { ...readConfig(file) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === '') delete merged[k];
    else merged[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return merged as SightConfig;
}
