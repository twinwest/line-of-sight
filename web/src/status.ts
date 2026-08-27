import type { SessionMeta } from './api';

/** Single derivation of a session's display status — the list and the view
 *  must agree, so neither owns it. Truth is the API's live/waiting/updatedAt. */

export const RUNNING_MS = 60_000;
const DONE_MS = 10 * 60_000;

/** Actionability order: waiting on the user > unseen result > running > idle. */
export type Status = 'waiting' | 'done' | 'busy' | 'idle';
export const RANK: Record<Status, number> = { waiting: 0, done: 1, busy: 2, idle: 3 };
export const DOT_TITLE: Record<Status, string> = {
  waiting: 'waiting for you', done: 'just finished', busy: 'running', idle: 'idle',
};

export function sessionStatus(s: SessionMeta, seen: Record<string, number>, now: number): Status {
  if (s.waiting) return 'waiting';
  if (s.live) return 'busy';
  if (now - s.updatedAt < DONE_MS && s.updatedAt > (seen[s.id] ?? 0)) return 'done';
  // adapters without a live signal: recent transcript activity = probably running
  if (now - s.updatedAt < RUNNING_MS) return 'busy';
  return 'idle';
}
