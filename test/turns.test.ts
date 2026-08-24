import { describe, expect, it } from 'vitest';
import { buildTurns } from '../web/src/turns.js';
import type { StoredEvent } from '../src/shared/types.js';

let seq = 0;
const prompt = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'user', ts: 0,
  body: [{ type: 'text', markdown: 'question' }],
});
const narration = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
  body: [{ type: 'text', markdown: 'let me look…' }],
});
const tool = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
  body: [{ type: 'tool_use', toolName: 'Read', summary: 'Read x', input: {} }],
});
const toolResult = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'user', ts: 0,
  body: [{ type: 'tool_result', toolUseId: null, summary: 's', output: 'o', isError: false }],
});
const meta = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'meta', role: null, ts: 0, body: { label: 'system: turn_duration', raw: {} },
});

const shape = (items: ReturnType<typeof buildTurns>) =>
  items.map((i) => (i.type === 'fold' ? `fold(${i.events.map((e) => e.id).join(',')})` : i.event.id));

describe('buildTurns', () => {
  it('folds intermediate steps of finished turns; last turn stays expanded', () => {
    const events = [
      prompt('p1'), narration('n1'), tool('t1'), toolResult('r1'), narration('c1'),
      prompt('p2'), narration('n2'), tool('t2'), toolResult('r2'), narration('c2'),
    ];
    expect(shape(buildTurns(events))).toEqual([
      'p1', 'fold(n1,t1,r1)', 'c1',
      'p2', 'n2', 't2', 'r2', 'c2',   // last turn untouched
    ]);
  });

  it('trailing meta noise folds without hiding the conclusion', () => {
    const events = [
      prompt('p1'), tool('t1'), toolResult('r1'), narration('c1'), meta('m1'),
      prompt('p2'), narration('c2'),
    ];
    expect(shape(buildTurns(events))).toEqual([
      'p1', 'fold(t1,r1,m1)', 'c1',
      'p2', 'c2',
    ]);
  });

  it('a single intermediate step is not worth a fold', () => {
    const events = [prompt('p1'), tool('t1'), narration('c1'), prompt('p2'), narration('c2')];
    expect(shape(buildTurns(events))).toEqual(['p1', 't1', 'c1', 'p2', 'c2']);
  });

  it('no user prompts → nothing folds', () => {
    const events = [meta('m1'), narration('n1'), narration('n2')];
    expect(shape(buildTurns(events))).toEqual(['m1', 'n1', 'n2']);
  });

  it('preamble before the first prompt folds; tool calls counted', () => {
    const events = [meta('m1'), meta('m2'), prompt('p1'), narration('c1')];
    const items = buildTurns(events);
    expect(shape(items)).toEqual(['fold(m1,m2)', 'p1', 'c1']);
    const events2 = [prompt('p1'), tool('t1'), tool('t2'), toolResult('r1'), narration('c1'), prompt('p2'), narration('c2')];
    const fold = buildTurns(events2).find((i) => i.type === 'fold')!;
    expect(fold.type === 'fold' && fold.toolCalls).toBe(2);
  });
});
