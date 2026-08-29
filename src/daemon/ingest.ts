import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentAdapter } from '../adapters/types.js';
import type { NormalizedEvent } from '../shared/types.js';
import type { Store, StoredEvent } from '../store/store.js';

export type IngestListener = (sessionId: string, events: StoredEvent[]) => void;

/** Files whose lines already produced a parse warning (log once per file). */
const warned = new Set<string>();

export class Ingester {
  private watchers: FSWatcher[] = [];
  private listeners: IngestListener[] = [];
  private queue = Promise.resolve();

  constructor(
    private store: Store,
    private adapters: AgentAdapter[],
    private log: (msg: string) => void = () => {},
  ) {}

  onEvents(fn: IngestListener): void { this.listeners.push(fn); }

  /** Scan all roots once, then watch for changes. */
  start(): void {
    for (const adapter of this.adapters) {
      for (const root of adapter.roots()) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
          if (!entry.isFile()) continue;
          const filePath = path.join(entry.parentPath, entry.name);
          if (adapter.matches(filePath)) this.ingestFile(adapter, filePath);
        }
        const watcher = chokidar.watch(root, { ignoreInitial: true, depth: adapter.watchDepth });
        const onFile = (p: string) => {
          if (adapter.matches(p)) this.enqueue(() => this.ingestFile(adapter, p));
        };
        watcher.on('add', onFile).on('change', onFile);
        watcher.on('error', (err) => this.log(`watcher error: ${String(err)}`));
        this.watchers.push(watcher);
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close()));
    await this.queue;
  }

  /** Serialize ingest work so concurrent fs events can't interleave on one file. */
  private enqueue(fn: () => void): void {
    this.queue = this.queue.then(fn, (e) => this.log(`ingest error: ${String(e)}`));
  }

  /** Ingest one file by path, whichever adapter claims it (queued like fs events). */
  reingest(filePath: string): void {
    const adapter = this.adapters.find((a) => a.matches(filePath));
    if (adapter) this.enqueue(() => this.ingestFile(adapter, filePath));
  }

  ingestFile(adapter: AgentAdapter, filePath: string): void {
    try {
      this.ingestFileInner(adapter, filePath);
    } catch (e) {
      this.log(`ingest failed for ${filePath}: ${String(e)}`);
    }
  }

  private ingestFileInner(adapter: AgentAdapter, filePath: string): void {
    const size = fs.statSync(filePath).size;
    let session = this.store.getSessionByPath(filePath);
    if (session && size < session.byteOffset) {
      this.log(`${filePath} shrank; re-parsing from 0`);
      this.store.resetSession(session.id);
      session = { id: session.id, byteOffset: 0 };
    }
    const offset = session?.byteOffset ?? 0;
    if (size <= offset) return;

    const { events, consumed } = this.parseFrom(adapter, filePath, offset, size);
    if (!session) {
      const meta = adapter.sessionMeta(filePath, events.slice(0, 5));
      this.store.upsertSession(meta);
      session = { id: meta.id, byteOffset: 0 };
    }
    if (consumed === 0) return;
    for (const e of events) {
      if (e.kind !== 'message') continue;
      if (e.workflowRun) this.store.noteWorkflowRun(session.id, e.workflowRun.toolUseId, e.workflowRun.runId);
      if (e.taskEnd) this.store.endChildren(session.id, e.taskEnd, e.ts);
    }
    const stored = this.store.appendEvents(session.id, events, offset + consumed);
    if (stored.length) for (const fn of this.listeners) fn(session.id, stored);
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
