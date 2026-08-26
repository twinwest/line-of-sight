import type { StoredEvent } from './api';

// The CLI's input queue, derived from queue-operation lines. While the agent
// works, the CLI shows queued input under its spinner; Sight mirrors that as
// a tail strip. The state is DERIVED, never stored: enqueue pushes, a
// content-less dequeue pops the head (FIFO — delivery order), remove deletes
// by content (covers both post-delivery cleanup and the user withdrawing a
// queued message). Once delivered, the text lands as a real user line or a
// queued_command attachment, and the ops empty the derived queue — so a
// placeholder can never coexist with its delivered copy.

function opOf(e: StoredEvent): { operation: string; content?: string } | null {
  if (e.kind !== 'meta') return null;
  const body = e.body as { label?: string; raw?: unknown } | null;
  if (body?.label !== 'queue-operation') return null;
  const raw = (body.raw ?? {}) as { operation?: unknown; content?: unknown };
  if (typeof raw.operation !== 'string') return null;
  return { operation: raw.operation, ...(typeof raw.content === 'string' ? { content: raw.content } : {}) };
}

/** Queue bookkeeping rows never render — they only feed queuedInputs. */
export function isQueueOp(e: StoredEvent): boolean {
  return opOf(e) !== null;
}

/** Texts still waiting in the CLI's queue, FIFO. Plumbing (task
 *  notifications queue through the same mechanism) is kept for correct FIFO
 *  popping but excluded from display by the usual '<' heuristic. A dequeue
 *  against an empty queue (its enqueue fell outside the loaded window) is
 *  ignored rather than guessed at. */
export function queuedInputs(events: StoredEvent[]): string[] {
  const q: string[] = [];
  for (const e of events) {
    const op = opOf(e);
    if (!op) continue;
    if (op.operation === 'enqueue' && op.content !== undefined) q.push(op.content);
    else if (op.operation === 'dequeue') q.shift();
    else if (op.operation === 'remove' && op.content !== undefined) {
      const i = q.indexOf(op.content);
      if (i >= 0) q.splice(i, 1);
    }
  }
  return q.filter((t) => {
    const s = t.trimStart();
    return s.length > 0 && !s.startsWith('<');
  });
}
