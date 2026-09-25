import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { Ingester } from '../src/daemon/ingest.js';
import { buildServer, SseHub } from '../src/daemon/server.js';
import { Store } from '../src/store/store.js';

const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHILD = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee';
const GUARDIAN = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';
const GRANDCHILD = '33333333-bbbb-cccc-dddd-eeeeeeeeeeee';
const entry = (type: string, payload: unknown) => JSON.stringify({
  timestamp: '2026-09-13T22:10:11Z', type, payload,
}) + '\n';
const prompt = (id: string) => entry('event_msg', {
  type: 'item_completed', item: { type: 'UserMessage', id: `${id}-u`, content: 'Review this change' },
});
const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-codex-subagents-'));
  homes.push(home);
  const root = path.join(home, 'sessions');
  const adapter = codexAdapter(root);
  const store = new Store(path.join(home, 'sight.db')); stores.push(store);
  const ingester = new Ingester(store, [adapter], () => {}, () => false);
  const write = (id: string, meta: Record<string, unknown>) => {
    const file = path.join(root, '2026/09/13', `rollout-2026-09-13T22-10-11-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry('session_meta', { id, cwd: '/repo', ...meta }) + prompt(id));
    return file;
  };
  return { home, adapter, store, ingester, write };
}

describe('Codex subagent grouping', () => {
  it('lists only the parent and exposes worker and guardian transcripts inside it, even child-first', async () => {
    const { adapter, store, ingester, write } = setup();
    const child = write(CHILD, { parent_thread_id: PARENT, forked_from_id: PARENT,
      agent_nickname: 'Meitner', agent_path: '/root/standards_review',
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } });
    // Context forks can append a parent session_meta with no relationship.
    fs.appendFileSync(child, entry('session_meta', { id: PARENT, source: 'vscode', cwd: '/repo' }));
    fs.appendFileSync(child, entry('event_msg', { type: 'task_complete' }));
    ingester.ingestFile(adapter, child);
    ingester.ingestFile(adapter, write(GUARDIAN, { parent_thread_id: PARENT,
      source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' }));
    ingester.ingestFile(adapter, write(PARENT, { source: 'vscode' }));
    expect(store.listSessions().map(s => s.id)).toEqual([PARENT]);
    expect(store.listChildren(PARENT).map(s => s.id)).toEqual([CHILD, GUARDIAN]);
    expect(store.getSession(CHILD)).toMatchObject({ parentId: PARENT, title: 'Meitner · standards_review' });
    expect(store.getSession(GUARDIAN)?.title).toBe('Guardian review');
    const app = buildServer(store, new SseHub(), () => new Map([
      [PARENT, { state: 'alive', since: 0 }], [CHILD, { state: 'alive', since: 0 }],
    ]));
    try {
      const view = await app.inject({ method: 'GET', url: `/api/sessions/${PARENT}` });
      expect(view.json().children.map((s: { id: string }) => s.id)).toEqual([CHILD, GUARDIAN]);
      const childView = await app.inject({ method: 'GET', url: `/api/sessions/${CHILD}` });
      expect(childView.json().session.parentId).toBe(PARENT);
      expect(childView.json().session.live).toBeUndefined();
      expect(childView.json().events).toHaveLength(1);
    } finally { await app.close(); await ingester.stop(); }
  });

  it('uses nested spawn metadata and keeps a user fork independent', () => {
    const { adapter, store, ingester, write } = setup();
    ingester.ingestFile(adapter, write(PARENT, { source: 'vscode', forked_from_id: CHILD }));
    ingester.ingestFile(adapter, write(CHILD, { source: { subagent: { thread_spawn: {
      parent_thread_id: PARENT, agent_path: '/root/reviewer', agent_nickname: 'Ada',
    } } } }));
    expect(store.listSessions().map(s => s.id)).toEqual([PARENT]);
    expect(store.getSession(CHILD)).toMatchObject({ parentId: PARENT, title: 'Ada · reviewer' });
  });

  it.each([null, [], 'unexpected', { subagent: null }, { subagent: { thread_spawn: [] } }])(
    'keeps unfamiliar source metadata visible and rejects malformed/self parentage: %j', source => {
      const { adapter, store, ingester, write } = setup();
      ingester.ingestFile(adapter, write(PARENT, { source, parent_thread_id: 'broken' }));
      ingester.ingestFile(adapter, write(CHILD, { source, parent_thread_id: CHILD }));
      expect(store.listSessions()).toHaveLength(2);
    },
  );

  it('removes nested descendants and their chats when the parent transcript disappears', () => {
    const { adapter, store, ingester, write } = setup();
    const parent = write(PARENT, { source: 'vscode' });
    ingester.ingestFile(adapter, parent);
    ingester.ingestFile(adapter, write(CHILD, { parent_thread_id: PARENT }));
    ingester.ingestFile(adapter, write(GRANDCHILD, { parent_thread_id: CHILD }));
    const chat = store.createSideChat(GRANDCHILD, `${GRANDCHILD}-u`, 'Review');
    fs.unlinkSync(parent);
    ingester.ingestFile(adapter, parent);
    expect(store.getSession(CHILD)).toBeNull();
    expect(store.getSession(GRANDCHILD)).toBeNull();
    expect(store.getSideChat(chat.id)).toBeNull();
  });

  it('backfills already checkpointed Codex sessions after upgrade without losing anchors or chats', async () => {
    const { home, adapter, store, ingester, write } = setup();
    const parent = write(PARENT, { source: 'vscode' });
    const child = write(CHILD, { parent_thread_id: PARENT, agent_nickname: 'Ada' });
    ingester.ingestFile(adapter, parent);
    ingester.ingestFile(adapter, child);
    const original = store.getEvents(CHILD);
    const chat = store.createSideChat(CHILD, `${CHILD}-u`, 'Review');
    store.db.prepare('UPDATE sessions SET parent_id = NULL WHERE id = ?').run(CHILD);
    store.db.pragma('user_version = 6');   // a pre-v7 database: derived rows rebuild on open, side chats stay
    await ingester.stop(); store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(path.join(home, 'sight.db')); stores.push(reopened);
    const restarted = new Ingester(reopened, [adapter], () => {}, () => false);
    restarted.ingestFile(adapter, parent); restarted.ingestFile(adapter, child);
    expect(reopened.listSessions().map(s => s.id)).toEqual([PARENT]);
    expect(reopened.getEvents(CHILD)).toEqual(original);
    expect(reopened.getSideChat(chat.id)?.anchorMessageId).toBe(`${CHILD}-u`);
    await restarted.stop();
  });
});
