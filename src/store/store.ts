import Database from 'better-sqlite3';
import type { NormalizedEvent, SessionMeta, SessionPatch, StoredEvent, TitleSource } from '../shared/types.js';

export type { StoredEvent };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, adapter TEXT, file_path TEXT UNIQUE, project_dir TEXT,
  title TEXT DEFAULT '', title_source TEXT,
  started_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0,
  byte_offset INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT, session_id TEXT, seq INTEGER, role TEXT, ts INTEGER,
  blocks_json TEXT,
  text_content TEXT,
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
`;

const TITLE_PRIORITY: Record<TitleSource, number> = { prompt: 1, ai: 2, custom: 3 };

interface SessionRow {
  id: string; adapter: string; file_path: string; project_dir: string | null;
  title: string; title_source: TitleSource | null;
  started_at: number; updated_at: number; message_count: number; byte_offset: number;
}

function toMeta(r: SessionRow): SessionMeta {
  return {
    id: r.id, adapter: r.adapter as SessionMeta['adapter'], filePath: r.file_path,
    projectDir: r.project_dir, title: r.title,
    startedAt: r.started_at, updatedAt: r.updated_at, messageCount: r.message_count,
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
  }

  close(): void { this.db.close(); }

  getSessionByPath(filePath: string): { id: string; byteOffset: number } | null {
    const r = this.db.prepare('SELECT id, byte_offset FROM sessions WHERE file_path = ?')
      .get(filePath) as { id: string; byte_offset: number } | undefined;
    return r ? { id: r.id, byteOffset: r.byte_offset } : null;
  }

  upsertSession(meta: SessionMeta): void {
    this.db.prepare(`
      INSERT INTO sessions (id, adapter, file_path, project_dir, title, started_at, updated_at, message_count)
      VALUES (@id, @adapter, @filePath, @projectDir, @title, @startedAt, @updatedAt, @messageCount)
      ON CONFLICT(id) DO NOTHING
    `).run(meta);
  }

  /** Wipe a session's events for a from-zero re-parse (file shrank). */
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
      INSERT INTO messages (id, session_id, seq, role, ts, blocks_json, text_content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET blocks_json = excluded.blocks_json,
        text_content = excluded.text_content, ts = excluded.ts
    `);
    let seq = maxSeq;
    let newMessages = 0;
    let lastTs = 0;
    const stored: StoredEvent[] = [];
    for (const ev of events) {
      const role = ev.kind === 'message' ? ev.role : ev.kind;
      const body = ev.kind === 'message' ? ev.blocks : ev.raw;
      const r = insert.run(ev.id, sessionId, ++seq, role, ev.ts, JSON.stringify(body ?? null), textContent(ev));
      if (ev.kind === 'message' && r.changes > 0) newMessages++;
      if (ev.ts > lastTs) lastTs = ev.ts;
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

  listSessions(opts: { project?: string; q?: string } = {}): SessionMeta[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE (@project IS NULL OR project_dir = @project)
        AND (@q IS NULL OR title LIKE '%' || @q || '%')
      ORDER BY updated_at DESC
    `).all({ project: opts.project ?? null, q: opts.q ?? null }) as SessionRow[];
    return rows.map(toMeta);
  }

  getSession(id: string): SessionMeta | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? toMeta(r) : null;
  }

  getEvents(sessionId: string, opts: { beforeSeq?: number; limit?: number } = {}): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT id, seq, role, ts, blocks_json FROM messages
      WHERE session_id = ? AND seq < ?
      ORDER BY seq DESC LIMIT ?
    `).all(sessionId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 200) as
      { id: string; seq: number; role: string; ts: number; blocks_json: string }[];
    return rows.reverse().map((r) => ({
      id: r.id, seq: r.seq, ts: r.ts,
      kind: r.role === 'meta' || r.role === 'unknown' ? r.role : 'message',
      role: r.role === 'meta' || r.role === 'unknown' ? null : (r.role as 'user' | 'assistant'),
      body: JSON.parse(r.blocks_json) as unknown,
    }));
  }

  search(q: string): { sessionId: string; sessionTitle: string; messageId: string; snippet: string }[] {
    const query = q.trim();
    if (!query) return [];
    // trigram FTS needs >= 3 chars; shorter queries (common 2-char CJK words) use LIKE
    const rows = query.length >= 3
      ? this.db.prepare(`
          SELECT m.session_id, m.id, snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) snip
          FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ? ORDER BY rank LIMIT 100
        `).all(`"${query.replaceAll('"', '""')}"`)
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

  incrementStat(event: string, day = new Date().toISOString().slice(0, 10)): void {
    this.db.prepare(`
      INSERT INTO stats (day, event, count) VALUES (?, ?, 1)
      ON CONFLICT(day, event) DO UPDATE SET count = count + 1
    `).run(day, event);
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
