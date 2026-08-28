import { describe, expect, it } from 'vitest';
import { buildServer, SseHub } from '../src/daemon/server.js';
import type { LiveSession } from '../src/shared/types.js';
import { Store } from '../src/store/store.js';

type LiveMap = Map<string, LiveSession>;

const MIN = 60_000;

/** One session whose transcript last moved `quietFor` ms ago; `turn` applies
 *  a turn-marker patch (codex task_started/task_complete carriers). */
function serverWith(quietFor: number, live: LiveMap,
    turn?: { turnOpen: boolean; turnStartedAt?: number }) {
  const store = new Store(':memory:');
  const ts = Date.now() - quietFor;
  store.upsertSession({
    id: 's1', adapter: 'claude-code', filePath: '/f1', projectDir: '/p',
    title: 'a session', startedAt: ts, updatedAt: ts, messageCount: 0,
  });
  store.appendEvents('s1', [
    { kind: 'message', id: 'm1', role: 'user', ts, blocks: [{ type: 'text', markdown: 'hi' }] },
    ...(turn ? [{ kind: 'meta' as const, id: 't1', ts, label: 'task', raw: null, sessionPatch: turn }] : []),
  ], 100);
  return buildServer(store, new SseHub(), () => live);
}

async function sessionRow(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  return (res.json() as { id: string; live?: boolean; waiting?: boolean; busySince?: number }[])[0]!;
}

describe('live flag: a busy claim needs corroboration', () => {
  it('busy with a fresh status stamp is live', async () => {
    const app = serverWith(30 * MIN,
      new Map([['s1', { state: 'busy', since: Date.now() - MIN }]]));
    expect(await sessionRow(app)).toMatchObject({ live: true, waiting: false });
  });

  it('a long quiet turn stays live while the transcript keeps moving', async () => {
    // status stamp is old (it is written once, at turn start) but the
    // transcript moved a minute ago — a real, long-running turn
    const app = serverWith(MIN,
      new Map([['s1', { state: 'busy', since: Date.now() - 60 * MIN }]]));
    expect(await sessionRow(app)).toMatchObject({ live: true });
  });

  it('busy with both signals stale is not live — the forever-green bug', async () => {
    const app = serverWith(3 * 60 * MIN,
      new Map([['s1', { state: 'busy', since: Date.now() - 3 * 60 * MIN }]]));
    const row = await sessionRow(app);
    expect(row.live).toBeUndefined();
    expect(row.id).toBe('s1');
  });

  it('waiting is exempt — parked on the user is open-ended', async () => {
    const app = serverWith(3 * 60 * MIN,
      new Map([['s1', { state: 'waiting', since: Date.now() - 3 * 60 * MIN }]]));
    expect(await sessionRow(app)).toMatchObject({ live: true, waiting: true });
  });
});

describe('turn markers corroborate alive claims (codex flock)', () => {
  const bare: LiveMap = new Map([['s1', { state: 'alive', since: 0 }]]);

  it('turn ended → an open-but-idle TUI greys immediately, fresh writes or not', async () => {
    const app = serverWith(0.5 * MIN, bare, { turnOpen: false });
    expect((await sessionRow(app)).live).toBeUndefined();
  });

  it('turn open → busy survives a long silent item, timer from turn start', async () => {
    const started = Date.now() - 5 * MIN;
    const app = serverWith(5 * MIN, bare, { turnOpen: true, turnStartedAt: started });
    expect(await sessionRow(app)).toMatchObject({ live: true, busySince: started });
  });

  it('no turn info (agent without markers, pre-marker rows) → staleness rule as before', async () => {
    expect((await sessionRow(serverWith(0.5 * MIN, bare))).live).toBe(true);
    expect((await sessionRow(serverWith(60 * MIN, bare))).live).toBeUndefined();
  });
});

describe('alive + blocking tool parked at the tail → list-level waiting', () => {
  /** A codex session mid-turn whose tail holds a request_user_input,
   *  answered or not, last written `quietFor` ms ago. */
  function codexServer(quietFor: number, answered: boolean) {
    const store = new Store(':memory:');
    const ts = Date.now() - quietFor;
    store.upsertSession({
      id: 'c1', adapter: 'codex', filePath: '/f2', projectDir: '/p',
      title: 'codex session', startedAt: ts, updatedAt: ts, messageCount: 0,
    });
    store.appendEvents('c1', [
      { kind: 'meta', id: 't0', ts, label: 'task_started', raw: null,
        sessionPatch: { turnOpen: true, turnStartedAt: ts } },
      { kind: 'message', id: 'q1', role: 'assistant', ts,
        blocks: [{ type: 'tool_use', id: 'call_1', toolName: 'request_user_input', summary: '', input: {} }] },
      ...(answered ? [{ kind: 'message' as const, id: 'a1', role: 'user' as const, ts,
        blocks: [{ type: 'tool_result' as const, toolUseId: 'call_1', summary: '', output: '{}', isError: false }] }] : []),
    ], 100);
    const live: LiveMap = new Map([['c1', { state: 'alive', since: 0 }]]);
    return buildServer(store, new SseHub(), () => live);
  }

  it('unanswered → waiting, and exempt from staleness like claude waiting', async () => {
    expect(await sessionRow(codexServer(3 * 60 * MIN, false)))
      .toMatchObject({ live: true, waiting: true });
  });

  it('answered → busy, not waiting', async () => {
    expect(await sessionRow(codexServer(MIN, true)))
      .toMatchObject({ live: true, waiting: false });
  });
});
