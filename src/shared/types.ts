export interface SessionMeta {
  id: string;              // adapter-scoped stable id (claude: session uuid from filename)
  adapter: 'claude-code' | 'codex';
  filePath: string;
  projectDir: string | null;
  title: string;           // custom-title > ai-title > first user prompt, truncated to 120 chars
  startedAt: number;
  updatedAt: number;
  messageCount: number;
}

export type TitleSource = 'custom' | 'ai' | 'prompt';

/** Applied by ingestion to the session row as lines reveal metadata. */
export interface SessionPatch {
  projectDir?: string;
  title?: string;
  titleSource?: TitleSource;
}

export type NormalizedEvent =
  | { kind: 'message'; id: string; role: 'user' | 'assistant';
      ts: number; blocks: RenderBlock[]; sessionPatch?: SessionPatch }
  | { kind: 'meta'; id: string; ts: number; label: string; raw: unknown;
      sessionPatch?: SessionPatch }
  | { kind: 'unknown'; id: string; ts: number; raw: unknown };  // defensive fallback

export type RenderBlock =
  | { type: 'text'; markdown: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolName: string; summary: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string | null; summary: string;
      output: string; isError: boolean }
  | { type: 'raw'; json: unknown };   // anything unrecognized inside a message
