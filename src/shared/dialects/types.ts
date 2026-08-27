import type { RenderBlock, StoredEvent } from '../types.js';

export interface AskOption { label: string; description: string; preview?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }

/** A machine-authored "user" line (task notifications, command wrappers, …). */
export interface Plumbing {
  tag: string;
  /** Fold-row label, e.g. `Agent "Map demand signals" finished`. */
  label: string;
  /** Markdown body to render; null → show the raw text. */
  result: string | null;
}

export interface EditPair { oldText: string; newText: string }

/** Per-agent presentation policy: pure RenderBlock/StoredEvent → data
 *  functions the viewer dispatches on session.adapter. Deliberately
 *  daemon-importable (no React, no node APIs) so future store-side features
 *  can reuse the same decoders. Every method is defensive: shape drift
 *  returns null/false/[] and the caller falls back to generic rendering —
 *  the adapter parses transcripts, the dialect decides how an agent's tools
 *  present. */
export interface Dialect {
  /** Session-badge label; generic fallback = the adapter id itself. */
  displayName: string;
  /** tool_use where the agent stops for the user — never folds; an
   *  unresultted one at the tail means "waiting for you", not "generating". */
  isBlockingUse(b: RenderBlock): boolean;
  /** Question-card data; null → not a question card (or shape drift). */
  askQuestions(b: RenderBlock): AskQuestion[] | null;
  /** The answer to one question, lifted from the result text; null → the
   *  card shows no mark. */
  chosenAnswer(output: string, question: string): string | null;
  /** tool_use that proposes a plan for approval. */
  isPlanUse(b: RenderBlock): boolean;
  /** Plan markdown from a plan use's input, result echo as fallback. */
  planMarkdown(input: unknown, resultOutput: string | null): string | null;
  /** Markdown of a pre-approval plan-draft write; null → ordinary tool. */
  planDraft(b: RenderBlock): string | null;
  /** File-edit diff pairs; null → raw JSON fold. */
  editDiff(b: RenderBlock): EditPair[] | null;
  /** Machine-authored user text; null → real user speech. */
  plumbing(text: string): Plumbing | null;
  /** Queue bookkeeping row — feeds queuedInputs, never renders. */
  isQueueOp(e: StoredEvent): boolean;
  /** Input typed while the agent worked, still undelivered, FIFO. */
  queuedInputs(events: StoredEvent[]): string[];
}
