import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { Ingester } from '../src/daemon/ingest.js';
import { Store } from '../src/store/store.js';
import type { ResponderRequest } from '../src/responders/types.js';

const requests: ResponderRequest[] = [];
let beforeResolve: (() => void | Promise<void>) | undefined;
vi.mock('../src/responders/index.js', async orig => ({
  ...(await orig<typeof import('../src/responders/index.js')>()),
  resolveResponder: async () => {
    await beforeResolve?.();
    return {
      id: 'codex-cli',
      answer: async (request: ResponderRequest) => {
        requests.push(request);
        return 'grounded answer';
      },
    };
  },
}));

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NAME = `rollout-2026-09-08T09-32-28-${ID}.jsonl`;
const entry = (type: string, payload: unknown) => JSON.stringify({
  timestamp: '2026-09-08T16:32:28Z', type, payload,
}) + '\n';
const prompt = (id: string | undefined, text: string) => entry('event_msg', {
  type: 'item_completed', item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
});

describe('Codex archive lifecycle', () => {
  /** Every fact about a session leaves with it — no kv row may name its id. */
  const kvRowsMentioning = (id: string) =>
    store.db.prepare('SELECT key FROM kv WHERE key LIKE ?').all(`%${id}%`);
  let home: string;
  let active: string;
  let archived: string;
  let store: Store;
  let ingester: Ingester;
  let adapter: ReturnType<typeof codexAdapter>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-codex-archive-'));
    active = path.join(home, 'sessions/2026/09/08', NAME);
    archived = path.join(home, 'archived_sessions', NAME);
    fs.mkdirSync(path.dirname(active), { recursive: true });
    fs.mkdirSync(path.dirname(archived));
    fs.writeFileSync(active, entry('session_meta', { id: ID, cwd: '/repo' }) + prompt('u1', 'archive evidence'));
    adapter = codexAdapter(path.join(home, 'sessions'));
    store = new Store(':memory:');
    ingester = new Ingester(store, [adapter], () => {}, () => false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    requests.length = 0;
    beforeResolve = undefined;
    await ingester.stop();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('honors keepSideChats after the final Codex source disappears, including startup prune', async () => {
    ingester = new Ingester(store, [adapter], () => {}, () => true);
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    const snapshot = store.getSideChatSnapshot(chat.id);
    fs.renameSync(active, archived);
    ingester.ingestFile(adapter, active);
    expect(store.getSideChatSnapshot(chat.id)).toEqual(snapshot);
    fs.unlinkSync(archived);
    ingester.start();
    await ingester.stop();   // the start-up prune runs after the scan's queued work
    expect(store.getSession(ID)).toBeNull();
    expect(kvRowsMentioning(ID)).toEqual([]);
    expect(store.getSideChat(chat.id)).not.toBeNull();
    expect(store.getSideChatSnapshot(chat.id)).toEqual(snapshot);
    store.prune(false);
    expect(store.getSideChat(chat.id)).toBeNull();
  });

  it('discovers an archived-only rollout with its title, dialog search, and Ask context', () => {
    fs.writeFileSync(active, fs.readFileSync(path.join(__dirname, 'fixtures/codex/archived.jsonl')));
    fs.renameSync(active, archived);
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({
      id: ID, thread_name: 'Archived title', updated_at: '2026-09-08T16:32:28Z',
    }) + '\n');
    ingester.start();
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession(ID)).toMatchObject({ filePath: archived, title: 'Archived title', projectDir: '/repo' });
    expect(store.search('evidence')).toHaveLength(1);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1']);
    expect(store.askContext(ID, 'u1').excerpt).toContain('archive evidence');
  });

  it.each(['unlink-first', 'add-first', 'offline'])(
    'preserves the session, anchor and side-chat turns during %s archive and unarchive', async order => {
      ingester.ingestFile(adapter, active);
      const chat = store.createSideChat(ID, 'u1', 'archive evidence');
      store.appendSideChatTurn(chat.id, { role: 'user', text: 'Why?', ts: 1 });
      const original = store.getEvents(ID);
      const move = async (from: string, to: string) => {
        if (order === 'offline') await ingester.stop();
        fs.renameSync(from, to);
        if (order === 'offline') {
          ingester = new Ingester(store, [adapter], () => {}, () => false);
          ingester.start();
        } else {
          for (const p of order === 'unlink-first' ? [from, to] : [to, from]) ingester.ingestFile(adapter, p);
        }
        expect(store.getSession(ID)).toMatchObject({ filePath: to, messageCount: 1, title: 'archive evidence' });
        expect(store.getEvents(ID)).toEqual(original);
        expect(store.getSideChat(chat.id)).toMatchObject({ anchorMessageId: 'u1', turns: [{ text: 'Why?' }] });
        expect(store.getSessionByPath(to)?.byteOffset).toBe(fs.statSync(to).size);
      };
      await move(active, archived);
      await move(archived, active);
      fs.appendFileSync(active, prompt('u2', 'after unarchive'));
      ingester.ingestFile(adapter, active);
      ingester.ingestFile(adapter, archived);
      expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1', 'u2']);
    },
  );

  it('watches a first archive directory created after startup and restores its indexed title', async () => {
    fs.rmdirSync(path.dirname(archived));
    ingester.start();
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({
      id: ID, thread_name: 'Late archive title', updated_at: '2026-09-08T16:32:28Z',
    }) + '\n');
    // Also exercise the scan-to-subscription gap: no artificial ready delay.
    fs.mkdirSync(path.dirname(archived));
    fs.renameSync(active, archived);
    await expect.poll(() => store.getSession(ID)?.filePath, { timeout: 4000 }).toBe(archived);
    expect(store.getSideChat(chat.id)).not.toBeNull();
    // The index may have been created before its own watcher was ready;
    // archive discovery must heal the name without requiring another write.
    await expect.poll(() => store.getSession(ID)?.title, { timeout: 4000 }).toBe('Late archive title');
    const second = path.join(path.dirname(archived), NAME.replace(ID, '11111111-bbbb-cccc-dddd-eeeeeeeeeeee'));
    fs.writeFileSync(second, prompt('u3', 'brand new archived session'));
    await expect.poll(() => store.listSessions().length, { timeout: 4000 }).toBe(2);
  });

  it('keeps one bound source for duplicate UUIDs, then reparses a surviving copy without losing chats', () => {
    const warnings: string[] = [];
    ingester = new Ingester(store, [adapter], message => warnings.push(message), () => false);
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    const alternate = archived.replace('09-32-28', '09-32-29');
    fs.writeFileSync(alternate, prompt('u1', 'archive evidence') + prompt('u2', 'copy only'));
    ingester.ingestFile(adapter, alternate);
    ingester.ingestFile(adapter, alternate);
    expect(store.getSession(ID)?.filePath).toBe(active);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1']);
    expect(warnings.some(w => w.includes('duplicate transcript'))).toBe(true);
    fs.unlinkSync(active);
    ingester.ingestFile(adapter, active);
    expect(store.getSession(ID)?.filePath).toBe(alternate);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1', 'u2']);
    expect(store.getSideChat(chat.id)?.anchorMessageId).toBe('u1');
    fs.unlinkSync(alternate);
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({
      id: ID, thread_name: 'Stale title', updated_at: '2026-09-08T16:32:28Z',
    }) + '\n');
    ingester.ingestFile(adapter, alternate);
    ingester.ingestFile(adapter, path.join(home, 'session_index.jsonl'));
    expect(store.getSession(ID)).toBeNull();
    expect(store.getSideChat(chat.id)).toBeNull();
    expect(store.search('evidence')).toEqual([]);
    expect(kvRowsMentioning(ID)).toEqual([]);
  });

  it('keeps fallback anchors when a copied source needs a from-zero reparse', () => {
    const content = prompt('u1', 'archive evidence') + prompt(undefined, 'fallback prompt');
    fs.writeFileSync(active, content);
    ingester.ingestFile(adapter, active);
    const fallbackId = store.getEvents(ID)[1]!.id;
    const chat = store.createSideChat(ID, fallbackId, 'fallback prompt');
    fs.copyFileSync(active, archived);
    fs.unlinkSync(active);
    ingester.ingestFile(adapter, active);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1', fallbackId]);
    expect(store.getSideChat(chat.id)?.anchorMessageId).toBe(fallbackId);
    expect(store.getSession(ID)?.messageCount).toBe(2);
  });


  it('follows an offline rename across a daemon/database restart, rows and chats intact', async () => {
    store.close();
    const db = path.join(home, 'sight.db');
    store = new Store(db);
    ingester = new Ingester(store, [adapter], () => {}, () => false);
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    const original = store.getEvents(ID);
    await ingester.stop();
    store.close();
    fs.renameSync(active, archived);
    store = new Store(db);
    ingester = new Ingester(store, [adapter], () => {}, () => false);
    ingester.start();
    expect(store.getSession(ID)?.filePath).toBe(archived);
    expect(store.getEvents(ID)).toEqual(original);
    expect(store.getSideChat(chat.id)).not.toBeNull();
  });

  it('passes the relocated transcript and preserved context to its Codex responder through Ask', async () => {
    const { buildServer, SseHub } = await import('../src/daemon/server.js');
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    fs.renameSync(active, archived);
    ingester.reingest(active);
    await ingester.stop(); // drain the same queue used by explicit reingestion
    const app = buildServer(store, new SseHub(), undefined, file => ingester.reingest(file));
    try {
      const view = await app.inject({ method: 'GET', url: `/api/sessions/${ID}?m=u1` });
      expect(view.json().session.filePath).toBe(archived);
      const answer = await app.inject({ method: 'POST', url: `/api/side-chats/${chat.id}/ask`,
        payload: { question: 'Why?' } });
      expect(answer.statusCode).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ sessionFilePath: archived, anchorText: 'archive evidence' });
      expect(requests[0]!.excerpt).toContain('archive evidence');
      expect(store.getSideChat(chat.id)?.turns.map(t => t.text)).toEqual(['Why?', 'grounded answer']);
      beforeResolve = () => { fs.renameSync(archived, active); };
      const next = await app.inject({ method: 'POST', url: `/api/side-chats/${chat.id}/ask`,
        payload: { question: 'And now?' } });
      expect(next.statusCode).toBe(200);
      expect(requests[1]?.sessionFilePath).toBe(active);
    } finally {
      await app.close();
    }
  });

  it('does not mistake an unreadable replacement directory for transcript deletion', () => {
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    fs.renameSync(active, archived);
    const read = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, options: unknown) => {
      if (p === path.dirname(archived)) throw Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' });
      return read(p, options as never);
    }) as typeof fs.readdirSync);
    ingester.ingestFile(adapter, active);
    expect(store.getSession(ID)).not.toBeNull();
    expect(store.getSideChat(chat.id)).not.toBeNull();
    expect(() => ingester.start()).not.toThrow();
    expect(store.getSideChat(chat.id)).not.toBeNull();
  });

  it('keeps Claude transcript deletion and child/side-chat cleanup unchanged in a mixed daemon', () => {
    const claudeRoot = path.join(home, 'claude-projects');
    const claudeId = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const parent = path.join(claudeRoot, '-repo', `${claudeId}.jsonl`);
    const child = path.join(claudeRoot, '-repo', claudeId, 'subagents/agent-x.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    const claudeLine = (uuid: string) => JSON.stringify({ type: 'user', uuid,
      timestamp: '2026-09-08T16:32:28Z', cwd: '/repo', message: { content: 'Claude prompt' } }) + '\n';
    fs.writeFileSync(parent, claudeLine('cu1'));
    fs.writeFileSync(child, claudeLine('cu2'));
    const claude = claudeCodeAdapter(claudeRoot);
    ingester = new Ingester(store, [claude, adapter], () => {}, () => false);
    ingester.start();
    const children = store.listChildren(claudeId);
    expect(children).toHaveLength(1);
    const parentChat = store.createSideChat(claudeId, 'cu1', 'Claude prompt');
    const childChat = store.createSideChat(children[0]!.id, 'cu2', 'Claude prompt');
    fs.unlinkSync(parent);
    ingester.ingestFile(claude, parent);
    expect(store.getSession(claudeId)).toBeNull();
    expect(store.getSession(children[0]!.id)).toBeNull();
    expect(store.getSideChat(parentChat.id)).toBeNull();
    expect(store.getSideChat(childChat.id)).toBeNull();
    expect(store.getSession(ID)).not.toBeNull();
  });

  it('selects the same initial active source regardless of which duplicate is notified first', async () => {
    const later = active.replace('09-32-28', '09-32-29');
    fs.writeFileSync(later, prompt('u2', 'other copy'));
    ingester.ingestFile(adapter, later);
    expect(store.getSession(ID)?.filePath).toBe(active);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1']);
    await ingester.stop();
    store.close();
    store = new Store(':memory:');
    ingester = new Ingester(store, [codexAdapter(path.join(home, 'sessions'))], () => {}, () => false);
    ingester.ingestFile(codexAdapter(path.join(home, 'sessions')), active);
    expect(store.getSession(ID)?.filePath).toBe(active);
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1']);
  });

  it('re-resolves instead of deleting when a bound source moves after resolution', async () => {
    ingester.ingestFile(adapter, active);
    const chat = store.createSideChat(ID, 'u1', 'archive evidence');
    const exists = fs.existsSync;
    let checks = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation(p => {
      if (p === active && ++checks === 2) fs.renameSync(active, archived);
      return exists(p);
    });
    await ingester.reingest(active);
    expect(store.getSession(ID)?.filePath).toBe(archived);
    expect(store.getSideChat(chat.id)).not.toBeNull();
    expect(store.getEvents(ID).map(e => e.id)).toEqual(['u1']);
  });
});
