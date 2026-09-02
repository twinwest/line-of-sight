import type { RenderBlock, StoredEvent } from '../types.js';
import type { AskOption, AskQuestion, Dialect, EditPair, Plumbing } from './types.js';

// Claude Code's presentation policy. Everything below parses UNDOCUMENTED CLI
// shapes: every access is defensive, and a mismatch degrades to the generic
// fold — never a crash. Sight stays read-only (SPEC B5): the cards mirror
// CLI state, answering happens in the CLI.

// Blocking tools — the two places the agent stops and waits for the user.
// Their tool_use blocks render as first-class cards (Message.tsx) and never
// fold (turns.ts).
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function isBlockingUse(b: RenderBlock): boolean {
  return b.type === 'tool_use' && BLOCKING_TOOLS.has(b.toolName);
}

/** Newer CLI plan modes draft the plan into ~/.claude/plans/*.md via Write —
 *  a non-blocking tool that flushes immediately, so the draft is in the
 *  transcript long before ExitPlanMode lands (SPIKE_NOTES 2026-08-26: the
 *  blocking use itself only flushes on approval). Promoting these Writes is
 *  the only way to show the plan while it is actually pending. Shape drift
 *  (missing content, other paths) → null, generic fold. */
function planDraft(b: RenderBlock): string | null {
  // ponytail: Write only — Edits to the plan file are deltas that can't
  // reconstruct the full text, so they stay folded as ordinary steps
  if (b.type !== 'tool_use' || b.toolName !== 'Write') return null;
  const i = b.input as { file_path?: unknown; content?: unknown } | null;
  return typeof i?.file_path === 'string' && /\/\.claude\/plans\/[^/]+\.md$/.test(i.file_path)
    && typeof i?.content === 'string' && i.content.trim() !== '' ? i.content : null;
}

/** AskUserQuestion input.questions; null → shape drift, use the raw fold. */
function askQuestions(b: RenderBlock): AskQuestion[] | null {
  if (b.type !== 'tool_use' || b.toolName !== 'AskUserQuestion') return null;
  const qs = (b.input as { questions?: unknown } | null)?.questions;
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
function chosenAnswer(output: string, q: AskQuestion): string | null {
  const at = output.indexOf(`"${q.question}"="`);
  if (at < 0) return null;
  const rest = output.slice(at + q.question.length + 4);
  const end = rest.indexOf('"');
  return end > 0 ? rest.slice(0, end) : null;
}

function isPlanUse(b: RenderBlock): boolean {
  return b.type === 'tool_use' && b.toolName === 'ExitPlanMode';
}

/** The plan markdown. Every observed CLI version records it in `input.plan`
 *  (pending included); the approval result echoes it after "## Approved
 *  Plan:" — kept as fallback in case a future version empties the input. */
function planMarkdown(input: unknown, resultOutput: string | null): string | null {
  const plan = (input as { plan?: unknown } | null)?.plan;
  if (typeof plan === 'string' && plan.trim()) return plan;
  const m = resultOutput?.match(/^## Approved Plan:\n/m);
  return m && resultOutput ? resultOutput.slice((m.index ?? 0) + m[0].length) : null;
}

/** Diff pairs for the file-editing tools; null → raw JSON fold. */
function editDiff(b: RenderBlock): EditPair[] | null {
  if (b.type !== 'tool_use') return null;
  const i = (b.input ?? {}) as Record<string, unknown>;
  if (b.toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return [{ oldText: i.old_string, newText: i.new_string }];
  }
  if (b.toolName === 'Write' && typeof i.content === 'string') {
    return [{ oldText: '', newText: i.content }];
  }
  if (b.toolName === 'MultiEdit' && Array.isArray(i.edits)) {
    const pairs: EditPair[] = [];
    for (const e of i.edits) {
      const ed = e as Record<string, unknown>;
      if (typeof ed.old_string === 'string' && typeof ed.new_string === 'string') {
        pairs.push({ oldText: ed.old_string, newText: ed.new_string });
      }
    }
    return pairs.length ? pairs : null;
  }
  return null;
}

// CLI-plumbing user messages: transcript lines with role "user" that no human
// typed (<task-notification>, <command-name>, <local-command-stdout>, …).
// They must never render as user speech — provenance is the product.
function plumbing(text: string): Plumbing | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  const tag = /^<([a-z][\w-]*)/i.exec(t)?.[1] ?? 'system';
  if (tag === 'task-notification') {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
    const result = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(t)?.[1]?.trim() ?? null;
    return { tag, label: summary ?? tag, result };
  }
  return { tag, label: tag, result: null };
}

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

function isQueueOp(e: StoredEvent): boolean {
  return opOf(e) !== null;
}

/** Texts still waiting in the CLI's queue, FIFO. Plumbing (task
 *  notifications queue through the same mechanism) is kept for correct FIFO
 *  popping but excluded from display by the usual '<' heuristic. A dequeue
 *  against an empty queue (its enqueue fell outside the loaded window) is
 *  ignored rather than guessed at. */
function queuedInputs(events: StoredEvent[]): string[] {
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
  return q.filter((t) => plumbing(t) === null && t.trim().length > 0);
}

export const claudeCodeDialect: Dialect = {
  displayName: 'claude',
  resumeArgv: (id) => ['claude', '--resume', id],
  isBlockingUse, askQuestions, chosenAnswer, isPlanUse, planMarkdown,
  planDraft, editDiff, plumbing, isQueueOp, queuedInputs,
};
