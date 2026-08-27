import type { Dialect } from '../../src/shared/dialects';
import type { RenderBlock, StoredEvent } from './api';

// Agent-neutral tool_use ↔ tool_result pairing over the loaded window, plus
// the "which event is the CLI parked on" derivation. Per-agent shapes (which
// tools block, card parsing, …) live in src/shared/dialects/.

export interface ToolOutcome { output: string; isError: boolean }

/** tool_use id → its tool_result, across the loaded window. */
export function toolOutcomes(events: StoredEvent[]): Map<string, ToolOutcome> {
  const map = new Map<string, ToolOutcome>();
  for (const e of events) {
    if (e.kind !== 'message' || !Array.isArray(e.body)) continue;
    for (const b of e.body as RenderBlock[]) {
      if (b.type === 'tool_result' && b.toolUseId) {
        map.set(b.toolUseId, { output: b.output, isError: b.isError });
      }
    }
  }
  return map;
}

/** Ids of tool_use blocks in the loaded window — a tool_result whose use is
 *  here renders inside that use's fold; orphans (use outside the "Load
 *  earlier" window, or drift) still render standalone. */
export function toolUseIds(events: StoredEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'message' || !Array.isArray(e.body)) continue;
    for (const b of e.body as RenderBlock[]) {
      if (b.type === 'tool_use' && b.id) ids.add(b.id);
    }
  }
  return ids;
}

/** Id of the last message event iff it holds an unanswered blocking use —
 *  i.e. the CLI is parked on a question/plan right now. Derived from the
 *  transcript, not the liveness flag: the CLI may well report idle while it
 *  waits on the user. Rows without a block id (pre-id ingests) never count. */
export function pendingBlockId(events: StoredEvent[], outcomes: Map<string, ToolOutcome>,
    dialect: Dialect): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'message') continue;
    const bs = Array.isArray(e.body) ? (e.body as RenderBlock[]) : [];
    return bs.some((b) => b.type === 'tool_use' && dialect.isBlockingUse(b)
      && !!b.id && !outcomes.has(b.id)) ? e.id : null;
  }
  return null;
}
