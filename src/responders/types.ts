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
  /** For engines without tools (api): pre-built context around the anchor. */
  inlineContext?: string;
}
