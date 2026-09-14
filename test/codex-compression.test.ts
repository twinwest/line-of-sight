import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { codexFingerprint, readCompressedCodex } from '../src/adapters/codexRollout.js';
import { Ingester } from '../src/daemon/ingest.js';
import { Store } from '../src/store/store.js';
import { codexPrompt } from '../src/responders/codexCli.js';
import { composePrompt } from '../src/responders/prompt.js';
import { buildServer, SseHub } from '../src/daemon/server.js';
import { codexCliResponder } from '../src/responders/codexCli.js';
import type { ResponderRequest } from '../src/responders/types.js';

const zstd = await import('zstd-napi').catch(() => null);
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const name = `rollout-2026-09-13T00-00-00-${ID}.jsonl`;
const entry = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-09-13T00:00:00Z', type, payload }) + '\n';
const user = (text: string) => entry('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const raw = entry('session_meta', { id: ID, cwd: '/synthetic/repo' }) + user('Unicode 归档 evidence') +
  user('Second evidence') + entry('event_msg', { type: 'task_complete' });
const compress = (text: string) => new zstd!.Compressor({ compressionLevel: 3, checksumFlag: true }).compress(Buffer.from(text));

describe.skipIf(!zstd)('compressed Codex lifecycle', () => {
  let home: string, plain: string, packed: string, archive: string;
  let store: Store, ingester: Ingester, adapter: ReturnType<typeof codexAdapter>;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-codex-zst-'));
    plain = path.join(home, 'sessions/2026/09/13', name);
    packed = plain + '.zst';
    archive = path.join(home, 'archived_sessions', name + '.zst');
    fs.mkdirSync(path.dirname(plain), { recursive: true }); fs.mkdirSync(path.dirname(archive));
    fs.writeFileSync(plain, raw);
    adapter = codexAdapter(path.join(home, 'sessions'));
    store = new Store(':memory:');
    ingester = new Ingester(store, [adapter], () => {}, () => false);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await ingester.stop(); store.close(); fs.rmSync(home, { recursive: true, force: true });
  });

  it('groups a compressed child and backfills its relationship on upgrade without losing chats', async () => {
    const parent = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const childRaw = entry('session_meta', { id: ID, cwd: '/synthetic/repo',
      parent_thread_id: parent, agent_nickname: 'Ada' }) + user('Child evidence');
    fs.writeFileSync(archive, compress(childRaw)); fs.unlinkSync(plain);
    await ingester.reingest(archive);
    expect(store.listSessions()).toHaveLength(0);
    expect(store.listChildren(parent)[0]).toMatchObject({ id: ID, title: 'Ada' });
    const events = store.getEvents(ID);
    const chat = store.createSideChat(ID, events[0]!.id, 'Child evidence');
    store.db.prepare('UPDATE sessions SET parent_id = NULL WHERE id = ?').run(ID);
    // Simulate the upgrade invalidation of an already decoded rollout.
    store.db.prepare('DELETE FROM kv WHERE key = ?').run(`codex-fingerprint:${ID}`);
    await ingester.reingest(archive);
    expect(store.getSession(ID)?.parentId).toBe(parent);
    expect(store.getEvents(ID)).toEqual(events);
    expect(store.getSideChat(chat.id)).not.toBeNull();
  });

  it('retains side chats during a compressed-only schema rebuild and prunes genuine orphans', async () => {
    const db = path.join(home, 'rebuild.sqlite');
    store.close(); store = new Store(db);
    ingester = new Ingester(store, [adapter], () => {}, () => false);
    fs.writeFileSync(archive, compress(raw)); fs.unlinkSync(plain);
    await ingester.reingest(archive);
    const chat = store.createSideChat(ID, store.getEvents(ID)[0]!.id, 'keep');
    const orphan = store.createSideChat('absent-session', 'absent-message', 'gone');
    store.db.pragma('user_version = 0'); store.close(); store = new Store(db);
    expect(store.getSideChat(chat.id)).not.toBeNull(); expect(store.getSession(ID)).toBeNull();
    ingester = new Ingester(store, [adapter], () => {}, () => false);
    ingester.start(); await ingester.reingest(archive);
    expect(store.getSession(ID)?.messageCount).toBe(2);
    expect(store.getSideChat(chat.id)).not.toBeNull(); expect(store.getSideChat(orphan.id)).toBeNull();
  });

  it('retains valid messages and chats across startup with a corrupt compressed replacement', async () => {
    ingester.ingestFile(adapter, plain);
    const original = store.getEvents(ID);
    const chat = store.createSideChat(ID, original[0]!.id, 'keep');
    fs.writeFileSync(packed, Buffer.from('invalid zstd')); fs.unlinkSync(plain);
    ingester.start(); await ingester.reingest(packed);
    expect(store.getEvents(ID)).toEqual(original); expect(store.getSideChat(chat.id)).not.toBeNull();
    expect(store.getSession(ID)?.sourceError).toContain('Cannot read compressed');
  });

  it('serializes a changed bound compressed source discovered through an unrelated plain duplicate', async () => {
    const logs: string[] = [];
    ingester = new Ingester(store, [adapter], msg => logs.push(msg), () => false);
    fs.writeFileSync(archive, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(archive);
    fs.writeFileSync(archive, compress(raw + user('Changed offline')));
    fs.writeFileSync(plain, raw + user('Unrelated duplicate'));
    ingester.start(); await ingester.reingest(plain); await ingester.stop();
    expect(store.getSession(ID)).toMatchObject({ filePath: archive, messageCount: 3 });
    expect(store.search('Changed')).toHaveLength(1); expect(store.search('Unrelated')).toHaveLength(0);
    expect(logs.join(' ')).not.toMatch(/already in use|ingest failed/);
  });

  it('keeps the valid view and Ask guard when a restored sibling cannot be read', async () => {
    fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(packed);
    const original = store.getEvents(ID);
    const chat = store.createSideChat(ID, original[0]!.id, 'keep');
    fs.writeFileSync(plain, raw + user('Restored append'));
    const open = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === plain) throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
      return open(...args);
    });
    await ingester.reingest(packed);
    expect(store.getEvents(ID)).toEqual(original);
    expect(store.getSession(ID)).toMatchObject({ filePath: packed });
    expect(store.getSession(ID)?.sourceError).toContain('Cannot read restored');
    expect(store.getSideChat(chat.id)).not.toBeNull();
    spy.mockRestore(); await ingester.reingest(packed);
    expect(store.getSession(ID)).toMatchObject({ filePath: plain, messageCount: 3 });
    expect(store.getSession(ID)?.sourceError).toBeUndefined();
    expect(store.getSessionByPath(plain)?.byteOffset).toBe(Buffer.byteLength(raw + user('Restored append')));
  });

  it('discovers archived-only compressed data with titles, search, full messages, and decoded offsets', async () => {
    fs.writeFileSync(archive, compress(raw)); fs.unlinkSync(plain);
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: ID, thread_name: 'Compressed title' }) + '\n');
    ingester.start(); await ingester.reingest(archive);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession(ID)).toMatchObject({ filePath: archive, title: 'Compressed title', projectDir: '/synthetic/repo', messageCount: 2, turnOpen: false });
    expect(store.getSessionByPath(archive)?.byteOffset).toBe(Buffer.byteLength(raw));
    expect(store.search('归档')).toHaveLength(1);
    expect(store.getKv(`codex-fingerprint:${ID}`)).toBe(codexFingerprint(archive));
  });

  it.each(['unlink-first', 'add-first', 'offline'])(
    'preserves anchors, snapshots and timestamps across %s compression, archive, restore, and append', async order => {
      ingester.ingestFile(adapter, plain);
      const original = store.getEvents(ID);
      const chat = store.createSideChat(ID, original[0]!.id, '归档 evidence');
      store.appendSideChatTurn(chat.id, { role: 'user', text: 'why?', ts: 1 });
      const snapshot = store.getSideChatSnapshot(chat.id);
      fs.writeFileSync(packed, compress(raw));
      if (order === 'add-first') await ingester.reingest(packed);
      expect(store.getSession(ID)?.filePath).toBe(plain);
      fs.unlinkSync(plain);
      if (order === 'offline') ingester.start();
      await ingester.reingest(order === 'unlink-first' ? plain : packed);
      expect(store.getSession(ID)?.filePath).toBe(packed);
      expect(store.getEvents(ID)).toEqual(original);
      fs.renameSync(packed, archive); await ingester.reingest(packed);
      expect(store.getEvents(ID)).toEqual(original);
      fs.writeFileSync(plain, raw + user('Appended after restore'));
      await ingester.reingest(archive); // Bound archived zst stays until removed (unrelated path).
      fs.unlinkSync(archive); await ingester.reingest(archive); await ingester.reingest(plain);
      expect(store.getSession(ID)).toMatchObject({ filePath: plain, messageCount: 3, updatedAt: original[0]!.ts });
      expect(store.getEvents(ID).slice(0, 2)).toEqual(original);
      expect(store.getSideChat(chat.id)?.turns).toHaveLength(1);
      expect(store.getSideChatSnapshot(chat.id)).toEqual(snapshot);
      fs.unlinkSync(plain); await ingester.reingest(plain);
      expect(store.getSession(ID)).toBeNull(); expect(store.getSideChat(chat.id)).toBeNull();
      expect(store.search('evidence')).toEqual([]);
      for (const prefix of ['codex-source:', 'codex-fingerprint:', 'codex-error:', 'codex-failed:']) expect(store.getKv(prefix + ID)).toBeNull();
    },
  );

  it('prefers a restored plain sibling even while bound compressed data still exists', async () => {
    fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(packed);
    const anchor = store.getEvents(ID)[0]!.id;
    fs.writeFileSync(plain, raw + user('Sibling append')); await ingester.reingest(packed);
    expect(store.getSession(ID)).toMatchObject({ filePath: plain, messageCount: 3 });
    expect(store.getEvents(ID)[0]!.id).toBe(anchor);
    fs.unlinkSync(packed); await ingester.reingest(packed);
    expect(store.getSession(ID)?.messageCount).toBe(3);
  });

  it.each(['checksum', 'truncated', 'magic'])('keeps the last valid view and blocks Ask after %s damage, then heals', async damage => {
    ingester.ingestFile(adapter, plain);
    const original = store.getEvents(ID), chat = store.createSideChat(ID, original[0]!.id, 'evidence');
    let bytes = compress(raw);
    if (damage === 'checksum') bytes[bytes.length - 1] ^= 1;
    if (damage === 'truncated') bytes = bytes.subarray(0, bytes.length - 7);
    if (damage === 'magic') bytes = Buffer.from('invalid');
    fs.writeFileSync(packed, bytes); fs.unlinkSync(plain); await ingester.reingest(plain);
    expect(store.getEvents(ID)).toEqual(original);
    expect(store.getSession(ID)?.sourceError).toContain('Cannot read compressed');
    expect(store.getSideChat(chat.id)).not.toBeNull();
    expect(store.db.prepare('PRAGMA database_list').all()).toHaveLength(1);
    vi.spyOn(codexCliResponder, 'available').mockResolvedValue(true);
    const answer = vi.spyOn(codexCliResponder, 'answer');
    const app = buildServer(store, new SseHub(), undefined, p => ingester.reingest(p));
    try {
      const response = await app.inject({ method: 'POST', url: `/api/side-chats/${chat.id}/ask`, payload: { question: 'why?' } });
      expect(response.statusCode).toBe(409); expect(answer).not.toHaveBeenCalled();
      expect(store.getSideChat(chat.id)?.turns).toEqual([]);
    } finally { await app.close(); }
    fs.writeFileSync(packed, compress(raw)); await ingester.reingest(packed);
    expect(store.getSession(ID)?.sourceError).toBeUndefined(); expect(store.getEvents(ID)).toEqual(original);
  });

  it('survives offline compression across a database restart', async () => {
    store.close(); const db = path.join(home, 'sight.db'); store = new Store(db);
    ingester = new Ingester(store, [adapter], () => {}, () => false);
    ingester.ingestFile(adapter, plain); const original = store.getEvents(ID);
    const chat = store.createSideChat(ID, original[0]!.id, 'evidence');
    await ingester.stop(); store.close(); fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain);
    store = new Store(db); ingester = new Ingester(store, [codexAdapter(path.join(home, 'sessions'))], () => {}, () => false);
    ingester.start(); await ingester.reingest(plain);
    expect(store.getEvents(ID)).toEqual(original); expect(store.getSideChat(chat.id)).not.toBeNull();
  });

  it('passes the compressed current source and frozen excerpt to only Codex Ask', async () => {
    fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(packed);
    const chat = store.createSideChat(ID, store.getEvents(ID)[0]!.id, '归档 evidence');
    vi.spyOn(codexCliResponder, 'available').mockResolvedValue(true);
    const requests: ResponderRequest[] = [];
    vi.spyOn(codexCliResponder, 'answer').mockImplementation(async req => { requests.push(req); return 'answer'; });
    const app = buildServer(store, new SseHub(), undefined, p => ingester.reingest(p));
    try {
      await app.inject({ method: 'POST', url: `/api/side-chats/${chat.id}/ask`, payload: { question: 'why?' } });
      expect(requests[0]).toMatchObject({ sessionFilePath: packed, excerpt: expect.stringContaining('Unicode') });
      const prompt = codexPrompt(requests[0]!);
      expect(prompt).toContain('readCodexRollout.js'); expect(prompt).toContain('pipefail');
      expect(prompt).not.toContain('it is JSONL; read');
      expect(codexPrompt({ ...requests[0]!, sessionFilePath: plain })).toBe(composePrompt({ ...requests[0]!, sessionFilePath: plain }));
    } finally { await app.close(); }
  });

  it('decodes the sanitized streaming fixture with no advertised content size', async () => {
    const fixture = path.join(__dirname, 'fixtures/codex/compression', name + '.zst');
    let text = '';
    const decoded = await readCompressedCodex(fixture, lines => { text += lines.map(l => l.text + '\n').join(''); });
    expect(text).toContain('violet-otter-742'); expect(decoded.consumed).toBe(37708);
  });

  it('shows a passive error for a new corrupt source without publishing partial messages', async () => {
    fs.writeFileSync(packed, compress(raw).subarray(0, 30)); fs.unlinkSync(plain);
    await ingester.reingest(packed);
    expect(store.getSession(ID)?.sourceError).toContain('Cannot read compressed');
    expect(store.getEvents(ID)).toEqual([]);
    fs.unlinkSync(packed); await ingester.reingest(packed);
    expect(store.getSession(ID)).toBeNull();
  });

  it('retains raw unknown records, but rejects an unterminated decoded record until restored', async () => {
    const unknown = entry('future_entry', { novel: true });
    fs.writeFileSync(packed, compress(raw + unknown)); fs.unlinkSync(plain); await ingester.reingest(packed);
    expect(store.getEvents(ID).at(-1)).toMatchObject({ kind: 'unknown' });
    const original = store.getEvents(ID);
    fs.writeFileSync(packed, compress(raw + unknown + user('unfinished').trimEnd()));
    await ingester.reingest(packed);
    expect(store.getSession(ID)?.sourceError).toContain('incomplete JSONL');
    expect(store.getEvents(ID)).toEqual(original);
    fs.writeFileSync(plain, raw + unknown + user('unfinished')); await ingester.reingest(packed);
    expect(store.getSession(ID)).toMatchObject({ filePath: plain, messageCount: 3 });
    expect(store.getSession(ID)?.sourceError).toBeUndefined();
  });

  it('replays a modified compressed source on the same inode without duplicate IDs or stale search', async () => {
    fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(packed);
    const inode = fs.statSync(packed).ino, anchor = store.getEvents(ID)[0]!.id;
    fs.writeFileSync(packed, compress(raw + user('new unique signal'))); await ingester.reingest(packed);
    expect(fs.statSync(packed).ino).toBe(inode);
    expect(store.getEvents(ID)[0]!.id).toBe(anchor); expect(store.search('unique signal')).toHaveLength(1);
    await ingester.reingest(packed); expect(store.getSession(ID)?.messageCount).toBe(3);
  });

  it('uses bounded batches while the main thread remains available during a large decode', async () => {
    const many = Array.from({ length: 3000 }, (_, n) => user(`${n}: ${'large synthetic payload '.repeat(40)}`)).join('');
    fs.writeFileSync(packed, compress(many));
    let batches = 0, count = 0, ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const decoded = await readCompressedCodex(packed, async lines => {
        batches++; count += lines.length; expect(lines.length).toBeLessThanOrEqual(256);
        await new Promise<void>(resolve => setTimeout(resolve, 1));
      });
      expect(decoded.consumed).toBe(Buffer.byteLength(many)); expect(count).toBe(3000);
      expect(batches).toBeGreaterThan(10); expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });

  it('re-resolves a source moved between decoding batches instead of deleting its side chats', async () => {
    const large = raw + Array.from({ length: 600 }, (_, n) => user(`Progress ${n}`)).join('');
    fs.writeFileSync(plain, large); ingester.ingestFile(adapter, plain);
    const chat = store.createSideChat(ID, store.getEvents(ID)[0]!.id, 'evidence');
    fs.writeFileSync(packed, compress(large)); fs.unlinkSync(plain);
    const stage = store.stageCodexEvents;
    let moved = false;
    vi.spyOn(store, 'stageCodexEvents').mockImplementation((...args) => {
      stage(...args);
      if (!moved) { moved = true; fs.renameSync(packed, archive); }
    });
    ingester.start(); await ingester.reingest(packed);
    expect(store.getSession(ID)).toMatchObject({ filePath: archive, messageCount: 602 });
    expect(store.getSideChat(chat.id)).not.toBeNull(); expect(store.getSession(ID)?.sourceError).toBeUndefined();
  });

  it('preserves kept side chats and snapshots after all compressed representations disappear', async () => {
    ingester = new Ingester(store, [adapter], () => {}, () => true);
    fs.writeFileSync(packed, compress(raw)); fs.unlinkSync(plain); await ingester.reingest(packed);
    const chat = store.createSideChat(ID, store.getEvents(ID)[0]!.id, 'evidence');
    const snapshot = store.getSideChatSnapshot(chat.id);
    fs.unlinkSync(packed); await ingester.reingest(packed); store.prune(true);
    expect(store.getSession(ID)).toBeNull(); expect(store.getSideChatSnapshot(chat.id)).toEqual(snapshot);
    store.prune(false); expect(store.getSideChat(chat.id)).toBeNull();
  });

  it('rejects oversized decoded records with a bounded error', async () => {
    fs.writeFileSync(packed, compress(user('x'.repeat(8 * 1024 * 1024)))); fs.unlinkSync(plain);
    await ingester.reingest(packed);
    expect(store.getSession(ID)?.sourceError).toMatch(/8 MiB|memory/);
    expect(store.getEvents(ID)).toEqual([]);
  });
});
