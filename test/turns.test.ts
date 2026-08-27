import { describe, expect, it } from 'vitest';
import { claudeCodeDialect } from '../src/shared/dialects/index.js';
import { buildTurns } from '../web/src/turns.js';
import type { StoredEvent } from '../src/shared/types.js';

let seq = 0;
const prompt = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'user', ts: 0,
  body: [{ type: 'text', markdown: 'question' }],
});
const narration = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
  body: [{ type: 'text', markdown: 'Issue #3 filed, verifying next:' }],
});
const tool = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
  body: [{ type: 'tool_use', toolName: 'Read', summary: 'Read x', input: {} }],
});
const toolResult = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'user', ts: 0,
  body: [{ type: 'tool_result', toolUseId: null, summary: 's', output: 'o', isError: false }],
});
const thinking = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
  body: [{ type: 'thinking', text: 'hmm' }],
});
const meta = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'meta', role: null, ts: 0, body: { label: 'system: away_summary', raw: {} },
});
const plumbing = (id: string): StoredEvent => ({
  id, seq: ++seq, kind: 'message', role: 'user', ts: 0,
  body: [{ type: 'text', markdown: '<task-notification>done</task-notification>' }],
});

const shape = (items: ReturnType<typeof buildTurns>) =>
  items.map((i) => (i.type === 'fold' ? `fold(${i.events.map((e) => e.id).join(',')})` : i.event.id));

describe('buildTurns (step folding: prose always visible)', () => {
  it('folds contiguous tool runs between prose, keeps every text visible', () => {
    const events = [
      prompt('p1'),
      narration('n1'), tool('t1'), toolResult('r1'), thinking('th1'), tool('t2'), toolResult('r2'),
      narration('n2'), tool('t3'), toolResult('r3'),
      narration('c1'),
    ];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual([
      'p1', 'n1', 'fold(t1,r1,th1,t2,r2)', 'n2', 'fold(t3,r3)', 'c1',
    ]);
  });

  it('plumbing user messages and meta fold with the run', () => {
    const events = [prompt('p1'), tool('t1'), plumbing('x1'), meta('m1'), narration('c1')];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual([
      'p1', 'fold(t1,x1,m1)', 'c1',
    ]);
  });

  it('a single non-prose event stays inline', () => {
    const events = [prompt('p1'), tool('t1'), narration('c1')];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual(['p1', 't1', 'c1']);
  });

  it('trailing run stays expanded while running, folds when idle', () => {
    const events = [prompt('p1'), narration('n1'), tool('t1'), toolResult('r1'), tool('t2')];
    expect(shape(buildTurns(events, claudeCodeDialect))).toEqual(['p1', 'n1', 't1', 'r1', 't2']);
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual(['p1', 'n1', 'fold(t1,r1,t2)']);
  });

  it('counts tool calls per fold', () => {
    const events = [prompt('p1'), tool('t1'), tool('t2'), toolResult('r1'), narration('c1')];
    const fold = buildTurns(events, claudeCodeDialect, { foldTail: true }).find((i) => i.type === 'fold')!;
    expect(fold.type === 'fold' && fold.toolCalls).toBe(2);
  });

  it('counts steps as rendered rows: results absorbed, plumbing/meta one each', () => {
    // 2 actions + 1 thought + 1 plumbing + 1 meta = 5; the results add nothing
    const events = [prompt('p1'),
      tool('t1'), toolResult('r1'), thinking('th1'), tool('t2'), toolResult('r2'),
      plumbing('x1'), meta('m1'), narration('c1')];
    const fold = buildTurns(events, claudeCodeDialect, { foldTail: true }).find((i) => i.type === 'fold')!;
    expect(fold.type === 'fold' && fold.steps).toBe(5);
  });

  it('session preamble (meta before first prompt) folds', () => {
    const events = [meta('m1'), meta('m2'), prompt('p1'), narration('c1')];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual(['fold(m1,m2)', 'p1', 'c1']);
  });

  it('blocking tools (AskUserQuestion / ExitPlanMode) never fold', () => {
    const ask = (id: string, toolName: string): StoredEvent => ({
      id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
      body: [{ type: 'tool_use', toolName, summary: toolName, input: {} }],
    });
    const events = [prompt('p1'), tool('t1'), toolResult('r1'),
      ask('a1', 'AskUserQuestion'), toolResult('r2'), ask('x1', 'ExitPlanMode'), narration('c1')];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual([
      'p1', 'fold(t1,r1)', 'a1', 'r2', 'x1', 'c1',
    ]);
  });

  it('plan-file Writes never fold; other Writes and drifted shapes do', () => {
    const write = (id: string, input: unknown): StoredEvent => ({
      id, seq: ++seq, kind: 'message', role: 'assistant', ts: 0,
      body: [{ type: 'tool_use', toolName: 'Write', summary: 'Write x', input }],
    });
    const events = [prompt('p1'),
      write('w1', { file_path: '/home/u/.claude/plans/plan-mode-x.md', content: '# Plan' }),
      write('w2', { file_path: '/repo/README.md', content: '# Readme' }),
      write('w3', { file_path: '/home/u/.claude/plans/plan-mode-x.md' }), // no content → drift
      narration('c1')];
    expect(shape(buildTurns(events, claudeCodeDialect, { foldTail: true }))).toEqual([
      'p1', 'w1', 'fold(w2,w3)', 'c1',
    ]);
  });
});
