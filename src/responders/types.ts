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
  id: 'claude-cli' | 'codex-cli' | 'api';
  /** Model/effort choices this engine honors (rendered by the panel);
   *  null = the engine runs on its own config and nothing here applies. */
  options: ResponderOptions | null;
  available(): Promise<boolean>;
  /** Streamed answer. MUST be read-only (per-engine enforcement).
   *  onStatus (optional): human-readable progress, e.g. "Grep <pattern>". */
  answer(req: ResponderRequest, onChunk: (s: string) => void,
         signal: AbortSignal, onStatus?: (s: string) => void): Promise<string>;
}

export interface ResponderRequest {
  question: string;
  anchorText: string;
  sessionFilePath: string;   // pointer — engine reads it itself when it has tools
  projectDir: string | null;
  priorTurns: { role: 'user' | 'assistant'; text: string }[];
  /** Lazy transcript excerpt for engines without tools (api calls it,
   *  tool-engines never do) — the caller needs no engine knowledge. */
  inlineContext: () => string;
}
