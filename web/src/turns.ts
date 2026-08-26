import type { RenderBlock, StoredEvent } from './api';
import { isBlockingUse } from './asks';

// Step folding (SPEC C2, DECISIONS 2026-08-25): sight is a readable re-layout
// of the CLI — every piece of prose the CLI shows stays visible; what folds
// is machine plumbing. Contiguous runs of non-prose events (tool calls and
// results, thinking-only rows, meta, plumbing user messages) collapse into
// one "⏵ N steps" group. While the session is running, the trailing run
// stays expanded for live-follow.

export type TurnItem =
  | { type: 'event'; event: StoredEvent }
  | { type: 'fold'; events: StoredEvent[]; toolCalls: number };

function blocks(e: StoredEvent): RenderBlock[] {
  return e.kind === 'message' && Array.isArray(e.body) ? (e.body as RenderBlock[]) : [];
}

/** Prose the reader must always see: real user prompts, assistant text, and
 *  blocking tools (AskUserQuestion / ExitPlanMode) — the CLI stops on those,
 *  so they are dialogue with the user, not machine plumbing. */
function isVisible(e: StoredEvent): boolean {
  if (e.kind !== 'message') return false;
  const bs = blocks(e);
  if (e.role === 'assistant') return bs.some((b) => b.type === 'text' || isBlockingUse(b));
  // user: a real prompt, not a tool_result carrier, not CLI plumbing
  // (<command-name>, <task-notification>, … — same '<' heuristic as titles)
  if (bs.length === 0 || bs.every((b) => b.type === 'tool_result' || b.type === 'raw')) return false;
  const firstText = bs.find((b) => b.type === 'text');
  return firstText?.type === 'text' && !firstText.markdown.trimStart().startsWith('<');
}

function countToolCalls(events: StoredEvent[]): number {
  return events.reduce((n, e) => n + blocks(e).filter((b) => b.type === 'tool_use').length, 0);
}

/** foldTail: also fold the trailing run — on once the session goes idle
 *  (the 60s/busy running heuristic is the only end-of-session signal). */
export function buildTurns(events: StoredEvent[], opts: { foldTail?: boolean } = {}): TurnItem[] {
  const items: TurnItem[] = [];
  let run: StoredEvent[] = [];

  const flush = (fold: boolean) => {
    if (run.length >= 2 && fold) {
      items.push({ type: 'fold', events: run, toolCalls: countToolCalls(run) });
    } else {
      for (const event of run) items.push({ type: 'event', event });
    }
    run = [];
  };

  for (const e of events) {
    if (isVisible(e)) {
      flush(true);
      items.push({ type: 'event', event: e });
    } else {
      run.push(e);
    }
  }
  flush(opts.foldTail ?? false);
  return items;
}
