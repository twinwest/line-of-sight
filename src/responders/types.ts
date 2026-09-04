export interface ResponderOptions {
  models: string[];
  efforts: string[];
}

/** claude-cli and api both honor the shared responderModel/responderEffort
 *  config, so they declare the same choice lists. */
export const ANTHROPIC_OPTIONS: ResponderOptions = {
  models: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export interface Responder {
  id: 'claude-cli' | 'codex-cli';
  /** Model/effort choices this engine honors (rendered by the panel);
   *  null = the engine runs on its own config and nothing here applies. */
  options: ResponderOptions | null;
  /** Display name for the panel's engine row; omit = the id. Lets an engine
   *  that runs on its own config (options: null) say what actually answers,
   *  e.g. "gpt-5.6-sol (medium)" from ~/.codex/config.toml. */
  label?(): string;
  available(): Promise<boolean>;
  /** Optional: spawn the engine when the side chat opens, before the reader
   *  has typed anything, so its startup overlaps the typing. Best-effort —
   *  answer() must work identically whether or not this ran, and must never
   *  surface a failed pre-spawn. */
  prewarm?(chatId: string, projectDir: string | null): void;
  /** Streamed answer. MUST be read-only (per-engine enforcement).
   *  onStatus (optional): human-readable progress, e.g. "Grep <pattern>". */
  answer(req: ResponderRequest, onChunk: (s: string) => void,
         signal: AbortSignal, onStatus?: (s: string) => void): Promise<string>;
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
   *  source of truth for anything beyond it. */
  excerpt?: string;
}
