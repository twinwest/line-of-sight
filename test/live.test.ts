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
  return (res.json() as { id: string; live?: boolean; waiting?: boolean; busySince?: number; quietSince?: number }[])[0]!;
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
    // …but not plain idle either: the pid is verified, only the writes stopped —
    // the row says when the observer last heard anything (unverifiable)
    expect(row.quietSince).toBeCloseTo(Date.now() - 3 * 60 * MIN, -3);
  });

  it('fresh busy carries no quiet stamp', async () => {
    const app = serverWith(MIN, new Map([['s1', { state: 'busy', since: Date.now() - MIN }]]));
    expect((await sessionRow(app)).quietSince).toBeUndefined();
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
    const row = await sessionRow(app);
    expect(row.live).toBeUndefined();
    expect(row.quietSince).toBeUndefined();   // the turn ended: idle, not unverifiable
  });

  it('turn open → busy survives a long silent item, timer from turn start', async () => {
    const started = Date.now() - 5 * MIN;
    const app = serverWith(5 * MIN, bare, { turnOpen: true, turnStartedAt: started });
    expect(await sessionRow(app)).toMatchObject({ live: true, busySince: started });
  });

  it('no turn info (agent without markers, pre-marker rows) → staleness rule as before', async () => {
    expect((await sessionRow(serverWith(0.5 * MIN, bare))).live).toBe(true);
    const stale = await sessionRow(serverWith(60 * MIN, bare));
    expect(stale.live).toBeUndefined();
    expect(stale.quietSince).toBeCloseTo(Date.now() - 60 * MIN, -3);   // flock held, nothing moving
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

describe('POST /api/sessions/:id/reingest', () => {
  it('resets the session and its children and re-feeds their files', async () => {
    const store = new Store(':memory:');
    const ts = Date.now();
    store.upsertSession({ id: 'p', adapter: 'claude-code', filePath: '/p.jsonl', projectDir: '/p',
      title: 'parent', startedAt: ts, updatedAt: ts, messageCount: 0 });
    store.upsertSession({ id: 'c', adapter: 'claude-code', filePath: '/p/subagents/agent-c.jsonl', projectDir: '/p',
      title: 'child', startedAt: ts, updatedAt: ts, messageCount: 0, parentId: 'p' });
    store.appendEvents('p', [{ kind: 'message', id: 'm1', role: 'user', ts, blocks: [{ type: 'text', markdown: 'hi' }] }], 100);
    const fed: string[] = [];
    const app = buildServer(store, new SseHub(), () => new Map(), (f) => fed.push(f));
    const res = await app.inject({ method: 'POST', url: '/api/sessions/p/reingest' });
    expect(res.json()).toEqual({ ok: true, sessions: 2 });
    expect(fed).toEqual(['/p.jsonl', '/p/subagents/agent-c.jsonl']);
    expect(store.getEvents('p')).toHaveLength(0);
    expect(store.getSessionByPath('/p.jsonl')).toMatchObject({ byteOffset: 0 });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/nope/reingest' })).statusCode).toBe(404);
  });
});

describe('subagent liveness follows the parent, bounded', () => {
  function withChild(quietFor: number, endedAt: number | null) {
    const store = new Store(':memory:');
    const ts = Date.now() - quietFor;
    store.upsertSession({ id: 'p', adapter: 'claude-code', filePath: '/p.jsonl', projectDir: '/p',
      title: 'parent', startedAt: ts, updatedAt: ts, messageCount: 0 });
    store.upsertSession({ id: 'c', adapter: 'claude-code', filePath: '/p/subagents/agent-c.jsonl', projectDir: '/p',
      title: 'child', startedAt: ts, updatedAt: ts, messageCount: 0, parentId: 'p' });
    if (endedAt) store.endChildren('p', 'toolu_x', endedAt);  // no tool_use_id on the row: exercises the kv path only
    return buildServer(store, new SseHub(), () => new Map([['p', { state: 'busy', since: Date.now() }]]));
  }
  const child = async (app: ReturnType<typeof buildServer>) =>
    ((await app.inject({ method: 'GET', url: '/api/sessions/p' })).json() as { children: { live?: boolean; quietSince?: number }[] }).children[0]!;

  it('quiet for minutes but parent live and no end recorded: still running', async () => {
    expect((await child(withChild(5 * MIN, null))).live).toBe(true);
  });
  it('quiet past the cap: not running, even with no end recorded', async () => {
    const row = await child(withChild(20 * MIN, null));
    expect(row.live).toBeUndefined();
    expect(row.quietSince).toBeUndefined();   // a child has no process of its own to be unverifiable
  });
});

describe('CSP', () => {
  it('every response forbids remote images (exfiltration channel)', async () => {
    const app = serverWith(0, new Map());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toBe("img-src 'self' data:");
  });
});
