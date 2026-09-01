import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_START, Store } from '../src/store/store.js';

function makeStore(): Store {
  const store = new Store(':memory:');
  store.upsertSession({
    id: 's1', adapter: 'claude-code', filePath: '/f1', projectDir: '/p',
    title: 'test session', startedAt: 1, updatedAt: 1, messageCount: 0,
  });
  store.appendEvents('s1', [
    { kind: 'message', id: 'm1', role: 'user', ts: 1,
      blocks: [{ type: 'text', markdown: 'incremental parsing is great' }] },
    { kind: 'message', id: 'm2', role: 'assistant', ts: 2,
      blocks: [{ type: 'text', markdown: '전문검색 구현 방안을 논의했습니다' }] },
    { kind: 'message', id: 'm3', role: 'assistant', ts: 3,
      blocks: [
        { type: 'tool_use', id: 't1', toolName: 'Bash', summary: 'npm run migrate-users', input: {} },
        { type: 'tool_result', toolUseId: 't1', summary: 'ok',
          output: 'giant file dump mentioning kaleidoscope', isError: false },
      ] },
  ], 100);
  return store;
}

describe('search', () => {
  it('finds english substrings via FTS', () => {
    const hits = makeStore().search('cremental pars');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sessionId: 's1', messageId: 'm1', sessionTitle: 'test session' });
    expect(hits[0]!.snippet).toContain(MARK_START);
  });

  it('finds CJK phrases >= 3 chars via FTS', () => {
    expect(makeStore().search('전문검색')).toHaveLength(1);
  });

  it('finds 2-char CJK words via the LIKE fallback', () => {
    const hits = makeStore().search('검색');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messageId).toBe('m2');
  });

  it('indexes tool_use summaries but not tool_result output', () => {
    const store = makeStore();
    expect(store.search('migrate-users')).toHaveLength(1);
    expect(store.search('kaleidoscope')).toHaveLength(0);
  });

  it('deleted messages disappear from the index', () => {
    const store = makeStore();
    store.resetSession('s1');
    expect(store.search('incremental')).toHaveLength(0);
  });

  it('empty query returns nothing', () => {
    expect(makeStore().search('  ')).toHaveLength(0);
  });

  it('reindexes pre-v2 rows once on open', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-')), 'test.db');
    const store = new Store(dbPath);
    store.upsertSession({
      id: 's1', adapter: 'claude-code', filePath: '/f1', projectDir: '/p',
      title: 'test session', startedAt: 1, updatedAt: 1, messageCount: 0,
    });
    store.appendEvents('s1', [
      { kind: 'message', id: 'm1', role: 'assistant', ts: 1,
        blocks: [{ type: 'tool_result', toolUseId: 't1', summary: 'ok',
          output: 'kaleidoscope', isError: false }] },
    ], 100);
    // simulate a pre-v2 db: tool output in the index, no migration flag
    store.db.prepare("UPDATE messages SET text_content = 'kaleidoscope'").run();
    store.db.prepare("DELETE FROM kv WHERE key = 'text_content_v2'").run();
    expect(store.search('kaleidoscope')).toHaveLength(1);
    store.close();
    const reopened = new Store(dbPath);
    expect(reopened.search('kaleidoscope')).toHaveLength(0);
    reopened.close();
  });
});
