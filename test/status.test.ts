import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/shared/types.js';
import { dotTitle, fmtQuiet, otherSessions, RANK, sessionStatus } from '../web/src/status.js';

const NOW = 1_700_000_000_000;

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id, adapter: 'claude-code', filePath: `/x/${id}.jsonl`, projectDir: '/x',
    title: id, startedAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, messageCount: 1,
    ...over,
  };
}

describe('otherSessions', () => {
  it('drops the session you are already in, even when it is waiting', () => {
    const rows = otherSessions([meta('a', { waiting: true }), meta('b', { live: true })],
      'a', {}, NOW);
    expect(rows.map((r) => r.s.id)).toEqual(['b']);
  });

  it('drops idle sessions — the list page owns those', () => {
    const rows = otherSessions([meta('old'), meta('b', { live: true })], 'cur', {}, NOW);
    expect(rows.map((r) => r.s.id)).toEqual(['b']);
  });

  it('orders by actionability, then by recency within a status', () => {
    const rows = otherSessions([
      meta('busy', { live: true }),
      meta('waiting', { waiting: true }),
      meta('busy-newer', { live: true, updatedAt: NOW - 1000 }),
      meta('done', { updatedAt: NOW - 60_000 }),
    ], 'cur', {}, NOW);
    expect(rows.map((r) => r.st)).toEqual(['waiting', 'done', 'busy', 'busy']);
    expect(rows.map((r) => r.s.id)).toEqual(['waiting', 'done', 'busy-newer', 'busy']);
  });

  it('counts nothing when every other session is idle', () => {
    expect(otherSessions([meta('a'), meta('b')], 'cur', {}, NOW)).toEqual([]);
  });
});

describe('unverifiable: process alive, nothing written past the stale cap', () => {
  const MIN = 60_000;
  const quiet = meta('q', { updatedAt: NOW - 34 * MIN, quietSince: NOW - 34 * MIN });

  it('is its own status, and the title says how long the observer has heard nothing', () => {
    expect(sessionStatus(quiet, {}, NOW)).toBe('unverifiable');
    expect(dotTitle(quiet, 'unverifiable', NOW)).toBe('no update in 34m · process still alive');
  });

  it('stays in the switcher, after running sessions', () => {
    const rows = otherSessions([quiet, meta('busy', { live: true })], 'cur', {}, NOW);
    expect(rows.map((r) => r.st)).toEqual(['busy', 'unverifiable']);
  });

  it('ties with idle in rank — a week-old abandoned process sorts by recency, not above today', () => {
    const old = meta('old', { updatedAt: NOW - 7 * 24 * 60 * MIN, quietSince: NOW - 7 * 24 * 60 * MIN });
    const today = meta('today', { updatedAt: NOW - 60 * MIN });
    const shown = [old, today]
      .map((s) => ({ s, st: sessionStatus(s, { today: NOW }, NOW) }))
      .sort((a, b) => RANK[a.st] - RANK[b.st] || b.s.updatedAt - a.s.updatedAt);
    expect(shown.map((r) => r.s.id)).toEqual(['today', 'old']);
  });

  it('floors the silence so it never overstates', () => {
    expect(fmtQuiet(34.9 * MIN)).toBe('34m');
    expect(fmtQuiet(2.5 * 60 * MIN)).toBe('2h');
    expect(fmtQuiet(3.9 * 24 * 60 * MIN)).toBe('3d');
  });
});

describe('sessionStatus', () => {
  it('a session you just watched finish is idle, not "running" — no freshness fallback', () => {
    // wrote 10s ago, probe says not live, and the user saw the tail (seen >
    // updatedAt): the old <60s-fresh ⇒ busy rule made this lie for a minute
    const s = meta('a', { updatedAt: NOW - 10_000 });
    expect(sessionStatus(s, { a: NOW - 5_000 }, NOW)).toBe('idle');
    // the same fresh write unseen is still "just finished"
    expect(sessionStatus(s, {}, NOW)).toBe('done');
  });
});
