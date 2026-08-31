import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/shared/types.js';
import { otherSessions, sessionStatus } from '../web/src/status.js';

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
