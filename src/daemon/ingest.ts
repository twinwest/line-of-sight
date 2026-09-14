import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { codexFingerprint, readCompressedCodex } from '../adapters/codexRollout.js';
import type { AgentAdapter } from '../adapters/types.js';
import { readConfig } from '../shared/config.js';
import type { NormalizedEvent } from '../shared/types.js';
import type { Store, StoredEvent } from '../store/store.js';

export type IngestListener = (sessionId: string, events: StoredEvent[], reset?: boolean) => void;

/** Files whose lines already produced a parse warning (log once per file). */
const warned = new Set<string>();

export class Ingester {
  private watchers: FSWatcher[] = [];
  private listeners: IngestListener[] = [];
  private queue = Promise.resolve();
  private rechecks = new Map<string, NodeJS.Timeout>();

  constructor(
    private store: Store,
    private adapters: AgentAdapter[],
    private log: (msg: string) => void = () => {},
    // read per event, like the responder settings: no daemon restart to flip it
    private keepSideChats: () => boolean = () => readConfig().keepSideChats === true,
  ) {}

  onEvents(fn: IngestListener): void { this.listeners.push(fn); }

  /** Scan all roots once, then watch for changes. */
  start(): void {
    for (const adapter of this.adapters) {
      for (const root of adapter.roots()) {
        const exists = fs.existsSync(root);
        if (!exists && adapter.id !== 'codex') continue;
        this.scanRoot(adapter, root);
        // Replaying initial Codex add events closes the gap between the
        // synchronous scan and asynchronous watcher setup. Checkpoints make
        // this idempotent, including roots first created during startup.
        const watchRoot = adapter.id === 'codex' ? path.dirname(root) : root;
        const watcher = chokidar.watch(watchRoot, {
          ignoreInitial: adapter.id !== 'codex',
          depth: adapter.id === 'codex' ? (adapter.watchDepth ?? 3) + 1 : adapter.watchDepth,
          // Watching the existing parent catches first directory creation.
          // `matches` below filters non-rollout Codex data before ingestion.
        });
        const onFile = (p: string) => {
          if (!adapter.matches(p)) return;
          this.enqueue(() => this.ingestQueued(adapter, p));
          // fs events coalesce: a write burst can land after our read
          // snapshot with no further event, orphaning the file's tail
          // (seen dropping codex's final message + task_complete). One
          // trailing recheck once the burst goes quiet picks it up.
          clearTimeout(this.rechecks.get(p));
          this.rechecks.set(p, setTimeout(() => {
            this.rechecks.delete(p);
            this.enqueue(() => this.ingestQueued(adapter, p));
          }, 1000));
        };
        watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
        if (adapter.id === 'codex') watcher.on('addDir', p => {
          // A first archive directory can be created after startup. Chokidar
          // may report the directory before it begins watching its children;
          // reconcile the snapshot so a file written in that window is seen.
          if (p !== watchRoot) void this.enqueue(() => this.scanRoot(adapter, root));
        });
        if (adapter.id === 'codex') watcher.on('ready', () => {
          // The parent subscription itself is asynchronous. Reconcile the
          // startup snapshot once it is installed, closing its event gap.
          void this.enqueue(() => this.scanRoot(adapter, root));
        });
        watcher.on('error', (err) => this.log(`watcher error: ${String(err)}`));
        this.watchers.push(watcher);
      }
    }
    this.store.prune(this.keepSideChats(), session => {
      const adapter = this.adapters.find(a => a.id === session.adapter);
      if (adapter?.id !== 'codex' || !adapter.resolveSessionFile) return false;
      // Codex ingestion either finds a surviving UUID source or confirms
      // its absence and deletes it. An I/O error is logged, never deletion.
      try {
        const resolved = adapter.resolveSessionFile(session.filePath, session.filePath);
        if (resolved?.endsWith('.zst')) void this.enqueue(() => this.ingestQueued(adapter, session.filePath));
        else this.ingestFile(adapter, session.filePath);
      } catch (e) { this.log(`Codex reconciliation failed: ${String(e)}`); }
      return true;
    }, false);
    // Schema rebuild retains chats while compressed session rows are queued.
    // The final pass still resolves Codex paths: a failed decode may retain a
    // valid view whose old path is gone, while its compressed replacement is
    // present on disk.
    void this.enqueue(() => this.store.prune(this.keepSideChats(), session => {
      const adapter = this.adapters.find(a => a.id === session.adapter);
      if (adapter?.id !== 'codex' || !adapter.resolveSessionFile) return false;
      try {
        const resolved = adapter.resolveSessionFile(session.filePath, session.filePath);
        if (!resolved) return false;
        if (resolved.endsWith('.zst')) void this.enqueue(() => this.ingestQueued(adapter, session.filePath));
        return true;
      } catch (e) {
        this.log(`Codex reconciliation failed: ${String(e)}`);
        return true;
      }
    }));
  }

