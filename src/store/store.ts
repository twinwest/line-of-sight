import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { NormalizedEvent, SessionMeta, SessionPatch, SideChat, SideChatTurn, StoredEvent, TitleSource } from '../shared/types.js';

export type { SideChat, StoredEvent };

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
  turns_json TEXT
);
CREATE TABLE IF NOT EXISTS stats (day TEXT, event TEXT, count INTEGER, PRIMARY KEY (day, event));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

/** Snippet match delimiters — control chars that can't collide with content. */
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

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

/** Searchable plain text of a message event. */
function textContent(ev: NormalizedEvent): string {
  if (ev.kind !== 'message') return '';
  return ev.blocks.map((b) => {
    switch (b.type) {
      case 'text': return b.markdown;
      case 'thinking': return b.text;
      case 'tool_result': return b.output;
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
    this.db.exec(SCHEMA);
    // columns added after the tables shipped — CREATE TABLE IF NOT EXISTS
    // leaves an existing db untouched, so add them here (throws once they are
    // already there, which is the fresh-db case)
    for (const col of ['parent_id TEXT', 'tool_use_id TEXT', 'workflow_id TEXT', 'ended_at INTEGER',
      'turn_open INTEGER', 'turn_started_at INTEGER']) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* present */ }
    }
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT');
      // the ALTER only succeeds on a db that predates the column, i.e. one
      // whose rows all have parent_id NULL — no tree, so no rewind branch
      // could ever be found. Rewind the checkpoints once so the next ingest
      // re-reads the transcripts and backfills (rows update in place; ids and
      // seqs are stable, so side-chat anchors survive).
      this.db.exec('UPDATE sessions SET byte_offset = 0');
    } catch { /* already there: nothing to backfill */ }
  }

  close(): void { this.db.close(); }

  getSessionByPath(filePath: string): { id: string; byteOffset: number } | null {
    const r = this.db.prepare('SELECT id, byte_offset FROM sessions WHERE file_path = ?')
      .get(filePath) as { id: string; byte_offset: number } | undefined;
    return r ? { id: r.id, byteOffset: r.byte_offset } : null;
  }

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
    let newMessages = 0;
    let lastTs = 0;
    const stored: StoredEvent[] = [];
    for (const ev of events) {
      // patch-only carriers (title lines: raw === null) update the session
      // but have nothing to display — no row, no SSE broadcast
      if (ev.kind === 'meta' && ev.raw === null) {
        if (ev.sessionPatch) this.applyPatch(sessionId, ev.sessionPatch);
        continue;
      }
      const role = ev.kind === 'message' ? ev.role : ev.kind;
      // meta events keep their display label alongside the raw payload
      const body = ev.kind === 'message' ? ev.blocks
        : ev.kind === 'meta' ? { label: ev.label, raw: ev.raw }
        : ev.raw;
      const parentId = ev.kind === 'unknown' ? null : ev.parentId ?? null;
      const r = insert.run(ev.id, sessionId, ++seq, role, ev.ts, JSON.stringify(body ?? null), textContent(ev), parentId);
      if (ev.kind === 'message' && r.changes > 0) newMessages++;
      // only real messages count as activity — trailing bookkeeping writes
      // (away_summary etc.) must not make an idle session look running
      if (ev.kind === 'message' && ev.ts > lastTs) lastTs = ev.ts;
      if (ev.kind !== 'unknown' && ev.sessionPatch) this.applyPatch(sessionId, ev.sessionPatch);
      stored.push({
        id: ev.id, seq, ts: ev.ts, kind: ev.kind,
        role: ev.kind === 'message' ? ev.role : null,
        body: body ?? null,
      });
    }
    this.db.prepare(`
      UPDATE sessions SET byte_offset = ?, message_count = message_count + ?,
        updated_at = MAX(updated_at, ?),
        started_at = CASE WHEN started_at = 0 THEN ? ELSE started_at END
      WHERE id = ?
    `).run(newByteOffset, newMessages, lastTs, events[0]?.ts ?? 0, sessionId);
    return stored;
  });

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
    const titleStmt = this.db.prepare('SELECT title FROM sessions WHERE id = ?');
    return (rows as { session_id: string; id: string; snip: string }[]).map((r) => ({
      sessionId: r.session_id,
      sessionTitle: (titleStmt.get(r.session_id) as { title: string } | undefined)?.title ?? '',
      messageId: r.id,
      snippet: r.snip,
    }));
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
    return chat;
  }

  getSideChat(id: string): SideChat | null {
    const r = this.db.prepare('SELECT * FROM side_chats WHERE id = ?').get(id) as {
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
  inlineContext(sessionId: string, anchorMessageId: string, n = 30, maxChars = 30_000): string {
    const anchor = this.db.prepare(
      'SELECT seq FROM messages WHERE session_id = ? AND id = ?',
    ).get(sessionId, anchorMessageId) as { seq: number } | undefined;
    if (!anchor) return '';
    const rows = this.db.prepare(`
      SELECT role, text_content FROM messages
      WHERE session_id = ? AND seq BETWEEN ? AND ? AND role IN ('user','assistant')
      ORDER BY seq
    `).all(sessionId, anchor.seq - n, anchor.seq + n) as { role: string; text_content: string }[];
    const text = rows.filter((r) => r.text_content)
      .map((r) => `[${r.role}]\n${r.text_content}`).join('\n\n');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

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

  getStats(days: number): { day: string; event: string; count: number }[] {
    return this.db.prepare(`
      SELECT day, event, count FROM stats WHERE day >= date('now', ?) ORDER BY day
    `).all(`-${days} days`) as { day: string; event: string; count: number }[];
  }

  private txn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => this.db.transaction(fn)(...args);
  }
}
