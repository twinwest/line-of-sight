import type { SessionMeta } from '../types.js';
import { claudeCodeDialect } from './claudeCode.js';
import { codexDialect } from './codex.js';
import type { Dialect } from './types.js';

export type { AskOption, AskQuestion, Dialect, EditPair, Plumbing } from './types.js';
export { claudeCodeDialect } from './claudeCode.js';
export { codexDialect } from './codex.js';

/** The defensive floor an unknown agent gets: no cards, no queue strip, no
 *  plumbing detection — every tool is a generic fold, every user text line
 *  is real speech. */
export const genericDialect: Dialect = {
  displayName: '',
  resumeArgv: () => null,
  isBlockingUse: () => false,
  askQuestions: () => null,
  chosenAnswer: () => null,
  isPlanUse: () => false,
  planMarkdown: () => null,
  planDraft: () => null,
  editDiff: () => null,
  plumbing: () => null,
  isQueueOp: () => false,
  queuedInputs: () => [],
};

/** One shell line that reopens a session: `cd <dir> && <agent resume argv>`.
 *  Null when the agent has no resume, or when the id is not a plain token —
 *  ids come from filenames and rollout headers, which a transcript could fill
 *  with anything, so one is never interpolated raw (no leading `-` either:
 *  `--resume -x` would read as a flag). Copy-only, like everything else that
 *  leaves the viewer (SPEC §6). */
export function resumeCommand(d: Dialect, sessionId: string, projectDir: string | null): string | null {
  if (!/^(?!-)[\w.-]+$/.test(sessionId)) return null;
  const argv = d.resumeArgv(sessionId);
  if (!argv) return null;
  const cmd = argv.join(' ');
  return projectDir ? `cd '${projectDir.replaceAll("'", "'\\''")}' && ${cmd}` : cmd;
}

/** Closed dispatch — extend per agent alongside the adapter union, no
 *  registry magic. */
export function dialectFor(adapter: SessionMeta['adapter']): Dialect {
  if (adapter === 'claude-code') return claudeCodeDialect;
  if (adapter === 'codex') return codexDialect;
  return { ...genericDialect, displayName: adapter };
}
