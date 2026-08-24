import type { NormalizedEvent, SessionMeta } from '../shared/types.js';

export interface AgentAdapter {
  id: 'claude-code' | 'codex';           // extend by union, no registry magic
  /** Absolute dirs to scan/watch for transcripts. */
  roots(): string[];
  /** Cheap check: is this file a session transcript this adapter owns? */
  matches(filePath: string): boolean;
  /** Parse one jsonl line into zero or more normalized events. MUST NOT throw. */
  parseLine(line: string, ctx: { filePath: string; byteOffset: number }): NormalizedEvent[];
  /** Derive session metadata from path + first events. */
  sessionMeta(filePath: string, firstEvents: NormalizedEvent[]): SessionMeta;
}
