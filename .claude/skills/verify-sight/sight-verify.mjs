#!/usr/bin/env node
// Verification harness for Line of Sight: an isolated daemon (its own HOME and
// port, seeded from test/fixtures) plus a headless-Chrome driver.
// Usage and proof standards: SKILL.md next to this file.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// One knob isolates a second instance: the port also names the scratch dir.
const PORT = Number(process.env.SIGHT_VERIFY_PORT) || 2121;
const DIR = path.join(os.tmpdir(), `sight-verify-${PORT}`);
const HOME = path.join(DIR, 'home');
// One subdirectory per launch, so a run's proof is never mixed with an older run's.
const evidenceDir = (st) => path.join(DIR, 'evidence', st.run);
const STATE = path.join(DIR, 'state.json');
const BASE = `http://127.0.0.1:${PORT}`;
// Every path the daemon touches hangs off os.homedir(), so a fake HOME keeps
// the user's ~/.sight, ~/.claude and ~/.codex out of reach.
const ENV = { ...process.env, HOME, USERPROFILE: HOME, SIGHT_PORT: String(PORT) };
const DAEMON = path.join(REPO, 'dist/daemon/main.js');
const WEB = path.join(REPO, 'web/dist/index.html');

const SEEDS = {
  claude: {
    id: '51e24591-d70b-4877-b3cd-394d6dbe1db8',
    from: 'test/fixtures/claude-code/entries.jsonl',
    file: path.join(HOME, '.claude/projects/-verify-project/51e24591-d70b-4877-b3cd-394d6dbe1db8.jsonl'),
  },
  codex: {
    id: '01a0453c-0b30-79d0-af26-6ca053010714',
    from: 'test/fixtures/codex/entries.jsonl',
    file: path.join(HOME, '.codex/sessions/2026/08/27/rollout-2026-08-27T21-59-18-01a0453c-0b30-79d0-af26-6ca053010714.jsonl'),
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { console.error(msg); process.exit(1); };
const getJson = async (p) => {
  try {
    const res = await fetch(BASE + p, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
};
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// ponytail: `ps` is POSIX-only; swap for a health-pid match if Windows ever matters.
const isDaemon = (pid) => {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('daemon/main.js'); }
  catch { return false; }
};
const seeded = async () => {
  const ids = new Set(((await getJson('/api/sessions')) ?? []).map((s) => s.id));
  return Object.values(SEEDS).every((s) => ids.has(s.id));
};
const newestMtime = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).reduce((m, e) => Math.max(m, fs.statSync(path.join(e.parentPath, e.name)).mtimeMs), 0);

async function launch() {
  const st = readState();
  if (st && alive(st.pid)) die(`already launched (pid ${st.pid}); run doctor, or cleanup first`);
  if (!fs.existsSync(DAEMON) || !fs.existsSync(WEB)) die('no build: run `npm run build` first');
  if (await getJson('/api/health')) die(`port ${PORT} is taken; set SIGHT_VERIFY_PORT to another port`);
  fs.rmSync(HOME, { recursive: true, force: true });
  const run = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  fs.mkdirSync(evidenceDir({ run }), { recursive: true });
  for (const s of Object.values(SEEDS)) {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.copyFileSync(path.join(REPO, s.from), s.file);
  }
  const child = spawn(process.execPath, [DAEMON], { env: ENV, detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, run }));
  // Ready = both seeded sessions ingested, not merely the port answering.
  for (let i = 0; i < 100 && !(await seeded()); i++) await sleep(100);
  if (!(await seeded())) die(`daemon did not become ready; see ${path.join(HOME, '.sight/daemon.log')}, then run cleanup`);
  console.log(`ready: ${BASE}\nhome: ${HOME}\nevidence: ${evidenceDir({ run })}`);
}

async function doctor() {
  const st = readState();
  if (!st) die(`FAIL not launched (no ${STATE}); run launch`);
  const h = await getJson('/api/health');
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const built = fs.existsSync(DAEMON) && fs.existsSync(WEB);
  const checks = [
    ['daemon process alive', alive(st.pid), `pid ${st.pid} is gone; run cleanup, then launch`],
    [`port ${PORT} owned by our daemon`, h?.pid === st.pid, `health pid ${h?.pid} != launched pid ${st.pid}`],
    ['daemon version matches package.json', h?.version === version, `${h?.version} != ${version}`],
    ['build newer than src/', built && fs.statSync(DAEMON).mtimeMs >= newestMtime(path.join(REPO, 'src')), 'STALE BUILD: npm run build, then cleanup and launch'],
    ['build newer than web/src/', built && fs.statSync(WEB).mtimeMs >= newestMtime(path.join(REPO, 'web/src')), 'STALE BUILD: npm run build (the daemon serves web/dist from disk; no relaunch needed)'],
    ['daemon started after the build', built && !!h && h.startedAt >= fs.statSync(DAEMON).mtimeMs, 'daemon predates the build; cleanup, then launch'],
    ['seeded sessions ingested', await seeded(), 'seed sessions missing from /api/sessions'],
  ];
  for (const [name, ok, hint] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${hint}`}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

// Runs a Playwright script (stdin, or a file argument) against a fresh headless
// Chrome. In scope: page (baseURL = this instance), shot(name), select(locator), seeds.
async function drive(file) {
  const st = readState();
  if (!st) die('not launched; run launch first');
  const code = fs.readFileSync(file ?? 0, 'utf8');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    baseURL: BASE, viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  context.setDefaultTimeout(5000); // the app is local; a 30s wait only hides a wrong selector
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const shot = async (name) => {
    const f = path.join(evidenceDir(st), `${name}.png`);
    await page.screenshot({ path: f });
    console.log('evidence:', f);
  };
  // Select a single-line element's text with a real mouse drag: the Ask button
  // listens for mouseup, which a scripted Selection never fires.
  const select = async (locator) => {
    const b = await locator.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const q = r.getBoundingClientRect();
      return { x: q.x, y: q.y, w: q.width, h: q.height };
    });
    await page.mouse.move(b.x + 1, b.y + b.h / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w - 1, b.y + b.h / 2, { steps: 5 });
    await page.mouse.up();
  };
  const AsyncFunction = (async () => {}).constructor;
  try {
    await new AsyncFunction('page', 'shot', 'select', 'seeds', code)(page, shot, select, SEEDS);
  } catch (e) {
    await shot('failure').catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

// The built CLI against the isolated instance: `sight-verify.mjs sight status`.
function sight(args) {
  process.exit(spawnSync(process.execPath, [path.join(REPO, 'dist/cli/index.js'), ...args], { env: ENV, stdio: 'inherit' }).status ?? 1);
}

async function cleanup() {
  // Only pids recorded inside our own scratch dir, and only if they are a daemon.
  const st = readState();
  let pidFile = null;
  try { pidFile = Number(fs.readFileSync(path.join(HOME, '.sight/daemon.pid'), 'utf8')); } catch { /* none */ }
  for (const pid of new Set([st?.pid, pidFile].filter(Boolean))) {
    if (!alive(pid) || !isDaemon(pid)) continue;
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    console.log(alive(pid) ? `pid ${pid} did not exit` : `stopped daemon (pid ${pid})`);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.log(`removed ${HOME}\nevidence kept: ${st ? evidenceDir(st) : path.join(DIR, 'evidence')}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'launch': await launch(); break;
  case 'doctor': await doctor(); break;
  case 'drive': await drive(rest[0]); break;
  case 'sight': sight(rest); break;
  case 'cleanup': await cleanup(); break;
  default:
    console.log(`usage: sight-verify.mjs <command>
  launch            seed an isolated HOME from test/fixtures and start the daemon on port ${PORT}
  doctor            read-only health check of that instance (exit 1 on any FAIL)
  drive [file]      run a Playwright script (stdin or file) in headless Chrome; scope: page, shot(name), select(locator), seeds
  sight <args...>   run the built sight CLI against the isolated instance
  cleanup           stop the daemon this harness started and remove its HOME (evidence is kept)
SIGHT_VERIFY_PORT picks another port and scratch dir (default 2121).`);
    if (cmd && cmd !== '--help') process.exit(1);
}