  private scanRoot(adapter: AgentAdapter, root: string): void {
    try {
      if (!fs.existsSync(root)) return;
      if (fs.statSync(root).isFile()) {
        if (adapter.matches(root)) this.ingestFile(adapter, root);
      } else {
        const files = fs.readdirSync(root, { withFileTypes: true, recursive: true })
          .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
        if (adapter.id === 'codex') files.sort();
        for (const filePath of files) if (adapter.matches(filePath)) {
          if (adapter.id === 'codex' && filePath.endsWith('.zst')) void this.enqueue(() => this.ingestQueued(adapter, filePath));
          else this.ingestFile(adapter, filePath);
        }
      }
    } catch (e) {
      if (adapter.id !== 'codex') throw e;
      this.log(`Codex scan failed for ${root}: ${String(e)}`);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()));
    for (const t of this.rechecks.values()) clearTimeout(t);
    this.rechecks.clear();
    let pending = this.queue;
    for (;;) {
      await pending;
      if (pending === this.queue) return;
      pending = this.queue;
    }
  }

  /** Serialize ingest work so concurrent fs events can't interleave on one file. */
  private enqueue(fn: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, (e) => this.log(`ingest error: ${String(e)}`));
    return this.queue;
  }

  /** Ingest one file by path, whichever adapter claims it (queued like fs events). */
  async reingest(filePath: string): Promise<void> {
    const adapter = this.adapters.find((a) => a.matches(filePath));
    if (!adapter) return;
    let pending = this.enqueue(() => this.ingestQueued(adapter, filePath));
    // A source that moves during the read can enqueue a resolver retry.
    // Await that work too before Ask takes its fresh session snapshot.
    for (;;) {
      await pending;
      if (pending === this.queue) return;
      pending = this.queue;
    }
  }

  ingestFile(adapter: AgentAdapter, filePath: string): void | Promise<void> {
    return this.runIngest(adapter, filePath, false);
  }

  private ingestQueued(adapter: AgentAdapter, filePath: string): void | Promise<void> {
    return this.runIngest(adapter, filePath, true);
  }

  private runIngest(adapter: AgentAdapter, filePath: string, queued: boolean): void | Promise<void> {
    try {
      const pending = this.ingestFileInner(adapter, filePath, queued);
      if (pending) return pending.catch(e => this.ingestError(adapter, filePath, e));
    } catch (e) { this.ingestError(adapter, filePath, e); }
  }

  private ingestError(adapter: AgentAdapter, filePath: string, e: unknown): void {
    this.log(`ingest failed for ${filePath}: ${String(e)}`);
    if (adapter.id === 'codex' && (e as NodeJS.ErrnoException).code === 'ENOENT') void this.reingest(filePath);
  }

  private ingestFileInner(adapter: AgentAdapter, filePath: string, queued: boolean): void | Promise<void> {
    let restored: { events: NormalizedEvent[]; consumed: number } | undefined;
    if (adapter.id === 'codex' && !adapter.patchFile?.(filePath) && adapter.resolveSessionFile) {
      const id = adapter.sessionMeta(filePath, []).id;
      const bound = this.store.getSession(id);
      if (bound && bound.adapter !== 'codex') throw new Error(`session UUID collision: ${id}`);
      const resolved = adapter.resolveSessionFile(filePath, bound?.filePath);
      if (!resolved) {
        if (bound) this.store.deleteSession(id, this.keepSideChats());
        return;
      }
      if (resolved !== filePath && fs.existsSync(filePath)) {
        this.log(`duplicate Codex rollout ${id}: keeping ${resolved}, ignoring ${filePath}`);
      }
      filePath = resolved;
      if (filePath.endsWith('.zst')) {
        return queued ? this.ingestCompressed(adapter, filePath, id)
          : this.enqueue(() => this.ingestQueued(adapter, filePath));
      }
      if (bound) {
        const stat = fs.statSync(filePath);
        const sourceKey = `${stat.dev}:${stat.ino}`;
        const priorSource = this.store.getKv(`codex-source:${id}`);
        if ((priorSource && priorSource !== sourceKey) || (!priorSource && bound.filePath !== filePath)) {
          // Validate restoration before binding can discard the last valid view.
          try { restored = this.parseFrom(adapter, filePath, 0, stat.size); }
          catch (e) {
            this.store.setKv(`codex-error:${id}`, `Cannot read restored Codex transcript: ${String(e).slice(0, 300)}`);
            this.log(`Codex restoration failed: ${String(e)}`);
            return;
          }
        }
        this.store.bindCodexSessionFile(id, filePath, sourceKey);
      }
    }
    if (!fs.existsSync(filePath)) {
      // The selected Codex source may move again after resolution/binding.
      // Retry through its UUID resolver, never delete by that stale path.
      if (adapter.id === 'codex' && !adapter.patchFile?.(filePath) && adapter.resolveSessionFile) {
        void this.reingest(filePath);
        return;
      }
      // the viewer renders what is on disk (SPEC B9): a transcript that went
      // away takes its session with it. Reached from the unlink watcher, and
      // from a reingest of a session whose file has since gone.
      const gone = this.store.getSessionByPath(filePath);
      if (gone) this.store.deleteSession(gone.id, this.keepSideChats());
      return;
    }
    if (adapter.patchFile?.(filePath)) return this.ingestPatchFile(adapter, filePath);
    const size = fs.statSync(filePath).size;
    let session = this.store.getSessionByPath(filePath);
    if (session && size < session.byteOffset) {
      this.log(`${filePath} shrank; re-parsing from 0`);
      this.store.resetSession(session.id);
      session = { id: session.id, byteOffset: 0 };
    }
    const offset = session?.byteOffset ?? 0;
    if (size <= offset && !restored) return;

    const { events, consumed } = restored ?? this.parseFrom(adapter, filePath, offset, size);
    if (adapter.id === 'codex') {
      const id = adapter.sessionMeta(filePath, []).id;
      for (const prefix of ['codex-error:', 'codex-failed:', 'codex-fingerprint:']) {
        this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(`${prefix}${id}`);
      }
    }
    if (!session) {
      const meta = adapter.sessionMeta(filePath, events.slice(0, 5));
      this.store.upsertSession(meta);
      if (adapter.id === 'codex') {
        const stat = fs.statSync(filePath);
        this.store.bindCodexSessionFile(meta.id, filePath, `${stat.dev}:${stat.ino}`);
      }
      session = { id: meta.id, byteOffset: 0 };
    }
    if (consumed === 0) return;
    for (const e of events) {
      if (e.kind !== 'message') continue;
      if (e.workflowRun) this.store.noteWorkflowRun(session.id, e.workflowRun.toolUseId, e.workflowRun.runId, e.workflowRun.name);
      if (e.taskEnd) this.store.endChildren(session.id, e.taskEnd, e.ts);
    }
    const stored = this.store.appendEvents(session.id, events, offset + consumed);
    // A new rollout can arrive after its name was already indexed. Replay
    // the tiny title carrier so first archive creation gets its AI title too.
    if (adapter.id === 'codex' && offset === 0) {
      for (const root of adapter.roots()) {
        if (adapter.patchFile?.(root) && fs.existsSync(root)) this.ingestPatchFile(adapter, root);
      }
    }
    if (stored.length) for (const fn of this.listeners) fn(session.id, stored);
  }

  private async ingestCompressed(adapter: AgentAdapter, filePath: string, id: string): Promise<void> {
    const fingerprint = codexFingerprint(filePath);
    const stat = fs.statSync(filePath);
    const sourceKey = `zst:${stat.dev}:${stat.ino}`;
    if (this.store.getKv(`codex-failed:${id}`) === fingerprint) return;
    if (this.store.getKv(`codex-fingerprint:${id}`) === fingerprint && this.store.getSession(id)) {
      this.store.bindCodexSessionFile(id, filePath, sourceKey);
      return;
    }
    let meta = adapter.sessionMeta(filePath, []);
    let staging = false;
    try {
      this.store.beginCodexReplay(meta); staging = true;
      let first = true;
      let unknown = false;
      const decoded = await readCompressedCodex(filePath, async lines => {
        const events: NormalizedEvent[] = [];
        for (const line of lines) if (line.text.trim()) {
          events.push(...adapter.parseLine(line.text, { filePath, byteOffset: line.byteOffset }));
        }
        if (first && events.length) { meta = adapter.sessionMeta(filePath, events.slice(0, 5)); first = false; }
        unknown ||= events.some(e => e.kind === 'unknown');
        const last = lines.at(-1);
        const offset = last ? last.byteOffset + Buffer.byteLength(last.text) + 1 : 0;
        this.store.stageCodexEvents(id, events, offset);
        // Let HTTP/SSE work run between bounded parse/database batches.
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      if (codexFingerprint(filePath) !== decoded.fingerprint || adapter.resolveSessionFile?.(filePath, filePath) !== filePath) {
        void this.reingest(filePath);
        return; // Discard staging; a rename/restore must pass through source selection again.
      }
      this.store.db.prepare('UPDATE codex_replay.sessions SET byte_offset = ? WHERE id = ?').run(decoded.consumed, id);
      this.store.commitCodexReplay(meta, sourceKey, decoded.fingerprint);
      if (unknown && !warned.has(filePath)) {
        warned.add(filePath); this.log(`unrecognized line(s) in ${filePath} (rendering raw)`);
      }
      this.store.db.prepare('DELETE FROM kv WHERE key = ?').run(`codex-failed:${id}`);
      for (const root of adapter.roots()) if (adapter.patchFile?.(root) && fs.existsSync(root)) this.ingestPatchFile(adapter, root);
      // A replacement is atomically visible. Bound notifications to a tail,
      // rather than buffering/sending the entire decoded session over SSE.
      const stored = this.store.getEvents(id, { limit: 200 });
      for (const fn of this.listeners) fn(id, stored, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { void this.reingest(filePath); return; }
      try {
        const current = adapter.resolveSessionFile?.(filePath, this.store.getSession(id)?.filePath);
        if (!current || current !== filePath || codexFingerprint(current) !== fingerprint) {
          void this.reingest(filePath); return;
        }
      } catch { /* A read/discovery error is a diagnostic, never confirmed absence. */ }
      const error = `Cannot read compressed Codex transcript: ${e instanceof Error ? e.message.slice(0, 300) : 'decoder failed'}`;
      this.store.upsertSession(meta); // New corrupt sources appear as a passive error, never partial history.
      this.store.setKv(`codex-error:${id}`, error);
      this.store.setKv(`codex-failed:${id}`, fingerprint);
      this.log(error);
    } finally { if (staging) this.store.endCodexReplay(); }
  }

  /** Cross-session patch carrier: no session row, no offset — re-read whole
   *  on every change. The file is tiny and append-only, and replaying
   *  last-wins patches is idempotent; a patch for a session whose transcript
   *  lands later (dropped by patchSession) self-heals on the next pass. */
  private ingestPatchFile(adapter: AgentAdapter, filePath: string): void {
    const { events } = this.parseFrom(adapter, filePath, 0, fs.statSync(filePath).size);
    for (const e of events) {
      if (e.kind === 'meta' && e.sessionPatch?.sessionId) {
        this.store.patchSession(e.sessionPatch.sessionId, e.sessionPatch);
      }
    }
  }

  /** Read [offset, size), split complete lines (partial tail stays unconsumed). */
  private parseFrom(adapter: AgentAdapter, filePath: string, offset: number, size: number):
      { events: NormalizedEvent[]; consumed: number } {
    const fd = fs.openSync(filePath, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return { events: [], consumed: 0 };

    const events: NormalizedEvent[] = [];
    let lineStart = 0;
    while (lineStart <= lastNewline) {
      const nl = buf.indexOf(0x0a, lineStart);
      const line = buf.toString('utf8', lineStart, nl).replace(/\r$/, '');
      if (line.trim()) {
        const evs = adapter.parseLine(line, { filePath, byteOffset: offset + lineStart });
        if (evs.some((e) => e.kind === 'unknown') && !warned.has(filePath)) {
          warned.add(filePath);
          this.log(`unrecognized line(s) in ${filePath} (rendering raw)`);
        }
        events.push(...evs);
      }
      lineStart = nl + 1;
    }
    return { events, consumed: lastNewline + 1 };
  }
}
