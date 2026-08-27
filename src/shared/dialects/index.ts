import type { SessionMeta } from '../types.js';
import { claudeCodeDialect } from './claudeCode.js';
import type { Dialect } from './types.js';

export type { AskOption, AskQuestion, Dialect, EditPair, Plumbing } from './types.js';
export { claudeCodeDialect } from './claudeCode.js';

/** The defensive floor an unknown agent gets: no cards, no queue strip, no
 *  plumbing detection — every tool is a generic fold, every user text line
 *  is real speech. */
export const genericDialect: Dialect = {
  displayName: '',
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

/** Closed dispatch — extend per agent alongside the adapter union, no
 *  registry magic. */
export function dialectFor(adapter: SessionMeta['adapter']): Dialect {
  return adapter === 'claude-code' ? claudeCodeDialect
    : { ...genericDialect, displayName: adapter };
}
