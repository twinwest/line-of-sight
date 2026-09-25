import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import type { AgentAdapter } from '../adapters/types.js';
import { readConfig } from '../shared/config.js';
import type { NormalizedEvent } from '../shared/types.js';
import type { Store, StoredEvent } from '../store/store.js';

export type IngestListener = (sessionId: string, events: StoredEvent[], reset?: boolean) => void;

/** Files whose lines already produced a parse warning (log once per file). */
const warned = new Set<string>();

// Plain transcripts are read in bounded pieces, like compressed ones: 1 MiB
// off the disk at a time, committed per ≤256 lines / ~512 KiB batch. Peak
// memory follows the batch, not the transcript (a whole-file read cost
// +250 MB RSS on a 278 MB root, measured 2026-09-24), and a crash between
// batches resumes from the last committed line boundary.
const READ_CHUNK = 1 << 20;
const BATCH_LINES = 256;
const BATCH_BYTES = 512 * 1024;

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
      const roots = adapter.roots();
      for (const root of roots) this.scanRoot(adapter, root);
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
      const watch = (dir: string, opts: ChokidarOptions) => {
        const watcher = chokidar.watch(dir, { ignoreInitial: true, ...opts });
        watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
        watcher.on('error', (err) => this.log(`watcher error: ${String(err)}`));
        this.watchers.push(watcher);
        return watcher;
      };
      if (adapter.resolveSessionFile) {
        // Relocatable transcripts: roots can appear after startup (codex's
        // first archive), so watch their shared parent — ONE watcher, scoped
        // to the roots: chokidar 4's kqueue fallback holds an fd per watched
        // file, and ~/.codex also holds databases, caches and the locks.
        const inRoots = (p: string) => roots.some(r => p === r || p.startsWith(r + path.sep));
        for (const parent of new Set(roots.map(r => path.dirname(r)))) {
          const watcher = watch(parent, { depth: (adapter.watchDepth ?? 3) + 1,
            ignored: p => p !== parent && !inRoots(p) });
          // A root created later can be reported before its children are
          // watched, and the subscription itself is async: rescan both times.
          watcher.on('addDir', p => { if (roots.includes(p)) void this.enqueue(() => this.scanRoot(adapter, p)); });
          watcher.on('ready', () => void this.enqueue(() => { for (const r of roots) this.scanRoot(adapter, r); }));
        }
      } else {
        for (const root of roots) if (fs.existsSync(root)) watch(root, { depth: adapter.watchDepth });
      }
    }
    // Prune once the scan and every compressed replay it queued have landed
    // (a schema rebuild's side chats would otherwise look orphaned while
    // their sessions are still in the queue). A relocatable session whose
    // path is gone gets one more resolution: an offline move the scan did
    // not rebind, or an unreadable directory — an error keeps the session,
    // only confirmed absence deletes it (inside ingestFileInner).
    void this.enqueue(() => this.store.prune(this.keepSideChats(), session => {
      const adapter = this.adapters.find(a => a.id === session.adapter);
      if (!adapter?.resolveSessionFile) return false;
      this.ingestFile(adapter, session.filePath);
      return true;
    }));
  }

  /** Queue every transcript under a root, one job per file: the daemon
   *  answers HTTP between files instead of after the whole root (a
   *  synchronous scan of 278 MB held the loop 6–7 s, measured 2026-09-24,
   *  past the wrapper's 1 s health budget — the viewer tab never opened). */
  private scanRoot(adapter: AgentAdapter, root: string): void {
    try {
      if (!fs.existsSync(root)) return;
      if (fs.statSync(root).isFile()) {
        if (adapter.matches(root)) void this.enqueue(() => this.ingestQueued(adapter, root));
      } else {
        const files = fs.readdirSync(root, { withFileTypes: true, recursive: true })
          .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
        if (adapter.resolveSessionFile) files.sort();   // deterministic duplicate selection
        for (const filePath of files) {
          if (adapter.matches(filePath)) void this.enqueue(() => this.ingestQueued(adapter, filePath));
        }
      }
    } catch (e) {
      if (!adapter.resolveSessionFile) throw e;   // a relocatable root may be absent or mid-move
      this.log(`scan failed for ${root}: ${String(e)}`);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()));
    for (const t of this.rechecks.values()) clearTimeout(t);
    this.rechecks.clear();
    await this.idle();
  }

  /** Resolves once every queued job — including any a job enqueued while
   *  running, e.g. a resolver retry — has finished. */
  async idle(): Promise<void> {
    let pending = this.queue;
    for (;;) {
      await pending;
      if (pending === this.queue) return;
      pending = this.queue;
    }
  }

  /** Serialize ingest work so concurrent fs events can't interleave on one
   *  file. Each job starts on a fresh macrotask, so I/O callbacks (health
   *  probes, SSE writes, fs events) get the loop between jobs. */
  private enqueue(fn: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(fn, (e) => this.log(`ingest error: ${String(e)}`));
    return this.queue;
  }

  /** Ingest one file by path, whichever adapter claims it (queued like fs
   *  events); resolves once the queue is idle — a source that moves during
   *  the read enqueues a resolver retry, and Ask must see that too. */
  async reingest(filePath: string): Promise<void> {
    const adapter = this.adapters.find((a) => a.matches(filePath));
    if (!adapter) return;
    void this.enqueue(() => this.ingestQueued(adapter, filePath));
    await this.idle();
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
    if (adapter.resolveSessionFile && (e as NodeJS.ErrnoException).code === 'ENOENT') void this.reingest(filePath);
  }

  private ingestFileInner(adapter: AgentAdapter, filePath: string, queued: boolean): void | Promise<void> {
    if (adapter.patchFile?.(filePath)) {
      if (fs.existsSync(filePath)) this.ingestPatchFile(adapter, filePath);
      return;
    }
    // Relocatable transcripts (codex): the session follows its UUID, not
    // its path. Whatever file holds the UUID now is its source; a source
    // that moved, or was replaced by a copy, is rebound and reparsed from
    // zero — 80 ms for the largest local rollout (SPIKE_NOTES 2026-09-23),
    // and ids are content-derived, so side-chat anchors survive.
    let rebind: string | null = null;
    if (adapter.resolveSessionFile) {
      const id = adapter.sessionMeta(filePath, []).id;
      const bound = this.store.getSession(id);
      if (bound && bound.adapter !== adapter.id) throw new Error(`session UUID collision: ${id}`);
      // throws on an unreadable directory: logged by the caller, nothing deleted
      const resolved = adapter.resolveSessionFile(filePath, bound?.filePath);
      if (!resolved) {
        if (bound) this.store.deleteSession(id, this.keepSideChats());
        return;
      }
      if (resolved !== filePath && fs.existsSync(filePath)) {
        this.log(`duplicate transcript ${id}: keeping ${resolved}, ignoring ${filePath}`);
      }
      filePath = resolved;
      if (bound && bound.filePath !== filePath) rebind = id;
      if (adapter.compressed?.matches(filePath)) {
        return queued ? this.ingestCompressed(adapter, filePath, id)
          : this.enqueue(() => this.ingestQueued(adapter, filePath));
      }
    }
    if (!fs.existsSync(filePath)) {
      // A relocatable source may move again after resolution. Retry
      // through its resolver, never delete by that stale path.
      if (adapter.resolveSessionFile) {
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
    const size = fs.statSync(filePath).size;
    let session = rebind ? null : this.store.getSessionByPath(filePath);
    if (session && size < session.byteOffset) {
      this.log(`${filePath} shrank; re-parsing from 0`);
      this.store.resetSession(session.id);
      session = { id: session.id, byteOffset: 0 };
    }
    const offset = session?.byteOffset ?? 0;
    if (session && size <= offset) return;

    const id = rebind ?? session?.id ?? adapter.sessionMeta(filePath, []).id;
    const batches = this.readBatches(adapter, filePath, offset, size);
    // Each batch commits with its checkpoint; an append is visible to
    // viewers batch by batch (the shape of a live session anyway).
    const step = ({ events, consumed }: { events: NormalizedEvent[]; consumed: number }): void => {
      if (!session) {
        this.store.upsertSession(adapter.sessionMeta(filePath, events.slice(0, 5)));
        session = { id, byteOffset: 0 };
      }
      for (const e of events) {
        if (e.kind !== 'message') continue;
        if (e.workflowRun) this.store.noteWorkflowRun(id, e.workflowRun.toolUseId, e.workflowRun.runId, e.workflowRun.name);
        if (e.taskEnd) this.store.endChildren(id, e.taskEnd, e.ts);
      }
      const stored = this.store.appendEvents(id, events, offset + consumed);
      if (!rebind && stored.length) for (const fn of this.listeners) fn(id, stored);
    };
    const finish = (): void => {
      // a file with no complete line yet is still a session (its tail is
      // re-read once the newline arrives)
      if (!session) this.store.upsertSession(adapter.sessionMeta(filePath, []));
      this.store.recountMessages(id);
      // A new rollout can arrive after its name was already indexed. Replay
      // the tiny title carrier so first archive creation gets its AI title too.
      if (offset === 0) {
        for (const root of adapter.roots()) {
          if (adapter.patchFile?.(root) && fs.existsSync(root)) this.ingestPatchFile(adapter, root);
        }
      }
    };
    if (rebind) {
      // one transaction, no yielding inside it: the previous rows go only if
      // the whole file reads. An unreadable replacement leaves the previous
      // view bound to its old path, with a passive error that shows in the
      // viewer and blocks Ask. ponytail: a move of a very large rollout
      // blocks for its parse; stage it if that is ever measured to matter.
      try {
        this.store.replaceSession(id, filePath, () => { session = { id, byteOffset: 0 }; for (const b of batches) step(b); });
      } catch (e) {
        this.store.setSourceError(id, null, `Cannot read restored Codex transcript: ${String(e).slice(0, 300)}`);
        this.log(`Codex restoration failed: ${String(e)}`);
        return;
      }
      finish();
      // the view was replaced, not appended: viewers reload from a tail
      // rather than receive the whole session over SSE
      for (const fn of this.listeners) fn(id, this.store.getEvents(id, { limit: 200 }), true);
      return;
    }
    if (!queued) {
      // direct callers (tests, the start-up prune's second look) read whole
      for (const b of batches) step(b);
      finish();
      return;
    }
    // queued (scan, fs events): the loop gets a turn between batches, so a
    // large file does not hold health probes and SSE for its whole parse
    return (async () => {
      for (const b of batches) {
        step(b);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      finish();
    })();
  }

  private async ingestCompressed(adapter: AgentAdapter, filePath: string, id: string): Promise<void> {
    const compressed = adapter.compressed!;
    const fingerprint = compressed.fingerprint(filePath);
    // Same physical file as last time: nothing to replay — whether it
    // replayed fine at this path, or failed (wherever it sits now). A rename
    // changes ctime, so archive/unarchive replay anyway (85 ms measured).
    const current = this.store.getSession(id);
    if (current && this.store.sourceStamp(id) === fingerprint
        && (current.sourceError || current.filePath === filePath)) return;
    let meta = adapter.sessionMeta(filePath, []);
    let staging = false;
    try {
      this.store.beginCodexReplay(meta); staging = true;
      let first = true;
      let unknown = false;
      const decoded = await compressed.read(filePath, async lines => {
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
      if (compressed.fingerprint(filePath) !== decoded.fingerprint || adapter.resolveSessionFile?.(filePath, filePath) !== filePath) {
        void this.reingest(filePath);
        return; // Discard staging; a rename/restore must pass through source selection again.
      }
      this.store.db.prepare('UPDATE codex_replay.sessions SET byte_offset = ? WHERE id = ?').run(decoded.consumed, id);
      this.store.commitCodexReplay(meta, decoded.fingerprint);
      if (unknown && !warned.has(filePath)) {
        warned.add(filePath); this.log(`unrecognized line(s) in ${filePath} (rendering raw)`);
      }
      for (const root of adapter.roots()) if (adapter.patchFile?.(root) && fs.existsSync(root)) this.ingestPatchFile(adapter, root);
      // A replacement is atomically visible. Bound notifications to a tail,
      // rather than buffering/sending the entire decoded session over SSE.
      const stored = this.store.getEvents(id, { limit: 200 });
      for (const fn of this.listeners) fn(id, stored, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { void this.reingest(filePath); return; }
      try {
        const current = adapter.resolveSessionFile?.(filePath, this.store.getSession(id)?.filePath);
        if (!current || current !== filePath || compressed.fingerprint(current) !== fingerprint) {
          void this.reingest(filePath); return;
        }
      } catch { /* A read/discovery error is a diagnostic, never confirmed absence. */ }
      const error = `Cannot read compressed transcript: ${e instanceof Error ? e.message.slice(0, 300) : 'decoder failed'}`;
      this.store.upsertSession(meta); // New corrupt sources appear as a passive error, never partial history.
      this.store.setSourceError(id, fingerprint, error);
      this.log(error);
    } finally { if (staging) this.store.endCodexReplay(); }
  }

  /** Cross-session patch carrier: no session row, no offset — re-read whole
   *  on every change. The file is tiny and append-only, and replaying
   *  last-wins patches is idempotent; a patch for a session whose transcript
   *  lands later (dropped by patchSession) self-heals on the next pass. */
  private ingestPatchFile(adapter: AgentAdapter, filePath: string): void {
    for (const { events } of this.readBatches(adapter, filePath, 0, fs.statSync(filePath).size)) {
      for (const e of events) {
        if (e.kind === 'meta' && e.sessionPatch?.sessionId) {
          this.store.patchSession(e.sessionPatch.sessionId, e.sessionPatch);
        }
      }
    }
  }

  /** Read [offset, size) in READ_CHUNK pieces and yield the parsed events
   *  per batch, with `consumed` = bytes from `offset` up to the end of the
   *  batch's last complete line (the checkpoint). A partial last line stays
   *  unconsumed. A batch with lines but no events (all dropped) is still
   *  yielded, so the checkpoint advances. */
  private *readBatches(adapter: AgentAdapter, filePath: string, offset: number, size: number):
      Generator<{ events: NormalizedEvent[]; consumed: number }> {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(size - offset, 1)));
      let carry = Buffer.alloc(0);    // partial line left by the previous chunk
      let pos = offset;               // absolute position of carry[0] / data[0]
      let read = 0;
      let events: NormalizedEvent[] = [];
      let lines = 0, bytes = 0, consumed = 0;
      while (read < size - offset) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset - read), offset + read);
        if (n === 0) break;
        read += n;
        const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        let start = 0;
        for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, start)) {
          const line = data.toString('utf8', start, nl).replace(/\r$/, '');
          if (line.trim()) {
            const evs = adapter.parseLine(line, { filePath, byteOffset: pos + start });
            if (evs.some((e) => e.kind === 'unknown') && !warned.has(filePath)) {
              warned.add(filePath);
              this.log(`unrecognized line(s) in ${filePath} (rendering raw)`);
            }
            events.push(...evs);
          }
          lines++;
          bytes += nl + 1 - start;
          consumed = pos + nl + 1 - offset;
          start = nl + 1;
          if (lines >= BATCH_LINES || bytes >= BATCH_BYTES) {
            yield { events, consumed };
            events = []; lines = 0; bytes = 0;
          }
        }
        carry = Buffer.from(data.subarray(start));   // copy: `chunk` is reused
        pos += start;
      }
      if (lines) yield { events, consumed };
    } finally {
      fs.closeSync(fd);
    }
  }
}
