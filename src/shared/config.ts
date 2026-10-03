import fs from 'node:fs';
import path from 'node:path';
import { codexModels } from './codexModels.js';
import { SIGHT_DIR } from './paths.js';

export interface SightConfig {
  /** Model used only for Claude Ask invocations (claude --model). Sight defaults to sonnet. */
  responderModel?: string;
  /** Effort used only for Claude Ask invocations. Sight defaults to medium. */
  responderEffort?: string;
  /** Model used only for Codex Ask invocations. Sight defaults to Terra (see codexDefaultModel). */
  codexResponderModel?: string;
  /** Effort used only for Codex Ask invocations. Sight defaults to medium. */
  codexResponderEffort?: string;
  /** Keep side chats (question, answers, and the conversation snapshot taken
   *  when the question was asked) after their transcript leaves the disk.
   *  Off = SPEC B9 as written: they go with the session. */
  keepSideChats?: boolean;
}

export type ResponderEngine = 'claude-cli' | 'codex-cli';

export const CODEX_ASK_DEFAULTS = { model: 'gpt-5.6-terra', effort: 'medium' } as const;
/** Sight's Codex default while Codex still lists it (or the list is unknown);
 *  once Codex retires it, Codex's own first pick — so a stale default does not
 *  fail every ask of a user who never opened the model picker. */
export function codexDefaultModel(listed: string[]): string {
  return listed.length && !listed.includes(CODEX_ASK_DEFAULTS.model) ? listed[0]! : CODEX_ASK_DEFAULTS.model;
}
/** An alias, not a versioned id: the installed claude resolves it to its
 *  newest Sonnet. Never left to the CLI's own default, which skips the user's
 *  settings here (--setting-sources '') and can be the slowest model. */
export const CLAUDE_ASK_DEFAULTS = { model: 'sonnet', effort: 'medium' } as const;

/** Settings shown by the panel and used by the next Ask invocation. Keeping
 * this mapping here prevents either responder from reading the other one's
 * model names. */
export function responderSettings(engine: ResponderEngine, config: SightConfig):
    { model: string; effort: string } {
  if (engine === 'codex-cli') {
    return {
      model: config.codexResponderModel || codexDefaultModel(codexModels()),
      effort: config.codexResponderEffort || CODEX_ASK_DEFAULTS.effort,
    };
  }
  return {
    model: config.responderModel || CLAUDE_ASK_DEFAULTS.model,
    effort: config.responderEffort || CLAUDE_ASK_DEFAULTS.effort,
  };
}

/** Translate the panel's engine-neutral field names to their persisted keys. */
export function responderConfigPatch(engine: ResponderEngine,
    selection: Partial<{ model: string; effort: string }>): Partial<SightConfig> {
  const patch: Partial<SightConfig> = {};
  if (engine === 'codex-cli') {
    if (selection.model !== undefined) patch.codexResponderModel = selection.model;
    if (selection.effort !== undefined) patch.codexResponderEffort = selection.effort;
  } else {
    if (selection.model !== undefined) patch.responderModel = selection.model;
    if (selection.effort !== undefined) patch.responderEffort = selection.effort;
  }
  return patch;
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
