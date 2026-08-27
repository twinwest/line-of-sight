import { describe, expect, it } from 'vitest';
import { buildServer, SseHub } from '../src/daemon/server.js';
import { Store } from '../src/store/store.js';

type LiveMap = Map<string, { state: 'busy' | 'waiting'; since: number }>;

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

describe('turn markers corroborate process-alive-only claims (codex flock)', () => {
  const bare: LiveMap = new Map([['s1', { state: 'busy', since: 0 }]]);

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
