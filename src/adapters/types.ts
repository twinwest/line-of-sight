import type { LiveSession, NormalizedEvent, SessionMeta } from '../shared/types.js';

/** One implementation per supported agent CLI. Session ids (SessionMeta.id)
 *  MUST be globally unique across adapters — every adapter feeds the same
 *  sessions table and one merged live map. Derive ids from the transcript's
 *  own uuid to get that for free; an adapter without uuids must prefix its
 *  ids with its adapter id. */
export interface AgentAdapter {
  id: 'claude-code' | 'codex';           // extend by union, no registry magic
  /** Absolute dirs to scan/watch for transcripts. */
  roots(): string[];
  /** chokidar depth under each root; omit = unlimited. */
  watchDepth?: number;
  /** Cheap check: is this file a session transcript this adapter owns? */
  matches(filePath: string): boolean;
  /** Parse one jsonl line into zero or more normalized events. MUST NOT throw. */
  parseLine(line: string, ctx: { filePath: string; byteOffset: number }): NormalizedEvent[];
  /** Derive session metadata from path + first events. */
  sessionMeta(filePath: string, firstEvents: NormalizedEvent[]): SessionMeta;
  /** sessionId → what the agent process is doing right now, for sessions the
   *  agent reports as active, if it exposes such a signal (see LiveSession
   *  for the state vocabulary).
   *  MUST NOT throw; empty map when unavailable. */
  liveSessions?(): Map<string, LiveSession>;
}
