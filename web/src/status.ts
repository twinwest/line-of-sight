import type { SessionMeta } from './api';

/** Single derivation of a session's display status — the list and the view
 *  must agree, so neither owns it. Truth is the API's live/waiting/updatedAt. */

export const RUNNING_MS = 60_000;
const DONE_MS = 10 * 60_000;

/** Actionability order: waiting on the user > unseen result > running > idle.
 *  `unverifiable` (process alive, nothing written past the stale cap) ties
 *  with idle so it sorts by recency — a week-old abandoned process must not
 *  float above today's sessions; it differs in what the dot says, not where
 *  it sits. */
export type Status = 'waiting' | 'done' | 'busy' | 'unverifiable' | 'idle';
export const RANK: Record<Status, number> = { waiting: 0, done: 1, busy: 2, unverifiable: 3, idle: 3 };
export const DOT_TITLE: Record<Status, string> = {
  waiting: 'waiting for you', done: 'just finished', busy: 'running',
  unverifiable: 'no update', idle: 'idle',
};

/** Coarse `34m` / `2h` / `3d`, floored so it never overstates the silence. */
export function fmtQuiet(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Dot tooltip / status text. Unverifiable says what the observer last heard
 *  rather than what the agent is doing: the elapsed time is what lets the
 *  user apply knowledge Sight lacks (a 40-minute build, a long download). */
export function dotTitle(s: SessionMeta, st: Status, now: number): string {
  return st === 'unverifiable'
    ? `no update in ${fmtQuiet(now - (s.quietSince ?? now))} · process still alive`
    : DOT_TITLE[st];
}

/** The other sessions worth switching to from inside `current`: everything
 *  still in play, most actionable first. Idle ones are dropped — browsing them
 *  is the list page's job, not the switcher's. */
export function otherSessions(
  sessions: SessionMeta[], current: string, seen: Record<string, number>, now: number,
): { s: SessionMeta; st: Status }[] {
  return sessions
    .filter((s) => s.id !== current)
    .map((s) => ({ s, st: sessionStatus(s, seen, now) }))
    .filter((r) => r.st !== 'idle')
    .sort((a, b) => RANK[a.st] - RANK[b.st] || b.s.updatedAt - a.s.updatedAt);
}

export function sessionStatus(s: SessionMeta, seen: Record<string, number>, now: number): Status {
  if (s.waiting) return 'waiting';
  if (s.live) return 'busy';
  if (s.quietSince) return 'unverifiable';
  if (now - s.updatedAt < DONE_MS && s.updatedAt > (seen[s.id] ?? 0)) return 'done';
  // No freshness fallback to busy: reaching here with fresh writes means the
  // probe said not-running AND the user saw the tail (else 'done' above won),
  // so "running" would be a certain lie for the common just-watched-it-finish
  // case, in exchange for a blind-probe window that 'done' mostly covers anyway.
  return 'idle';
}
