import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { claudeCodeDialect } from '../src/shared/dialects/index.js';
import type { StoredEvent } from '../src/shared/types.js';

const { isQueueOp, queuedInputs } = claudeCodeDialect;

// Line shapes lifted from real 2026-08 transcripts (see DECISIONS 2026-08-26).

const adapter = claudeCodeAdapter();
const ctx = { filePath: '/t.jsonl', byteOffset: 0 };

const enqLine = (content: string) => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue',
  timestamp: '2026-08-26T18:19:36.050Z', sessionId: 's', content,
});
const deqLine = JSON.stringify({
  type: 'queue-operation', operation: 'dequeue', timestamp: '2026-08-26T18:19:36.424Z', sessionId: 's',
});
const queuedCmdLine = (origin: unknown) => JSON.stringify({
  type: 'attachment', uuid: 'u1', timestamp: '2026-08-26T18:19:36.050Z',
  attachment: {
    type: 'queued_command', prompt: 'our target is not the screen on this machine', source_uuid: 'a',
    commandMode: 'prompt', origin, timestamp: '2026-08-26T18:19:36.050Z',
  },
});

describe('adapter: queue lines', () => {
  it('queue-operation is kept as meta (was dropped pre-2026-08-26)', () => {
    const [ev] = adapter.parseLine(enqLine('hi'), ctx);
    expect(ev).toMatchObject({ kind: 'meta', label: 'queue-operation' });
    if (ev?.kind !== 'meta') throw new Error('unreachable');
    expect((ev.raw as { content?: string }).content).toBe('hi');
    expect(adapter.parseLine(deqLine, ctx)[0]).toMatchObject({ kind: 'meta', label: 'queue-operation' });
  });

  it('human queued_command promotes to a user message; others stay meta', () => {
    const [human] = adapter.parseLine(queuedCmdLine({ kind: 'human' }), ctx);
    expect(human).toMatchObject({ kind: 'message', role: 'user' });
    if (human?.kind !== 'message') throw new Error('unreachable');
    expect(human.blocks[0]).toMatchObject({ type: 'text', markdown: 'our target is not the screen on this machine' });

    const [other] = adapter.parseLine(queuedCmdLine({ kind: 'task' }), ctx);
    expect(other).toMatchObject({ kind: 'meta', label: 'attachment: queued_command' });
    const [drifted] = adapter.parseLine(queuedCmdLine(undefined), ctx);
    expect(drifted?.kind).toBe('meta');
  });
});

describe('queuedInputs (derived FIFO)', () => {
  let seq = 0;
  const op = (operation: string, content?: string): StoredEvent => ({
    id: `q${++seq}`, seq, kind: 'meta', role: null, ts: 0,
    body: { label: 'queue-operation', raw: { operation, ...(content !== undefined ? { content } : {}) } },
  });
  const msg = (id: string): StoredEvent => ({
    id, seq: ++seq, kind: 'message', role: 'user', ts: 0, body: [{ type: 'text', markdown: 'x' }],
  });

  it('enqueue shows; dequeue pops the head; remove deletes by content', () => {
    expect(queuedInputs([op('enqueue', 'a'), op('enqueue', 'b')])).toEqual(['a', 'b']);
    expect(queuedInputs([op('enqueue', 'a'), op('enqueue', 'b'), op('dequeue')])).toEqual(['b']);
    expect(queuedInputs([op('enqueue', 'a'), op('remove', 'a')])).toEqual([]);
  });

  it('plumbing stays in the FIFO but never displays', () => {
    // task-notification queued first: the dequeue must pop IT, not the prompt
    const events = [op('enqueue', '<task-notification>done</task-notification>'), op('enqueue', 'real input'), op('dequeue')];
    expect(queuedInputs(events)).toEqual(['real input']);
  });

  it('dequeue against an empty window is ignored; non-queue events pass through', () => {
    expect(queuedInputs([op('dequeue'), op('enqueue', 'a')])).toEqual(['a']);
    const m = msg('m1');
    expect(isQueueOp(m)).toBe(false);
    expect(isQueueOp(op('enqueue', 'a'))).toBe(true);
    expect(queuedInputs([m, op('enqueue', 'a'), m])).toEqual(['a']);
  });
});
