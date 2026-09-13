import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Responder, ResponderRequest } from '../src/responders/types.js';

// the engine is resolved inside the route; swap it for one that records the request
let seen: ResponderRequest | null = null;
const fake: Responder = {
  id: 'fake' as Responder['id'],
  available: async () => true,
  answer: async (req) => { seen = req; return 'ok'; },
};
vi.mock('../src/responders/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/responders/index.js')>()),
  resolveResponder: async () => fake,
}));

const { claudeCodeAdapter } = await import('../src/adapters/claudeCode.js');
const { Ingester } = await import('../src/daemon/ingest.js');
const { buildServer, SseHub } = await import('../src/daemon/server.js');
const { Store, renderExcerpt } = await import('../src/store/store.js');

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TS = '2026-09-12T00:00:00.000Z';

function line(uuid: string, parentUuid: string | null, content: unknown,
    role: 'user' | 'assistant' = 'user'): string {
  return JSON.stringify({
    type: role, uuid, parentUuid, timestamp: TS,
    cwd: '/tmp/proj', message: { role, content },
  }) + '\n';
}
const HEAD = line('u1', null, 'first question') + line('a1', 'u1', 'the answer', 'assistant');

describe('side chat snapshot (#15)', () => {
  let root: string;
  let file: string;
  let store: InstanceType<typeof Store>;
  const adapter = () => claudeCodeAdapter(root);
  const ingest = (ingester: InstanceType<typeof Ingester>, text: string) => {
    fs.writeFileSync(file, text);
    ingester.ingestFile(adapter(), file);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-keep-'));
    fs.mkdirSync(path.join(root, '-tmp-proj'));
    file = path.join(root, '-tmp-proj', `${SESSION}.jsonl`);
    store = new Store(':memory:');
    seen = null;
  });
  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is taken when the chat is created and does not move as the session grows', () => {
    const ingester = new Ingester(store, [adapter()]);
    ingest(ingester, HEAD);
    const chat = store.createSideChat(SESSION, 'a1', 'the answer');
    ingest(ingester, HEAD + line('u2', 'a1', 'a later message'));
    const snap = store.getSideChatSnapshot(chat.id)!;
    expect(snap.v).toBe(1);
    expect(snap.session).toEqual({ adapter: 'claude-code', projectDir: '/tmp/proj', title: 'first question', filePath: file });
    expect(snap.rows.map((r) => r.id)).toEqual(['u1', 'a1']);
    expect(snap.rows[1]).toMatchObject({ role: 'assistant', anchor: true, abandoned: false, text: 'the answer' });
    // facts in, label out: the rendered form equals what askContext produced at that moment
    expect(renderExcerpt(snap.rows)).toContain(`[assistant, ${TS}, contains the ANCHOR]\nthe answer`);
    expect(renderExcerpt(snap.rows)).not.toContain('a later message');
    expect(store.askContext(SESSION, 'a1').excerpt).toContain('a later message');   // live view moved on
  });

  it('a chat from before the column is filled in on first use, while the transcript is still there', () => {
    const ingester = new Ingester(store, [adapter()]);
    ingest(ingester, HEAD);
    const chat = store.createSideChat(SESSION, 'a1', 'the answer');
    store.db.exec('UPDATE side_chats SET excerpt_json = NULL');           // what a pre-#15 row looks like
    expect(store.getSideChatSnapshot(chat.id)!.rows.map((r) => r.id)).toEqual(['u1', 'a1']);
    expect(store.db.prepare('SELECT excerpt_json FROM side_chats').pluck().get()).not.toBeNull();
    // no session, no anchor: nothing to snapshot, nothing stored
    const ghost = store.createSideChat('ghost', 'm1', 'left behind');
    expect(store.getSideChatSnapshot(ghost.id)).toBeNull();
  });

  it('an existing side_chats table gains the column on open', () => {
    const dbPath = path.join(root, 'old.db');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE side_chats (
      id TEXT PRIMARY KEY, session_id TEXT, anchor_message_id TEXT,
      anchor_text TEXT, created_at INTEGER, turns_json TEXT)`);
    raw.exec(`INSERT INTO side_chats VALUES ('c1', 's1', 'm1', 'anchor', 1, '[]')`);
    raw.close();
    const upgraded = new Store(dbPath);
    const cols = (upgraded.db.pragma('table_info(side_chats)') as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('excerpt_json');
    expect(upgraded.getSideChat('c1')).toMatchObject({ anchorText: 'anchor', turns: [] });
    upgraded.close();
  });

  it('an ask is answered against the snapshot, not the live session', async () => {
    const ingester = new Ingester(store, [adapter()]);
    ingest(ingester, HEAD);
    const chat = store.createSideChat(SESSION, 'a1', 'the answer');
    ingest(ingester, HEAD + line('u2', 'a1', 'a later message'));
    const app = buildServer(store, new SseHub());
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${url}/api/side-chats/${chat.id}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'why?' }),
      });
      await res.text();                                   // drain the stream to completion
      expect(seen!.excerpt).toContain('the answer');
      expect(seen!.excerpt).not.toContain('a later message');
      expect(seen!.branches).toBeNull();
    } finally {
      await app.close();
    }
  });
});
