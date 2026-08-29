#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PID_FILE, PORT, SIGHT_DIR } from '../shared/paths.js';

const DAEMON_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OPEN_COOLDOWN_MS = 6 * 3600 * 1000;

type Health = { ok: boolean; pid?: number; startedAt?: number; lastViewerOpen?: number };

async function health(timeoutMs = 500, includeLastOpen = false): Promise<Health> {
  try {
    const res = await fetch(`${URL_BASE}/api/health${includeLastOpen ? '?includeLastOpen=1' : ''}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as Health) : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A running daemon older than the build on disk keeps serving stale code
 *  silently (bit us three times in one day). Unknown ⇒ not stale. */
function stale(h: Health): boolean {
  try {
    return h.startedAt != null && fs.statSync(DAEMON_ENTRY).mtimeMs > h.startedAt;
  } catch {
    return false;
  }
}

/** SIGTERM a stale daemon and wait (briefly) for it to leave the port. */
async function retire(h: Health, timeoutMs: number): Promise<void> {
  if (h.pid == null) return;
  try { process.kill(h.pid, 'SIGTERM'); } catch { return; }
  for (let waited = 0; waited < timeoutMs && (await health(100)).ok; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function isSightDaemon(pid: number): boolean {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes('daemon/main.js');
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function spawnDaemon(): void {
  fs.mkdirSync(SIGHT_DIR, { recursive: true });
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function startDaemon(): Promise<boolean> {
  const h = await health();
  if (h.ok && !stale(h)) return true;
  if (h.ok) await retire(h, 2000);
  spawnDaemon();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if ((await health()).ok) return true;
  }
  return false;
}

function openBrowser(): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [URL_BASE], { detached: true, stdio: 'ignore' }).unref();
}

/** `sight claude|codex [args...]` — fail-open wrapper (SPEC B4, ARCHITECTURE §8).
 *  Steps 1–2 are best-effort with a hard time budget; step 3 always runs. */
async function wrap(agent: string, args: string[]): Promise<never> {
  try {
    const budget = new Promise<null>((r) => setTimeout(r, 1000, null));
    await Promise.race([budget, (async () => {
      let h = await health(300, true);
      if (h.ok && stale(h)) { await retire(h, 500); h = { ok: false }; }
      if (!h.ok) {
        spawnDaemon();
        // brief wait so a cold start can still get its viewer tab; if the
        // daemon isn't healthy in time, open nothing (a dead tab is worse)
        for (let i = 0; i < 4 && !h.ok; i++) {
          await new Promise((r) => setTimeout(r, 150));
          h = await health(200, true);
        }
      }
      if (h.ok) openBrowserMaybe(h.lastViewerOpen ?? 0);
    })()]);
  } catch { /* fail-open: never block the agent */ }

  const child = spawn(agent, args, { stdio: 'inherit' });
  child.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'ENOENT' ? `sight: '${agent}' not found on PATH` : String(e));
    process.exit(127);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { child.kill(sig); });
  }
  return new Promise<never>(() => {
    child.on('exit', (code, signal) => {
      process.exit(code ?? (signal ? 128 + 15 : 1));
    });
  });
}

function openBrowserMaybe(lastViewerOpen: number): void {
  if (Date.now() - lastViewerOpen > OPEN_COOLDOWN_MS) openBrowser();
}

async function cmdStart(): Promise<void> {
  const h = await health();
  if (h.ok && !stale(h)) { console.log(`daemon already running on port ${PORT}`); return; }
  if (h.ok) console.log('daemon predates the current build; restarting');
  const ok = await startDaemon();
  console.log(ok ? `daemon started on ${URL_BASE}` : 'daemon failed to start (see ~/.sight/daemon.log)');
  if (!ok) process.exitCode = 1;
}

async function cmdStop(): Promise<void> {
  const pid = readPid();
  const h = await health();
  const target = h.pid ?? pid;
  if (target == null) { console.log('daemon not running'); return; }
  // pidfile pids can be recycled by the OS — only SIGTERM a pid that is
  // actually our daemon (health-confirmed, or command line matches).
  if (h.pid == null && !isSightDaemon(target)) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log('daemon not running (removed stale pidfile)');
    return;
  }
  try {
    process.kill(target, 'SIGTERM');
    console.log(`sent SIGTERM to daemon (pid ${target})`);
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log('daemon not running (removed stale pidfile)');
  }
}

async function cmdStatus(): Promise<void> {
  const h = await health();
  if (h.ok) {
    console.log(`daemon running on ${URL_BASE} (pid ${h.pid})`);
  } else {
    const pid = readPid();
    console.log(pid ? `daemon not responding (stale pidfile, pid ${pid})` : 'daemon not running');
    process.exitCode = 1;
  }
}

async function cmdReingest(id: string | undefined): Promise<void> {
  if (!id) { console.error('usage: sight reingest <session-id>'); process.exitCode = 1; return; }
  if (!(await startDaemon())) { console.error('daemon not running'); process.exitCode = 1; return; }
  const res = await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(id)}/reingest`, { method: 'POST' });
  if (!res.ok) { console.error(`reingest failed: ${res.status}`); process.exitCode = 1; return; }
  const { sessions } = (await res.json()) as { sessions: number };
  console.log(`re-parsing ${sessions} transcript${sessions === 1 ? '' : 's'} (session + subagents)`);
}

async function cmdStats(): Promise<void> {
  // read the DB directly so stats work even with the daemon down
  const { Store } = await import('../store/store.js');
  const { DB_FILE } = await import('../shared/paths.js');
  const store = new Store(DB_FILE);
  const rows = store.getStats(14);
  store.close();
  if (!rows.length) { console.log('no stats recorded in the last 14 days'); return; }
  const days = [...new Set(rows.map((r) => r.day))].sort();
  console.log('day         viewer_open  question_asked');
  for (const day of days) {
    const get = (ev: string) => rows.find((r) => r.day === day && r.event === ev)?.count ?? 0;
    console.log(`${day}  ${String(get('viewer_open')).padStart(11)}  ${String(get('question_asked')).padStart(14)}`);
  }
  const total = (ev: string) => rows.filter((r) => r.event === ev).reduce((s, r) => s + r.count, 0);
  console.log(`totals      ${String(total('viewer_open')).padStart(11)}  ${String(total('question_asked')).padStart(14)}`);
}

/** `sight inspect <transcript.jsonl>` — headless: what the adapter makes of
 *  a file, for checking a new CLI version's format without the daemon. */
async function cmdInspect(file: string | undefined): Promise<void> {
  if (!file) { console.error('usage: sight inspect <transcript.jsonl>'); process.exitCode = 1; return; }
  const { claudeCodeAdapter } = await import('../adapters/claudeCode.js');
  const { codexAdapter } = await import('../adapters/codex.js');
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
  // a file outside the usual roots matches no adapter: take whichever
  // understands the most lines
  const parsed = [claudeCodeAdapter(), codexAdapter()].map((adapter) => ({
    adapter,
    events: lines.flatMap((line, i) => adapter.parseLine(line, { filePath: abs, byteOffset: i })),
  }));
  const { adapter, events } = parsed.find((p) => p.adapter.matches(abs))
    ?? parsed.sort((x, y) => x.events.filter((e) => e.kind === 'unknown').length
      - y.events.filter((e) => e.kind === 'unknown').length)[0]!;
  const meta = adapter.sessionMeta(abs, events.slice(0, 5));
  const title = meta.title || events.flatMap((e) => e.kind !== 'unknown' && e.sessionPatch?.title ? [e.sessionPatch.title] : [])[0] || '(untitled)';
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log(`${meta.id}  [${adapter.id}]  ${title}`);
  console.log(`events: ${events.length}  ${count(events.map((e) => e.kind === 'message' ? e.role : e.kind))}`);
  const tools = events.flatMap((e) => e.kind === 'message'
    ? e.blocks.flatMap((b) => b.type === 'tool_use' ? [b.toolName] : []) : []);
  if (tools.length) console.log(`tools: ${count(tools)}`);
  const unknown = events.filter((e) => e.kind === 'unknown');
  if (unknown.length) console.log(`unknown lines: ${count(unknown.map((e) => String((e.raw as { type?: unknown } | null)?.type ?? '?')))}`);
  const subDir = path.join(path.dirname(abs), path.basename(abs, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) {
    const kids = fs.readdirSync(subDir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && adapter.matches(path.join(e.parentPath, e.name)));
    console.log(`subagents: ${kids.length} (${count(kids.map((e) => path.basename(path.dirname(path.join(e.parentPath, e.name)))))})`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  // wrappers bypass arg parsing entirely — everything passes through untouched
  case 'claude':
  case 'codex':
    void wrap(cmd, rest);
    break;
  case 'start': void cmdStart(); break;
  case 'stop': void cmdStop(); break;
  case 'status': void cmdStatus(); break;
  case 'open':
    void (async () => { await startDaemon(); openBrowser(); })();
    break;
  case 'stats': void cmdStats(); break;
  case 'inspect': void cmdInspect(rest[0]); break;
  case 'reingest': void cmdReingest(rest[0]); break;
  default:
    console.log(`usage: sight <command>

  sight claude [args...]   run claude with the viewer alongside
  sight codex [args...]    run codex with the viewer alongside
  sight start|stop|status  daemon lifecycle
  sight open               open the viewer in the browser
  sight stats              dogfood usage stats (last 14 days)
  sight inspect <jsonl>    parse one transcript headlessly (format debugging)
  sight reingest <id>      re-parse a session and its subagents from scratch`);
    if (cmd !== undefined && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
}
