#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { PID_FILE, PORT, SIGHT_DIR } from '../shared/paths.js';

const DAEMON_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

async function health(timeoutMs = 800): Promise<{ ok: boolean; pid?: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as { ok: boolean; pid: number }) : { ok: false };
  } catch {
    return { ok: false };
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

async function startDaemon(): Promise<boolean> {
  if ((await health()).ok) return true;
  fs.mkdirSync(SIGHT_DIR, { recursive: true });
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if ((await health()).ok) return true;
  }
  return false;
}

const program = new Command('sight');

program.command('start').description('start the daemon').action(async () => {
  if ((await health()).ok) { console.log(`daemon already running on port ${PORT}`); return; }
  const ok = await startDaemon();
  console.log(ok ? `daemon started on http://127.0.0.1:${PORT}` : 'daemon failed to start (see ~/.sight/daemon.log)');
  process.exit(ok ? 0 : 1);
});

program.command('stop').description('stop the daemon').action(async () => {
  const pid = readPid();
  const h = await health();
  if (!h.ok && pid === null) { console.log('daemon not running'); return; }
  const target = h.pid ?? pid;
  if (target == null) { console.log('daemon not running'); return; }
  // pidfile pids can be recycled by the OS — only SIGTERM a pid that is
  // actually our daemon (health-confirmed, or command line matches).
  const isOurs = h.pid != null || isSightDaemon(target);
  if (!isOurs) {
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
});

program.command('status').description('daemon status').action(async () => {
  const h = await health();
  if (h.ok) {
    console.log(`daemon running on http://127.0.0.1:${PORT} (pid ${h.pid})`);
  } else {
    const pid = readPid();
    console.log(pid ? `daemon not responding (stale pidfile, pid ${pid})` : 'daemon not running');
    process.exitCode = 1;
  }
});

program.parseAsync().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
