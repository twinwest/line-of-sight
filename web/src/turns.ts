import type { RenderBlock, StoredEvent } from './api';

// Turn grouping (SPEC C2, DECISIONS 2026-08-24): scanning a session should
// read as prompt → conclusion pairs. Within each finished turn, everything
// between the user prompt and the trailing run of assistant text (narration,
// tool calls, thinking, meta) folds into one collapsed "steps" group. The
// last turn never folds — that's the live-follow / currently-reading area.

export type TurnItem =
  | { type: 'event'; event: StoredEvent }
  | { type: 'fold'; events: StoredEvent[]; toolCalls: number };

function blocks(e: StoredEvent): RenderBlock[] {
  return e.kind === 'message' && Array.isArray(e.body) ? (e.body as RenderBlock[]) : [];
}

/** A real user prompt — not a tool_result carrier, and not CLI plumbing
 *  (<command-name>, <local-command-*>, <task-notification>, … — same
 *  starts-with-'<' heuristic the adapter uses for titles). */
function isUserPrompt(e: StoredEvent): boolean {
  if (e.kind !== 'message' || e.role !== 'user') return false;
  const bs = blocks(e);
  if (bs.length === 0 || bs.every((b) => b.type === 'tool_result' || b.type === 'raw')) return false;
  const firstText = bs.find((b) => b.type === 'text');
  return firstText?.type === 'text' && !firstText.markdown.trimStart().startsWith('<');
}

/** Assistant text — candidate for the turn's visible conclusion. */
function isConclusion(e: StoredEvent): boolean {
  if (e.kind !== 'message' || e.role !== 'assistant') return false;
  const bs = blocks(e);
  return bs.length > 0 && bs.every((b) => b.type === 'text');
}

function countToolCalls(events: StoredEvent[]): number {
  return events.reduce((n, e) => n + blocks(e).filter((b) => b.type === 'tool_use').length, 0);
}

/** Fold one turn body (events after the prompt). Returns items in render order. */
function foldBody(body: StoredEvent[]): TurnItem[] {
  // trailing run: conclusions at the end; meta/unknown among them are noise → fold
  const visible: StoredEvent[] = [];
  const tailNoise: StoredEvent[] = [];
  let i = body.length - 1;
  for (; i >= 0; i--) {
    const e = body[i]!;
    if (isConclusion(e)) visible.unshift(e);
    else if (e.kind === 'meta' || e.kind === 'unknown') tailNoise.unshift(e);
    else break;
  }
  const intermediate = [...body.slice(0, i + 1), ...tailNoise];
  if (intermediate.length < 2) {
    // nothing worth hiding behind a click
    return body.map((event) => ({ type: 'event', event }));
  }
  return [
    { type: 'fold', events: intermediate, toolCalls: countToolCalls(intermediate) },
    ...visible.map((event): TurnItem => ({ type: 'event', event })),
  ];
}

export function buildTurns(events: StoredEvent[]): TurnItem[] {
  const promptIdxs = events.reduce<number[]>((acc, e, idx) => {
    if (isUserPrompt(e)) acc.push(idx);
    return acc;
  }, []);
  if (promptIdxs.length === 0) return events.map((event) => ({ type: 'event', event }));

  const items: TurnItem[] = [];
  // preamble before the first prompt folds like a turn body
  items.push(...foldBody(events.slice(0, promptIdxs[0]!)));
  for (let t = 0; t < promptIdxs.length; t++) {
    const start = promptIdxs[t]!;
    const end = t + 1 < promptIdxs.length ? promptIdxs[t + 1]! : events.length;
    items.push({ type: 'event', event: events[start]! });
    const body = events.slice(start + 1, end);
    const isLastTurn = t === promptIdxs.length - 1;
    items.push(...(isLastTurn
      ? body.map((event): TurnItem => ({ type: 'event', event }))
      : foldBody(body)));
  }
  return items;
}
