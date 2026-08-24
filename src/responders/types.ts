export interface Responder {
  id: 'claude-cli' | 'codex-cli' | 'api';
  available(): Promise<boolean>;
  /** Streamed answer. MUST be read-only (per-engine enforcement). */
  answer(req: ResponderRequest, onChunk: (s: string) => void,
         signal: AbortSignal): Promise<string>;
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
