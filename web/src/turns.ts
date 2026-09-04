import type { Dialect } from '../../src/shared/dialects';
import type { RenderBlock, StoredEvent } from './api';

// Step folding (SPEC C2, decided 2026-08-25): sight is a readable re-layout
// of the CLI — every piece of prose the CLI shows stays visible; what folds
// is machine plumbing. Contiguous runs of non-prose events (tool calls and
// results, thinking-only rows, meta, plumbing user messages) collapse into
// one "⏵ N steps" group. While the session is running, the trailing run
// stays expanded for live-follow.

export type TurnItem =
  | { type: 'event'; event: StoredEvent }
  | { type: 'fold'; events: StoredEvent[]; steps: number; toolCalls: number }
  | { type: 'abandoned'; events: StoredEvent[]; steps: number };

function blocks(e: StoredEvent): RenderBlock[] {
  return e.kind === 'message' && Array.isArray(e.body) ? (e.body as RenderBlock[]) : [];
}

/** Prose the reader must always see: real user prompts, assistant text,
 *  blocking tools (the dialect's isBlockingUse — the CLI stops on those, so
 *  they are dialogue with the user, not machine plumbing) and plan drafts,
 *  the only pre-approval sighting of a pending plan. */
function isVisible(e: StoredEvent, dialect: Dialect): boolean {
  if (e.kind !== 'message') return false;
  if (e.role === 'assistant') {
    return blocks(e).some((b) => b.type === 'text' || dialect.isBlockingUse(b)
      || dialect.planDraft(b) !== null);
  }
  return isUserPrompt(e, dialect);
}

/** A real user prompt: not a tool_result carrier, not CLI plumbing
 *  (<command-name>, <task-notification>, … — the dialect knows the shapes).
 *  Also the draft card's "the conversation moved on" signal. */
export function isUserPrompt(e: StoredEvent, dialect: Dialect): boolean {
  if (e.kind !== 'message' || e.role !== 'user') return false;
  const bs = blocks(e);
  if (bs.length === 0 || bs.every((b) => b.type === 'tool_result' || b.type === 'raw')) return false;
  const firstText = bs.find((b) => b.type === 'text');
  return firstText?.type === 'text' && dialect.plumbing(firstText.markdown) === null;
}

function countToolCalls(events: StoredEvent[]): number {
  return events.reduce((n, e) => n + blocks(e).filter((b) => b.type === 'tool_use').length, 0);
}

/** A step is a rendered row: an action (tool call, its result absorbed), a
 *  thought, or a plumbing/meta/raw fallback line — not a jsonl entry. */
function countSteps(events: StoredEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind !== 'message') { n += 1; continue; }   // meta/unknown → one raw fold
    const bs = blocks(e);
    // empty thinking (redacted) renders no row — see Message.tsx
    const rows = bs.filter((b) => b.type === 'tool_use' || b.type === 'raw'
      || (b.type === 'thinking' && b.text.trim() !== '')).length;
    // 0 rows: a pure tool_result carrier renders nothing; anything else
    // (plumbing text, …) renders one fold line
    n += rows > 0 ? rows : (bs.every((b) => b.type === 'tool_result' || b.type === 'thinking') ? 0 : 1);
  }
  return n;
}

/** foldTail: also fold the trailing run — on once the session goes idle
 *  (the 60s/busy running heuristic is the only end-of-session signal). */
export function buildTurns(events: StoredEvent[], dialect: Dialect,
    opts: { foldTail?: boolean } = {}): TurnItem[] {
  // Rewound-away branches fold whole, before step folding sees them: they are
  // real prose the conversation abandoned, so neither rendering them inline
  // (the reader can't tell live from dead) nor dropping them (they are the
  // "what was ruled out" record) is right. One fold per contiguous dead run.
  const items: TurnItem[] = [];
  let dead: StoredEvent[] = [];
  const flushDead = () => {
    if (dead.length) {
      items.push({ type: 'abandoned', events: dead, steps: countSteps(dead) });
      dead = [];
    }
  };
  const live: StoredEvent[] = [];
  for (const e of events) {
    if (e.abandoned) { dead.push(e); continue; }
    if (dead.length) { items.push(...buildLive(live.splice(0), dialect, { foldTail: true })); flushDead(); }
    live.push(e);
  }
  flushDead();
  items.push(...buildLive(live, dialect, opts));
  return items;
}

function buildLive(events: StoredEvent[], dialect: Dialect,
    opts: { foldTail?: boolean } = {}): TurnItem[] {
  const items: TurnItem[] = [];
  let run: StoredEvent[] = [];

  const flush = (fold: boolean) => {
    if (run.length >= 2 && fold) {
      items.push({ type: 'fold', events: run, steps: countSteps(run), toolCalls: countToolCalls(run) });
    } else {
      for (const event of run) items.push({ type: 'event', event });
    }
    run = [];
  };

  for (const e of events) {
    if (isVisible(e, dialect)) {
      flush(true);
      items.push({ type: 'event', event: e });
    } else {
      run.push(e);
    }
  }
  flush(opts.foldTail ?? false);
  return items;
}
