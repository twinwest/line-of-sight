export interface SessionMeta {
  id: string;              // globally unique across adapters (claude: session uuid from filename)
  adapter: 'claude-code' | 'codex';
  filePath: string;
  projectDir: string | null;
  title: string;           // custom-title > ai-title > first user prompt, truncated to 120 chars
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  parentId?: string | null;   // subagent transcript: the session that spawned it
  toolUseId?: string | null;  // …and the parent's Task tool_use it belongs to
  live?: boolean;          // API-only: agent process is active (never stored)
  waiting?: boolean;       // API-only: live, but parked on the user (see liveSessions)
  busySince?: number;      // API-only: when that state began (0 if unknown)
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

/** An event as stored/served by the daemon (seq-ordered within a session). */
export interface StoredEvent {
  id: string;
  seq: number;
  kind: 'message' | 'meta' | 'unknown';
  role: 'user' | 'assistant' | null;
  ts: number;
  /** message: RenderBlock[]; meta/unknown: the raw event payload. */
  body: unknown;
}

export interface SideChatTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface SideChat {
  id: string;
  sessionId: string;
  anchorMessageId: string;
  anchorText: string;
  createdAt: number;
  turns: SideChatTurn[];
}

export type RenderBlock =
  | { type: 'text'; markdown: string }
  | { type: 'thinking'; text: string }
  /** id: the transcript's tool_use id — lets the viewer pair a use with its
   *  tool_result (absent on rows ingested before it was recorded). */
  | { type: 'tool_use'; id?: string | null; toolName: string; summary: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string | null; summary: string;
      output: string; isError: boolean }
  | { type: 'raw'; json: unknown };   // anything unrecognized inside a message
