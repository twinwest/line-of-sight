import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { NormalizedEvent, RenderBlock, SessionMeta, SessionPatch, SideChat, SideChatTurn, StoredEvent, TitleSource } from '../shared/types.js';

export type { SideChat, StoredEvent };

/** Bump when sessions/messages/messages_fts change shape (see constructor). */
const SCHEMA_VERSION = 3;  // 3: codex escalated exec → approval row (2: 0.153 token_usage_record/web.search)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, adapter TEXT, file_path TEXT UNIQUE, project_dir TEXT,
  title TEXT DEFAULT '', title_source TEXT,
  started_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0,
  byte_offset INTEGER DEFAULT 0,
  parent_id TEXT, tool_use_id TEXT, workflow_id TEXT, ended_at INTEGER,
  turn_open INTEGER, turn_started_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT, session_id TEXT, seq INTEGER, role TEXT, ts INTEGER,
  blocks_json TEXT,
  text_content TEXT,
  parent_id TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text_content, content='messages', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text_content) VALUES (new.rowid, new.text_content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES ('delete', old.rowid, old.text_content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES ('delete', old.rowid, old.text_content);
  INSERT INTO messages_fts(rowid, text_content) VALUES (new.rowid, new.text_content);
END;
CREATE TABLE IF NOT EXISTS side_chats (
  id TEXT PRIMARY KEY, session_id TEXT, anchor_message_id TEXT,
  anchor_text TEXT, created_at INTEGER,
  turns_json TEXT,
  excerpt_json TEXT
);
CREATE TABLE IF NOT EXISTS stats (day TEXT, event TEXT, count INTEGER, PRIMARY KEY (day, event));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

/** Snippet match delimiters — control chars that can't collide with content. */
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

/** Correlated on sessions.id — dialog rows only, matching the search index. */
const MESSAGE_COUNT = `(SELECT count(*) FROM messages m
  WHERE m.session_id = sessions.id AND m.role IN ('user','assistant'))`;

const TITLE_PRIORITY: Record<TitleSource, number> = { prompt: 1, ai: 2, custom: 3 };

interface SessionRow {
  id: string; adapter: string; file_path: string; project_dir: string | null;
  title: string; title_source: TitleSource | null;
  started_at: number; updated_at: number; message_count: number; byte_offset: number;
  parent_id: string | null; tool_use_id: string | null; workflow_id: string | null;
  ended_at: number | null;
  turn_open: number | null; turn_started_at: number | null;
}

function toMeta(r: SessionRow): SessionMeta {
  return {
    id: r.id, adapter: r.adapter as SessionMeta['adapter'], filePath: r.file_path,
    projectDir: r.project_dir, title: r.title,
    startedAt: r.started_at, updatedAt: r.updated_at, messageCount: r.message_count,
    parentId: r.parent_id, toolUseId: r.tool_use_id, workflowId: r.workflow_id,
    endedAt: r.ended_at,
    turnOpen: r.turn_open == null ? null : r.turn_open === 1,
    turnStartedAt: r.turn_started_at,
  };
}

// Must be the same parser the viewer renders with (react-markdown +
// remark-gfm), or the index and the visible text drift apart again.
const mdParser = unified().use(remarkParse).use(remarkGfm);

/** What the reader saw, not what the agent typed: markdown stripped to plain
 *  text so "about 35 lines" is findable when the source says "about **35 lines**".
 *  Blocks whose children are themselves blocks join with \n so list items
 *  and paragraphs don't concatenate into false phrases. Raw HTML is dropped
 *  — react-markdown doesn't render it either. */
const MD_CONTAINERS = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow']);
function mdNodeText(n: { type: string; children?: unknown[] }): string {
  if (MD_CONTAINERS.has(n.type)) {
    return (n.children ?? []).map((c) => mdNodeText(c as { type: string })).filter(Boolean).join('\n');
  }
  if (n.type === 'html') return '';
  return mdastToString(n);
}
function stripMarkdown(src: string): string {
  try { return mdNodeText(mdParser.parse(src)); } catch { return src; }
}

/** Search-indexed text: dialog only — user input and agent output, stripped
 *  to what the reader saw. thinking, tool_use summaries and tool_result
 *  output are all out of scope (decided 2026-09-01). Excerpts (askContext)
 *  use blocksText instead, so the responder still sees everything. */
function textContent(ev: NormalizedEvent): string {
  if (ev.kind !== 'message') return '';
  return dialogText(ev.blocks);
}

function dialogText(blocks: RenderBlock[]): string {
  return blocks.filter((b) => b.type === 'text')
    .map((b) => stripMarkdown(b.markdown)).filter(Boolean).join('\n');
}

/** One message of an ask excerpt, as facts. `text` is already cut
 *  (blocksText); the label is rendered from the rest on the way out. */
export interface ExcerptRow {
  id: string; seq: number; role: string; ts: number; text: string;
  abandoned: boolean; anchor: boolean;
}

/** What side_chats.excerpt_json holds: the excerpt rows plus enough of the
 *  session to label them once the sessions row is gone. `v` is for a later
 *  shape change; the label text is NOT part of the shape. */
export interface AskSnapshot {
  v: 1;
  session: { adapter: string; projectDir: string | null; title: string; filePath: string };
  branches: { anchorAbandoned: boolean } | null;
  rows: ExcerptRow[];
}

/** The rows as the responder reads them: `[role, timestamp, marks]\ntext`,
 *  blank-line separated. The single place the label format lives. */
export function renderExcerpt(rows: ExcerptRow[]): string {
  return rows.map((r) => {
    const tags = [r.role];
    if (r.ts) tags.push(new Date(r.ts).toISOString());
    if (r.abandoned) tags.push('abandoned branch');
    if (r.anchor) tags.push('contains the ANCHOR');
    return `[${tags.join(', ')}]\n${r.text}`;
  }).join('\n\n');
}

/** Message text for responder excerpts: prose and thinking in full, tool
 *  output cut to its head unless the anchor sits in this message. Measured
 *  2026-09-12 (10k tool results): 36% fit in 300 chars, 8% run
 *  past 4000, the largest 884KB — left whole they eat the excerpt budget
 *  that the "why" prose needs. The responder reads a cut result in full by
 *  Grepping the transcript for the row's timestamp (#21). */
const TOOL_OUTPUT_HEAD = 300;
function blocksText(blocks: RenderBlock[], anchor: boolean): string {
  return blocks.map((b) => {
    switch (b.type) {
      case 'text': return b.markdown;
      case 'thinking': return b.text;
      case 'tool_result': return anchor || b.output.length <= TOOL_OUTPUT_HEAD
        ? b.output
        : `${b.output.slice(0, TOOL_OUTPUT_HEAD)} …[tool output cut: ${b.output.length - TOOL_OUTPUT_HEAD} more chars]`;
      case 'tool_use': return b.summary;
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Derived tables are rebuilt from the transcripts whenever their shape
    // changes: bump SCHEMA_VERSION, nothing else. side_chats, stats and kv are
    // kept. The rebuild is the first-run scan again. VACUUM is safe here
    // because the FTS table it must stay rowid-aligned with is empty.
    const rebuild = this.db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION;
    if (rebuild) {
      this.db.exec('DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions');
      this.db.exec('VACUUM');
    }
    this.db.exec(SCHEMA);
    if (rebuild) {
      this.db.exec(`DELETE FROM kv WHERE key LIKE 'text_content_v%' OR key = 'repair_v1'`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    // user-owned tables can't be rebuilt, so they take additive columns.
    // Rows from before the column are filled in lazily (getSideChatSnapshot).
    const cols = (this.db.pragma('table_info(side_chats)') as { name: string }[]).map((c) => c.name);
    if (!cols.includes('excerpt_json')) this.db.exec('ALTER TABLE side_chats ADD COLUMN excerpt_json TEXT');
  }

  close(): void { this.db.close(); }

  getSessionByPath(filePath: string): { id: string; byteOffset: number } | null {
    const r = this.db.prepare('SELECT id, byte_offset FROM sessions WHERE file_path = ?')
      .get(filePath) as { id: string; byte_offset: number } | undefined;
    return r ? { id: r.id, byteOffset: r.byte_offset } : null;
  }

  /** Codex archive/unarchive moves the source, not its session. The inode
   *  checkpoint survives rename (including while Sight is stopped). A copy
   *  or replacement is reparsed, keeping titles and user-owned side chats. */
  bindCodexSessionFile = this.txn((id: string, filePath: string, sourceKey: string): void => {
    const session = this.getSession(id);
    if (!session || session.adapter !== 'codex') throw new Error('not a Codex session');
    const key = `codex-source:${id}`;
    const priorSource = this.getKv(key);
    // Upgrade old path-based fallback IDs without rebuilding unrelated
    // adapters or invalidating side-chat anchors.
    const oldPrefix = `${session.filePath}:`;
    const newPrefix = `${id}:`;
    if (!priorSource || session.filePath !== filePath) {
      this.db.prepare(`UPDATE messages SET id = ? || substr(id, length(?) + 1)
        WHERE session_id = ? AND substr(id, 1, length(?)) = ?`)
        .run(newPrefix, oldPrefix, id, oldPrefix, oldPrefix);
      this.db.prepare(`UPDATE side_chats SET anchor_message_id = ? || substr(anchor_message_id, length(?) + 1)
        WHERE session_id = ? AND substr(anchor_message_id, 1, length(?)) = ?`)
        .run(newPrefix, oldPrefix, id, oldPrefix, oldPrefix);
    }
    if ((priorSource && priorSource !== sourceKey) || (!priorSource && session.filePath !== filePath)) {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare(`UPDATE sessions SET byte_offset = 0, message_count = 0,
        turn_open = NULL, turn_started_at = NULL, updated_at = started_at WHERE id = ?`).run(id);
    }
    this.db.prepare('UPDATE sessions SET file_path = ? WHERE id = ?').run(filePath, id);
    this.setKv(key, sourceKey);
  });

  upsertSession(meta: SessionMeta): void {
    // ON CONFLICT(id) DO NOTHING would silently drop a cross-adapter id
    // collision; the AgentAdapter contract (globally-unique, uuid-derived ids)
    // is the guard. Revisit loudness only if an adapter can't promise uuids.
    this.db.prepare(`
      INSERT INTO sessions (id, adapter, file_path, project_dir, title, title_source,
        started_at, updated_at, message_count, parent_id, tool_use_id, workflow_id, ended_at)
      VALUES (@id, @adapter, @filePath, @projectDir, @title, @titleSource,
        @startedAt, @updatedAt, @messageCount, @parentId, @toolUseId, @workflowId, @endedAt)
      ON CONFLICT(id) DO NOTHING
    `).run({
      id: meta.id, adapter: meta.adapter, filePath: meta.filePath,
      projectDir: meta.projectDir, title: meta.title,
      // a title known at ingest time (a subagent's meta.json description) must
      // outrank the prompt-derived one the first transcript line would apply
      titleSource: meta.title ? 'custom' : null,
      startedAt: meta.startedAt, updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      parentId: meta.parentId ?? null, toolUseId: meta.toolUseId ?? null,
      workflowId: meta.workflowId ?? null,
      // the parent may have recorded this child's end before the child's file
      // was scanned (directory order is arbitrary) — consult the fact store
      endedAt: meta.parentId
        ? this.childEnd(meta.parentId, meta.toolUseId) ?? this.childEnd(meta.parentId, meta.workflowId) : null,
    });
  }

  /** Wipe a session's events for a from-zero re-parse (file shrank). */
  private childEnd(parentId: string, key: string | null | undefined): number | null {
    const v = key ? this.getKv(`ended:${parentId}:${key}`) : null;
    return v ? Number(v) : null;
  }

  /** A Workflow launch ack: remember which run a tool_use id names, so the
   *  run's task-notification can end every child under that run id. */
  noteWorkflowRun(parentId: string, toolUseId: string, runId: string, name: string | null): void {
    this.setKv(`wfrun:${parentId}:${toolUseId}`, runId);
    if (name) this.setKv(`wfname:${parentId}:${runId}`, name);
  }

  /** run id → workflow name, for every Workflow run this session launched. */
  workflowNames(parentId: string): Record<string, string> {
    const prefix = `wfname:${parentId}:`;
    const rows = this.db.prepare('SELECT key, value FROM kv WHERE key LIKE ?')
      .all(`${prefix}%`) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key.slice(prefix.length), r.value]));
  }

  /** The parent recorded a child run finishing (task-notification, or a sync
   *  Task's tool_result). Order-independent: the fact is kept in kv for
   *  children ingested later, and applied to the ones already here. */
  endChildren(parentId: string, toolUseId: string, ts: number): void {
    const keys = [toolUseId];
    const runId = this.getKv(`wfrun:${parentId}:${toolUseId}`);
    if (runId) keys.push(runId);
    for (const k of keys) this.setKv(`ended:${parentId}:${k}`, String(ts));
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE parent_id = ? AND ended_at IS NULL
      AND (tool_use_id = ? OR workflow_id = ?)`).run(ts, parentId, toolUseId, runId ?? '');
  }

  /** A transcript that left the disk takes its session with it: children,
   *  side chats and the parent-recorded facts (SPEC B9). `keepSideChats`
   *  (config) is the one opt-in exception: the side chats stay, snapshot
   *  and all; nothing else does. */
  deleteSession = this.txn((id: string, keepSideChats = false): void => {
    const ids = [id, ...this.listChildren(id).map((c) => c.id)];
    const ph = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM messages WHERE session_id IN (${ph})`).run(...ids);
    if (!keepSideChats) this.db.prepare(`DELETE FROM side_chats WHERE session_id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM kv WHERE key LIKE 'ended:' || ? || ':%'
      OR key LIKE 'wfrun:' || ? || ':%' OR key LIKE 'wfname:' || ? || ':%'`).run(id, id, id);
    for (const sessionId of ids) this.db.prepare('DELETE FROM kv WHERE key = ?').run(`codex-source:${sessionId}`);
  });

  /** After a scan: sessions whose transcript is gone, and side chats a
   *  schema rebuild left without a session. With `keepSideChats` the
   *  orphans stay; turning it off clears them on the next scan. */
  prune(keepSideChats = false, handleMissing?: (session: SessionMeta) => boolean): void {
    const rows = this.db.prepare('SELECT * FROM sessions').all() as SessionRow[];
    for (const r of rows) {
      if (!fs.existsSync(r.file_path) && !handleMissing?.(toMeta(r))) this.deleteSession(r.id, keepSideChats);
    }
    if (!keepSideChats) {
      this.db.prepare('DELETE FROM side_chats WHERE session_id NOT IN (SELECT id FROM sessions)').run();
    }
  }

  resetSession(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare(`UPDATE sessions SET byte_offset = 0, message_count = 0,
      title = '', title_source = NULL WHERE id = ?`).run(sessionId);
  }

  /** Append a batch of events and advance the checkpoint, in one transaction.
   *  Returns the events as stored (with seq) for SSE broadcast. */
  appendEvents = this.txn((sessionId: string, events: NormalizedEvent[], newByteOffset: number): StoredEvent[] => {
    const maxSeq = (this.db.prepare('SELECT MAX(seq) s FROM messages WHERE session_id = ?')
      .get(sessionId) as { s: number | null }).s ?? 0;
    const insert = this.db.prepare(`
      INSERT INTO messages (id, session_id, seq, role, ts, blocks_json, text_content, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET blocks_json = excluded.blocks_json,
        text_content = excluded.text_content, ts = excluded.ts, parent_id = excluded.parent_id
    `);
    let seq = maxSeq;
    let lastTs = 0;
    const stored: StoredEvent[] = [];
    for (const ev of events) {
      // patch-only carriers (title lines: raw === null) update the session
      // but have nothing to display — no row, no SSE broadcast
      if (ev.kind === 'meta' && ev.raw === null) {
        if (ev.sessionPatch) this.applyPatch(ev.sessionPatch.sessionId ?? sessionId, ev.sessionPatch);
        continue;
      }
      const role = ev.kind === 'message' ? ev.role : ev.kind;
      // meta events keep their display label alongside the raw payload
      const body = ev.kind === 'message' ? ev.blocks
        : ev.kind === 'meta' ? { label: ev.label, raw: ev.raw }
        : ev.raw;
      const parentId = ev.kind === 'unknown' ? null : ev.parentId ?? null;
      insert.run(ev.id, sessionId, ++seq, role, ev.ts, JSON.stringify(body ?? null), textContent(ev), parentId);
      // only real messages count as activity — trailing bookkeeping writes
      // (away_summary etc.) must not make an idle session look running
      if (ev.kind === 'message' && ev.ts > lastTs) lastTs = ev.ts;
      if (ev.kind !== 'unknown' && ev.sessionPatch) this.applyPatch(ev.sessionPatch.sessionId ?? sessionId, ev.sessionPatch);
      stored.push({
        id: ev.id, seq, ts: ev.ts, kind: ev.kind,
        role: ev.kind === 'message' ? ev.role : null,
        body: body ?? null,
      });
    }
    // recount rather than add: a re-read from byte 0 (schema backfill) lands
    // every row on DO UPDATE, which reports changes=1 just like an insert
    this.db.prepare(`
      UPDATE sessions SET byte_offset = ?, message_count = ${MESSAGE_COUNT},
        updated_at = MAX(updated_at, ?),
        started_at = CASE WHEN started_at = 0 THEN ? ELSE started_at END
      WHERE id = ?
    `).run(newByteOffset, lastTs, events[0]?.ts ?? 0, sessionId);
    return stored;
  });

  /** Apply one patch outside the append flow (patch files, see Ingester). */
  patchSession(sessionId: string, patch: SessionPatch): void {
    this.applyPatch(sessionId, patch);
  }

  private applyPatch(sessionId: string, patch: SessionPatch): void {
    if (patch.turnOpen !== undefined) {
      // last-wins: patches arrive in transcript order
      this.db.prepare(`UPDATE sessions SET turn_open = ?,
        turn_started_at = COALESCE(?, turn_started_at) WHERE id = ?`)
        .run(patch.turnOpen ? 1 : 0, patch.turnStartedAt ?? null, sessionId);
    }
    if (patch.projectDir) {
      this.db.prepare('UPDATE sessions SET project_dir = ? WHERE id = ? AND project_dir IS NULL')
        .run(patch.projectDir, sessionId);
    }
    if (patch.title && patch.titleSource) {
      const cur = this.db.prepare('SELECT title, title_source FROM sessions WHERE id = ?')
        .get(sessionId) as { title: string; title_source: TitleSource | null } | undefined;
      if (!cur) return;
      const curPrio = cur.title_source ? TITLE_PRIORITY[cur.title_source] : 0;
      const newPrio = TITLE_PRIORITY[patch.titleSource];
      // prompt: first one wins; custom/ai: last one wins (>= allows re-titling)
      const apply = patch.titleSource === 'prompt' ? curPrio === 0 : newPrio >= curPrio;
      if (apply) {
        this.db.prepare('UPDATE sessions SET title = ?, title_source = ? WHERE id = ?')
          .run(patch.title, patch.titleSource, sessionId);
      }
    }
  }

  /** Top-level sessions only — subagent runs are reached from their parent. */
  listSessions(opts: { project?: string; q?: string } = {}): SessionMeta[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE parent_id IS NULL
        AND (@project IS NULL OR project_dir = @project)
        AND (@q IS NULL OR title LIKE '%' || @q || '%')
      ORDER BY updated_at DESC
    `).all({ project: opts.project ?? null, q: opts.q ?? null }) as SessionRow[];
    return rows.map(toMeta);
  }

  /** Subagent sessions this session spawned, in the order they started. */
  listChildren(parentId: string): SessionMeta[] {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE parent_id = ? ORDER BY started_at',
    ).all(parentId) as SessionRow[];
    return rows.map(toMeta);
  }

  getSession(id: string): SessionMeta | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? toMeta(r) : null;
  }

  getMessageSeq(sessionId: string, messageId: string): number | null {
    const r = this.db.prepare('SELECT seq FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { seq: number } | undefined;
    return r?.seq ?? null;
  }

  /** Everything a responder ask needs from the store, in one pass:
   *  - `branches` (#9): null when the session has no abandoned branches (the
   *    common case — the prompt then says nothing about them); otherwise
   *    whether the anchor message itself sits on one.
   *  - `excerpt` (#10): clean anchor-centered conversation text. Measured
   *    2026-08-31: the tool loop spends its first ~5-8 rounds (~4s each) just
   *    locating the anchor and orienting in the raw jsonl; text_content is
   *    the same material without the envelope, so those rounds are free here.
   *    Rows carry their timestamp (#21): both CLIs write it verbatim on the
   *    jsonl line, so it is a one-Grep coordinate back into the file.
   *  Both need the abandoned set — computed once. */
  askContext(sessionId: string, anchorMessageId: string, n = 20, maxChars = 30_000):
      { excerpt: string; branches: { anchorAbandoned: boolean } | null } {
    const { rows, branches } = this.askRows(sessionId, anchorMessageId, n, maxChars);
    return { excerpt: renderExcerpt(rows), branches };
  }

  /** The excerpt as facts — one row per message, unrendered — so a stored
   *  snapshot (side_chats.excerpt_json) is never parsed back out of prompt
   *  text and a later label change applies to old snapshots too. */
  askRows(sessionId: string, anchorMessageId: string, n = 20, maxChars = 30_000):
      { rows: ExcerptRow[]; branches: { anchorAbandoned: boolean } | null } {
    const abandoned = this.abandonedSeqs(sessionId);
    const anchorSeq = this.getMessageSeq(sessionId, anchorMessageId);
    const branches = abandoned.size
      ? { anchorAbandoned: anchorSeq !== null && abandoned.has(anchorSeq) }
      : null;
    if (anchorSeq === null) return { rows: [], branches };
    const rows = this.db.prepare(`
      SELECT id, seq, role, ts, blocks_json FROM messages
      WHERE session_id = ? AND seq BETWEEN ? AND ? AND role IN ('user','assistant')
      ORDER BY seq
    `).all(sessionId, anchorSeq - n, anchorSeq + n) as
      { id: string; seq: number; role: string; ts: number; blocks_json: string }[];
    // from blocks_json, not text_content: the search index dropped tool_result
    // output, but the excerpt still needs it (the anchor may sit inside one)
    const blocks = rows
      .map((r) => ({ ...r, full: blocksText(JSON.parse(r.blocks_json) as RenderBlock[], r.id === anchorMessageId) }))
      .filter((r) => r.full).map((r) => {
      // 4000: 97% of text blocks fit (92% at the previous 2000); the budget
      // by distance below still bounds a run of fat rows
      const text = r.full.length > 4000
        ? `${r.full.slice(0, 4000)} …[truncated]` : r.full;
      return {
        id: r.id, seq: r.seq, role: r.role, ts: r.ts, text,
        abandoned: abandoned.has(r.seq), anchor: r.id === anchorMessageId,
      };
    });
    // budget by distance from the anchor, so a fat early message can never
    // push the anchor itself out; re-sort into reading order after
    blocks.sort((a, b) => Math.abs(a.seq - anchorSeq) - Math.abs(b.seq - anchorSeq));
    const kept: typeof blocks = [];
    let total = 0;
    for (const b of blocks) {
      if (total + b.text.length > maxChars) break;
      kept.push(b);
      total += b.text.length + 2;
    }
    kept.sort((a, b) => a.seq - b.seq);
    return { rows: kept, branches };
  }

  getEvents(sessionId: string, opts: { beforeSeq?: number; limit?: number } = {}): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT id, seq, role, ts, blocks_json FROM messages
      WHERE session_id = ? AND seq < ?
      ORDER BY seq DESC LIMIT ?
    `).all(sessionId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 200) as
      { id: string; seq: number; role: string; ts: number; blocks_json: string }[];
    const abandoned = this.abandonedSeqs(sessionId);
    return rows.reverse().map((r) => ({
      id: r.id, seq: r.seq, ts: r.ts,
      kind: r.role === 'meta' || r.role === 'unknown' ? r.role : 'message',
      role: r.role === 'meta' || r.role === 'unknown' ? null : (r.role as 'user' | 'assistant'),
      body: JSON.parse(r.blocks_json) as unknown,
      ...(abandoned.has(r.seq) ? { abandoned: true } : {}),
    }));
  }

  /** Seqs on branches the conversation left behind (rewind / prompt edit).
   *
   *  Transcripts are trees: rewinding appends a new branch off an earlier node
   *  and leaves the old one in the file, so a linear read interleaves live and
   *  dead turns (half the rows, in the worst session measured — SPIKE_NOTES
   *  2026-08-31). Rule, validated against the full parent graph of 50 real
   *  sessions with zero mismatches: at a node with several non-tool_result
   *  children, the LAST child is the branch that survived; every earlier child
   *  opens a dead run that ends where the next sibling begins.
   *
   *  Deliberately not a tail-walk from the last row: dropped bookkeeping lines
   *  (attachment subtypes, turn_duration) sit mid-chain, which broke the chain
   *  in 49 of those 50 sessions. Fork children are user prompts, which are
   *  never dropped, so this rule needs no intact chain. Computed per read
   *  because a later append can abandon rows already written. */
  private abandonedSeqs(sessionId: string): Set<number> {
    const rows = this.db.prepare(
      'SELECT id, seq, parent_id FROM messages WHERE session_id = ? ORDER BY seq',
    ).all(sessionId) as { id: string; seq: number; parent_id: string | null }[];
    const byParent = new Map<string, { id: string; seq: number }[]>();
    for (const r of rows) {
      if (!r.parent_id) continue;
      const sibs = byParent.get(r.parent_id);
      if (sibs) sibs.push(r); else byParent.set(r.parent_id, [r]);
    }
    const forks = [...byParent.values()].filter((sibs) => sibs.length > 1);
    if (!forks.length) return new Set();
    // tool_result carriers are not branches: parallel tool calls each parent
    // their own result, so a fan-out looks like a fork until they are excluded
    const results = this.toolResultIds(sessionId, forks.flat().map((s) => s.id));
    const dead = new Set<number>();
    for (const sibs of forks) {
      const real = sibs.filter((s) => !results.has(s.id));
      for (let i = 0; i < real.length - 1; i++) {
        for (let seq = real[i]!.seq; seq < real[i + 1]!.seq; seq++) dead.add(seq);
      }
    }
    return dead;
  }

  /** Of the given message ids, those whose blocks are only tool_results.
   *  Bodies are fetched for fork children alone — never the whole session. */
  private toolResultIds(sessionId: string, ids: string[]): Set<string> {
    const out = new Set<string>();
    if (!ids.length) return out;
    const rows = this.db.prepare(
      `SELECT id, blocks_json FROM messages WHERE session_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).all(sessionId, ...ids) as { id: string; blocks_json: string }[];
    for (const r of rows) {
      try {
        const blocks = JSON.parse(r.blocks_json) as { type?: string }[] | null;
        if (Array.isArray(blocks) && blocks.length > 0
          && blocks.every((b) => b?.type === 'tool_result')) out.add(r.id);
      } catch { /* unparseable body: treat as a real branch */ }
    }
    return out;
  }

  search(q: string): { sessionId: string; sessionTitle: string; messageId: string; snippet: string }[] {
    const query = q.trim();
    if (!query) return [];
    // trigram FTS needs >= 3 chars; shorter queries (common 2-char CJK words) use LIKE
    const rows = query.length >= 3
      ? this.db.prepare(`
          SELECT m.session_id, m.id, snippet(messages_fts, 0, ?, ?, '…', 12) snip
          FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ? ORDER BY rank LIMIT 100
        `).all(MARK_START, MARK_END, `"${query.replaceAll('"', '""')}"`)
      : this.db.prepare(`
          SELECT session_id, id, substr(text_content, MAX(1, instr(text_content, ?) - 40), 120) snip
          FROM messages WHERE text_content LIKE '%' || ? || '%' LIMIT 100
        `).all(query, query);
    const sessStmt = this.db.prepare('SELECT title, updated_at FROM sessions WHERE id = ?');
    const hits = (rows as { session_id: string; id: string; snip: string }[]).map((r) => {
      const s = sessStmt.get(r.session_id) as { title: string; updated_at: number } | undefined;
      return { sessionId: r.session_id, sessionTitle: s?.title ?? '', messageId: r.id,
        snippet: r.snip, updatedAt: s?.updated_at ?? 0 };
    });
    // One hit per message: a resume/fork copies earlier turns verbatim — same
    // uuids — into a new file (101 shared ids across one pair on disk,
    // decided 2026-09-02), so both sessions would land on the same text.
    // The session that moved last owns the message; rank order is kept.
    const owner = new Map<string, typeof hits[number]>();
    for (const h of hits) {
      const o = owner.get(h.messageId);
      if (!o || h.updatedAt > o.updatedAt) owner.set(h.messageId, h);
    }
    return hits.filter((h) => owner.get(h.messageId) === h)
      .map(({ updatedAt: _, ...h }) => h);
  }

  createSideChat(sessionId: string, anchorMessageId: string, anchorText: string): SideChat {
    const chat: SideChat = {
      id: randomUUID(), sessionId, anchorMessageId, anchorText,
      createdAt: Date.now(), turns: [],
    };
    this.db.prepare(`
      INSERT INTO side_chats (id, session_id, anchor_message_id, anchor_text, created_at, turns_json)
      VALUES (?, ?, ?, ?, ?, '[]')
    `).run(chat.id, sessionId, anchorMessageId, anchorText, chat.createdAt);
    this.snapshotSideChat(chat.id);
    return chat;
  }

  /** Freeze the conversation around the anchor as it is right now. Taken
   *  once, when the side chat is created: every follow-up in the chat is
   *  asked against this same context (decided 2026-09-12), and it is what
   *  outlives the transcript under `keepSideChats`. No session or no anchor
   *  (a test's ghost chat, a rebuild in progress): nothing stored. */
  snapshotSideChat(id: string): AskSnapshot | null {
    const chat = this.getSideChat(id);
    const session = chat && this.getSession(chat.sessionId);
    if (!chat || !session) return null;
    const { rows, branches } = this.askRows(chat.sessionId, chat.anchorMessageId);
    if (!rows.length) return null;
    const snapshot: AskSnapshot = {
      v: 1,
      session: { adapter: session.adapter, projectDir: session.projectDir,
        title: session.title, filePath: session.filePath },
      branches, rows,
    };
    this.db.prepare('UPDATE side_chats SET excerpt_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), id);
    return snapshot;
  }

  /** The stored snapshot; a chat from before snapshots existed is filled in
   *  here, while its transcript is still around to read. */
  getSideChatSnapshot(id: string): AskSnapshot | null {
    const r = this.db.prepare('SELECT excerpt_json FROM side_chats WHERE id = ?')
      .get(id) as { excerpt_json: string | null } | undefined;
    if (!r) return null;
    if (r.excerpt_json) return JSON.parse(r.excerpt_json) as AskSnapshot;
    return this.snapshotSideChat(id);
  }

  getSideChat(id: string): SideChat | null {
    // not SELECT *: excerpt_json is up to 30KB and only the ask path reads it
    const r = this.db.prepare(`SELECT id, session_id, anchor_message_id, anchor_text, created_at, turns_json
      FROM side_chats WHERE id = ?`).get(id) as {
      id: string; session_id: string; anchor_message_id: string;
      anchor_text: string; created_at: number; turns_json: string;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id, sessionId: r.session_id, anchorMessageId: r.anchor_message_id,
      anchorText: r.anchor_text, createdAt: r.created_at,
      turns: JSON.parse(r.turns_json) as SideChatTurn[],
    };
  }

  listSideChats(sessionId: string): SideChat[] {
    const ids = this.db.prepare(
      'SELECT id FROM side_chats WHERE session_id = ? ORDER BY created_at',
    ).all(sessionId) as { id: string }[];
    return ids.map(({ id }) => this.getSideChat(id)!);
  }

  appendSideChatTurn(id: string, turn: SideChatTurn): void {
    const chat = this.getSideChat(id);
    if (!chat) throw new Error(`side chat ${id} not found`);
    chat.turns.push(turn);
    this.db.prepare('UPDATE side_chats SET turns_json = ? WHERE id = ?')
      .run(JSON.stringify(chat.turns), id);
  }

  deleteSideChat(id: string): void {
    this.db.prepare('DELETE FROM side_chats WHERE id = ?').run(id);
  }

  /** Plain-text context of ±n messages around an anchor (api-responder fallback). */
  incrementStat(event: string, day = new Date().toISOString().slice(0, 10)): void {
    this.db.prepare(`
      INSERT INTO stats (day, event, count) VALUES (?, ?, 1)
      ON CONFLICT(day, event) DO UPDATE SET count = count + 1
    `).run(day, event);
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  private txn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => this.db.transaction(fn)(...args);
  }
}
