import type { RenderBlock, StoredEvent } from '../types.js';
import type { AskOption, AskQuestion, Dialect, EditPair, Plumbing } from './types.js';

// Codex's presentation policy (shapes from SPIKE_NOTES 2026-08-27, pinned by
// test/codex-dialect.test.ts). The adapter already delivers most semantics
// pre-structured (items); what remains here is the request_user_input card,
// its id-keyed answers, and apply_patch diffs. Defensive throughout: drift
// degrades to the generic fold, never a crash.

function isBlockingUse(b: RenderBlock): boolean {
  return b.type === 'tool_use' && b.toolName === 'request_user_input';
}

/** request_user_input input.questions:
 *  {questions: [{header, id, question, options: [{label, description}]}]} —
 *  nearly congruent with claude's AskUserQuestion; answers key on `id`. */
function askQuestions(b: RenderBlock): AskQuestion[] | null {
  if (!isBlockingUse(b) || b.type !== 'tool_use') return null;
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
      });
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: false,
      options,
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
    });
  }
  return out;
}

/** function_call_output: `{"answers": {"<question-id>": {"answers":
 *  ["<label>", …]}}}` — structured, keyed by question id. */
function chosenAnswer(output: string, q: AskQuestion): string | null {
  if (!q.id) return null;
  try {
    const parsed = JSON.parse(output) as { answers?: Record<string, { answers?: unknown }> };
    const answers = parsed.answers?.[q.id]?.answers;
    if (!Array.isArray(answers) || answers.length === 0) return null;
    const labels = answers.filter((a): a is string => typeof a === 'string');
    return labels.length ? labels.join(', ') : null;
  } catch {
    return null;
  }
}

/** One unified-diff hunk → the old/new texts DiffView re-diffs. Hunks split
 *  on `@@` headers; line prefixes ' '/'-'/'+' route content to both/old/new. */
function hunksToPairs(diff: string): EditPair[] {
  const pairs: EditPair[] = [];
  let oldLines: string[] | null = null;
  let newLines: string[] = [];
  const flush = () => {
    if (oldLines !== null && (oldLines.length || newLines.length)) {
      pairs.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    }
  };
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      oldLines = []; newLines = [];
    } else if (oldLines === null) {
      continue;                      // preamble before the first hunk header
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else {
      const t = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(t); newLines.push(t);
    }
  }
  flush();
  return pairs;
}

/** apply_patch input = the FileChange `changes` map:
 *  add → {content}; update → {unified_diff}; unknown kinds are skipped. */
function editDiff(b: RenderBlock): EditPair[] | null {
  if (b.type !== 'tool_use' || b.toolName !== 'apply_patch') return null;
  const changes = b.input;
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const pairs: EditPair[] = [];
  for (const ch of Object.values(changes as Record<string, unknown>)) {
    const c = (ch ?? {}) as Record<string, unknown>;
    if (c.type === 'add' && typeof c.content === 'string') {
      pairs.push({ oldText: '', newText: c.content });
    } else if (c.type === 'delete' && typeof c.content === 'string') {
      pairs.push({ oldText: c.content, newText: '' });
    } else if (c.type === 'update' && typeof c.unified_diff === 'string') {
      pairs.push(...hunksToPairs(c.unified_diff));
    }
  }
  return pairs.length ? pairs : null;
}

/** Items arrive pre-filtered by the CLI, so this should never fire — kept as
 *  the same cheap '<' guard claude uses, in case a wrapper ever leaks. */
function plumbing(text: string): Plumbing | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  const tag = /^<([a-z][\w-]*)/i.exec(t)?.[1] ?? 'system';
  return { tag, label: tag, result: null };
}

export const codexDialect: Dialect = {
  displayName: 'codex',
  isBlockingUse,
  askQuestions,
  chosenAnswer,
  // codex's Plan item is already visible markdown prose (adapter decision,
  // DECISIONS 2026-08-27) — there is no approval tool to card-ify
  isPlanUse: () => false,
  planMarkdown: () => null,
  planDraft: () => null,
  editDiff,
  plumbing,
  // the input queue rides ~/.codex/queue_1.sqlite, not the transcript
  isQueueOp: () => false,
  queuedInputs: () => [],
};
