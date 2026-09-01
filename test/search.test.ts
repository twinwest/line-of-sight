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
        { type: 'thinking', text: 'pondering about zeppelins' },
        { type: 'tool_use', id: 't1', toolName: 'Bash', summary: 'npm run migrate-users', input: {} },
        { type: 'tool_result', toolUseId: 't1', summary: 'ok',
          output: 'giant file dump mentioning kaleidoscope', isError: false },
        { type: 'text', markdown: '약 **35 줄**, `askContext` 및 [문서](https://hidden.example) 참고' },
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

  it('indexes dialog only: no thinking, tool summaries, or tool output', () => {
    const store = makeStore();
    expect(store.search('zeppelins')).toHaveLength(0);
    expect(store.search('migrate-users')).toHaveLength(0);
    expect(store.search('kaleidoscope')).toHaveLength(0);
  });

  it('matches the rendered text, not the markdown source', () => {
    const store = makeStore();
    expect(store.search('약 35 줄')).toHaveLength(1);   // source has ** around 35 줄
    expect(store.search('askContext')).toHaveLength(1);   // inline code
    expect(store.search('hidden.example')).toHaveLength(0); // link URL is not rendered text
  });

  it('deleted messages disappear from the index', () => {
    const store = makeStore();
    store.resetSession('s1');
    expect(store.search('incremental')).toHaveLength(0);
  });

  it('empty query returns nothing', () => {
    expect(makeStore().search('  ')).toHaveLength(0);
  });

  it('reindexes pre-v3 rows once on open', () => {
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
    // simulate a pre-v3 db: tool output in the index, no migration flag
    store.db.prepare("UPDATE messages SET text_content = 'kaleidoscope'").run();
    store.db.prepare("DELETE FROM kv WHERE key = 'text_content_v3'").run();
    expect(store.search('kaleidoscope')).toHaveLength(1);
    store.close();
    const reopened = new Store(dbPath);
    expect(reopened.search('kaleidoscope')).toHaveLength(0);
    reopened.close();
  });
});
