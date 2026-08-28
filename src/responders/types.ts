export interface Responder {
  id: 'claude-cli' | 'codex-cli' | 'api';
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
