export interface ResponderOptions {
  models: string[];
  efforts: string[];
  /** Display text per model id; an id without one shows as-is. */
  modelLabels?: Record<string, string>;
}

// CLI aliases, not versioned ids: the installed claude resolves each to its
// newest model (ANTHROPIC_DEFAULT_<ALIAS>_MODEL can remap it), so the list
// doesn't go stale between releases. The id that answered is reported per
// answer (Responder.answer onModel).
const CLAUDE_ALIASES = ['sonnet', 'haiku', 'opus', 'fable'];

export const ANTHROPIC_OPTIONS: ResponderOptions = {
  models: CLAUDE_ALIASES,
  // side chat is look-up-and-summarize: xhigh/max add minutes of thinking
  // per tool round for no visible gain (decided 2026-10-02)
  efforts: ['low', 'medium', 'high'],
  modelLabels: Object.fromEntries(CLAUDE_ALIASES.map((m) => [m, `${m} · latest`])),
};

export const CODEX_OPTIONS: ResponderOptions = {
  models: ['gpt-5.6-terra', 'gpt-5.6-luna'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export interface Responder {
  id: 'claude-cli' | 'codex-cli';
  /** Model/effort choices this engine honors (rendered by the panel). */
  options: ResponderOptions | null;
  /** Display name for the panel's engine row when it has no selectors. */
  label?(): string;
  available(): Promise<boolean>;
  /** Optional: spawn the engine when the side chat opens, before the reader
   *  has typed anything, so its startup overlaps the typing. Best-effort —
   *  answer() must work identically whether or not this ran, and must never
   *  surface a failed pre-spawn. */
  prewarm?(chatId: string, projectDir: string | null, sessionFilePath: string): void;
  /** Streamed answer. MUST be read-only (per-engine enforcement).
   *  onStatus (optional): human-readable progress, e.g. "Grep <pattern>".
   *  onModel (optional): the model id that is answering, as the engine
   *  resolved it — an alias like `sonnet` comes back as its full id. */
  answer(req: ResponderRequest, onChunk: (s: string) => void,
         signal: AbortSignal, onStatus?: (s: string) => void,
         onModel?: (model: string) => void): Promise<string>;
}

export interface ResponderRequest {
  /** The side chat this question belongs to — an engine that pre-spawned for
   *  it (Responder.prewarm) matches its standby process by this. */
  chatId: string;
  question: string;
  anchorText: string;
  sessionFilePath: string;   // pointer — engine reads it itself when it has tools
  projectDir: string | null;
  priorTurns: { role: 'user' | 'assistant'; text: string }[];
  /** Present only when the session contains rewound-away branches: the
   *  prompt then teaches the tree shape and says which side the anchor is
   *  on (Store.askContext). Absent = say nothing about branches. */
  branches?: { anchorAbandoned: boolean } | null;
  /** Clean anchor-centered conversation excerpt (Store.askContext) — spares
   *  the engine the locate/orient tool rounds; the transcript file stays the
   *  source of truth for anything beyond it. Rows carry their timestamp,
   *  which Greps straight to the message's line in the file; tool output is
   *  cut to its head, the anchor's own message excepted. */
  excerpt?: string;
}
