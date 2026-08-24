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

  it('deleted messages disappear from the index', () => {
    const store = makeStore();
    store.resetSession('s1');
    expect(store.search('incremental')).toHaveLength(0);
  });

  it('empty query returns nothing', () => {
    expect(makeStore().search('  ')).toHaveLength(0);
  });
});
