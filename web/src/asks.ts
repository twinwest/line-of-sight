import type { RenderBlock, StoredEvent } from './api';

// Blocking tools — the two places the agent stops and waits for the user.
// Their tool_use blocks render as first-class cards (Message.tsx), never fold
// (turns.ts), and an unanswered one at the tail means "waiting for you", not
// "generating". Everything below parses UNDOCUMENTED CLI shapes: every access
// is defensive, and a mismatch degrades to the generic fold — never a crash.
// Sight stays read-only (SPEC B5): the cards mirror CLI state, answering
// happens in the CLI.

export const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export function isBlockingUse(b: RenderBlock): b is Extract<RenderBlock, { type: 'tool_use' }> {
  return b.type === 'tool_use' && BLOCKING_TOOLS.has(b.toolName);
}

/** Newer CLI plan modes draft the plan into ~/.claude/plans/*.md via Write —
 *  a non-blocking tool that flushes immediately, so the draft is in the
 *  transcript long before ExitPlanMode lands (SPIKE_NOTES 2026-08-26: the
 *  blocking use itself only flushes on approval). Promoting these Writes is
 *  the only way to show the plan while it is actually pending. Shape drift
 *  (missing content, other paths) → false, generic fold. */
export function isPlanFileWrite(b: RenderBlock): boolean {
  if (b.type !== 'tool_use' || b.toolName !== 'Write') return false;
  const i = b.input as { file_path?: unknown; content?: unknown } | null;
  return typeof i?.file_path === 'string' && /\/\.claude\/plans\/[^/]+\.md$/.test(i.file_path)
    && typeof i?.content === 'string' && i.content.trim() !== '';
}

export interface AskOption { label: string; description: string; preview?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }

/** AskUserQuestion input.questions; null → shape drift, use the raw fold. */
export function askQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    const o = (q ?? {}) as Record<string, unknown>;
    if (typeof o.question !== 'string' || !Array.isArray(o.options)) return null;
    const options: AskOption[] = [];
    for (const raw of o.options) {
      const opt = (raw ?? {}) as Record<string, unknown>;
      if (typeof opt.label !== 'string') return null;
      options.push({
        label: opt.label,
        description: typeof opt.description === 'string' ? opt.description : '',
        ...(typeof opt.preview === 'string' ? { preview: opt.preview } : {}),
      });
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: o.multiSelect === true,
      options,
    });
  }
  return out;
}

/** The answer to one question, lifted from the result text — the CLI writes
 *  `Your questions have been answered: "<question>"="<answer>" …`. Substring
 *  search, not a grammar: format drift returns null (card shows no mark). */
export function chosenAnswer(output: string, question: string): string | null {
  const at = output.indexOf(`"${question}"="`);
  if (at < 0) return null;
  const rest = output.slice(at + question.length + 4);
  const end = rest.indexOf('"');
  return end > 0 ? rest.slice(0, end) : null;
}

/** The plan markdown. Every observed CLI version records it in `input.plan`
 *  (pending included); the approval result echoes it after "## Approved
 *  Plan:" — kept as fallback in case a future version empties the input. */
export function planMarkdown(input: unknown, resultOutput: string | null): string | null {
  const plan = (input as { plan?: unknown } | null)?.plan;
  if (typeof plan === 'string' && plan.trim()) return plan;
  const m = resultOutput?.match(/^## Approved Plan:\n/m);
  return m && resultOutput ? resultOutput.slice((m.index ?? 0) + m[0].length) : null;
}

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
export function pendingBlockId(events: StoredEvent[], outcomes: Map<string, ToolOutcome>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'message') continue;
    const bs = Array.isArray(e.body) ? (e.body as RenderBlock[]) : [];
    return bs.some((b) => isBlockingUse(b) && !!b.id && !outcomes.has(b.id)) ? e.id : null;
  }
  return null;
}
