import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../shared/config.js';
import { composePrompt } from './prompt.js';
import { ANTHROPIC_OPTIONS, type Responder, type ResponderRequest } from './types.js';

// Read-only cage (product promise B5): no Write/Edit/Bash. WebFetch is also
// excluded — transcript content is untrusted, and WebFetch would let an
// injected prompt exfiltrate transcript text to an arbitrary URL.
// Belt and braces: --allowedTools auto-approves the read-only set (anything
// else is auto-denied in -p mode), and --disallowedTools hard-blocks every
// mutating/exfiltrating tool even if permission defaults ever change.
const ALLOWED_TOOLS = 'Read,Grep,Glob';
const DISALLOWED_TOOLS = 'Write,Edit,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch';

// Flags verified in M0 (SPIKE_NOTES S2): stream-json needs --verbose;
// answer text arrives as stream_event/content_block_delta/text_delta lines.
// prompt === null: the process is pre-spawned before the reader has typed the
// question and reads it from stdin later (SPIKE_NOTES S2, 2026-09-04). Same
// cage, same output format either way — only where the prompt comes from.
export const CLAUDE_ARGS = (prompt: string | null, opts: { model?: string; effort?: string } = {}): string[] => [
  '-p', ...(prompt === null ? ['--input-format', 'stream-json'] : [prompt]),
  '--allowedTools', ALLOWED_TOOLS,
  '--disallowedTools', DISALLOWED_TOOLS,
  // responder runs must not appear as sessions: the Q&A already lives in
  // side_chats (B6); without this the run writes its own transcript into
  // ~/.claude/projects/ and pollutes the session list
  '--no-session-persistence',
  // skip user/project settings: hooks, skills, and MCP servers are for the
  // user's interactive sessions, not this throwaway QA run — measured ~1.3s
  // off cold start; OAuth auth is unaffected (unlike --bare)
  '--setting-sources', '',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  ...(opts.model ? ['--model', opts.model] : []),
  ...(opts.effort ? ['--effort', opts.effort] : []),
];

interface StreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: unknown };
  result?: string;
  is_error?: boolean;
}

/** Extract answer text from one stream-json stdout line ('' if none). */
export function textFromStreamLine(line: string): string {
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(line) as StreamLine;
  } catch {
    return '';
  }
  if (parsed.type === 'stream_event'
      && parsed.event?.type === 'content_block_delta'
      && parsed.event.delta?.type === 'text_delta') {
    return parsed.event.delta.text ?? '';
  }
  return '';
}

/** Progress line for the panel: "Grep welcome page", "Read /path/to.jsonl" ('' if none).
 *  Complete tool_use blocks arrive on `assistant` snapshot lines. */
/** Tool verbs in reading language — the panel narrates ("searching the
 *  transcript"), it does not print commands (owner call, 2026-09-01). */
const VERBS: Record<string, string> = { Grep: 'searching', Glob: 'searching', Read: 'reading' };

/** Humanize the tool target: the session transcript (matched by its uuid
 *  basename, so offset-reads and subagent paths still hit) → "the
 *  transcript"; project files → repo-relative; other paths → basename;
 *  patterns/queries pass through. */
function statusTarget(arg: string, ctx?: { sessionFilePath?: string; projectDir?: string | null }): string {
  if (ctx?.sessionFilePath && arg.includes(path.basename(ctx.sessionFilePath, '.jsonl'))) {
    return 'the transcript';
  }
  if (ctx?.projectDir && arg.startsWith(`${ctx.projectDir}/`)) return arg.slice(ctx.projectDir.length + 1);
  return arg.startsWith('/') ? path.basename(arg) : arg;
}

export function statusFromStreamLine(line: string,
    ctx?: { sessionFilePath?: string; projectDir?: string | null }): string {
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(line) as StreamLine;
  } catch {
    return '';
  }
  if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content)) return '';
  for (const block of parsed.message.content as Record<string, unknown>[]) {
    if (block.type !== 'tool_use') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const arg = [input.file_path, input.path, input.pattern, input.query, input.command]
      .find((v) => typeof v === 'string') as string | undefined;
    const name = String(block.name ?? 'tool');
    const s = `${VERBS[name] ?? name} ${arg ? statusTarget(arg, ctx) : ''}`.trim();
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  }
  return '';
}

// ── Pre-spawn ──────────────────────────────────────────────────────────────
// A `claude -p` process spends ~1s booting node before it reads its prompt,
// and the API handshake only starts once the prompt arrives (measured
// 2026-09-04). So spawn when the side chat opens and hand the prompt over
// when the reader has finished typing: 1.3s to a trivial answer instead of
// 2.4s, on every first ask.
//
// ponytail: ONE slot, not a pool — the reader asks in the chat they just
// opened. A second chat evicts the first; per-chat processes if that ever
// stops being true.
const WARM_IDLE_MS = 60_000;

interface Warm { chatId: string; child: ChildProcessWithoutNullStreams; key: string; timer: NodeJS.Timeout }
let warm: Warm | null = null;

/** Model/effort at spawn time — a warm process pinned to stale settings must
 *  not answer a question asked after the reader changed them. */
function configKey(opts: { model?: string; effort?: string }): string {
  return `${opts.model ?? ''}|${opts.effort ?? ''}`;
}

/** Release the slot without killing: the process is already gone. */
function forget(child: ChildProcess): void {
  if (warm?.child !== child) return;   // a newer prewarm already took the slot
  clearTimeout(warm.timer);
  warm = null;
}

function dropWarm(): void {
  if (!warm) return;
  const { child, timer } = warm;
  warm = null;
  clearTimeout(timer);
  child.kill();
}

// the daemon exits via process.exit(), which does not reap children — without
// this a stopped daemon leaves a `claude` process waiting on a stdin nobody
// will ever write to
process.on('exit', () => { warm?.child.kill(); });

/** The warm process for this chat, or null — stale slot, dead process, or a
 *  config change since it spawned all mean "spawn cold instead". */
function takeWarm(chatId: string, key: string): ChildProcessWithoutNullStreams | null {
  if (!warm || warm.chatId !== chatId || warm.key !== key) return null;
  const { child, timer } = warm;
  if (child.exitCode !== null || child.signalCode !== null) return null;
  warm = null;
  clearTimeout(timer);
  return child;
}

/** Hand the prompt to a pre-spawned process as one stream-json user message.
 *  Returns null if it won't take it — the caller then spawns cold (fail-open:
 *  a broken standby is never a user-visible error). */
function feed(child: ChildProcessWithoutNullStreams | null, prompt: string):
    ChildProcessWithoutNullStreams | null {
  if (!child) return null;
  try {
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    return child;
  } catch {
    child.kill();
    return null;
  }
}

export const claudeCliResponder: Responder = {
  id: 'claude-cli',
  options: ANTHROPIC_OPTIONS,

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', ['claude'], (err) => resolve(!err));
    });
  },

  /** Spawn ahead of the question so node's boot happens while the reader
   *  types; the prompt goes in over stdin. Best-effort by construction — a
   *  failure here is silent and the ask spawns cold, as it always did. */
  prewarm(chatId: string, projectDir: string | null): void {
    dropWarm();
    const { responderModel, responderEffort } = readConfig();
    const opts = { model: responderModel, effort: responderEffort };
    let child: ChildProcessWithoutNullStreams;
    try {
      // default stdio is pipe on all three — stdin is the point of this spawn
      child = spawn('claude', CLAUDE_ARGS(null, opts), { cwd: projectDir ?? os.homedir() });
    } catch {
      return;
    }
    child.on('error', () => forget(child));   // claude missing or unspawnable
    child.on('exit', () => forget(child));
    child.stdin.on('error', () => {});        // a broken pipe must not reach the daemon
    const timer = setTimeout(dropWarm, WARM_IDLE_MS);
    timer.unref();
    warm = { chatId, child, key: configKey(opts), timer };
  },

  answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal,
         onStatus?: (s: string) => void): Promise<string> {
    const { responderModel, responderEffort } = readConfig();
    const opts = { model: responderModel, effort: responderEffort };
    const prompt = composePrompt(req);
    const hot = feed(takeWarm(req.chatId, configKey(opts)), prompt);
    const child = hot ?? spawn('claude', CLAUDE_ARGS(prompt, opts), {
      cwd: req.projectDir ?? os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    // cancel kills either way: the cold path gets it from spawn's `signal`,
    // but the warm process predates this AbortSignal
    if (hot) signal.addEventListener('abort', () => hot.kill(), { once: true });
    return new Promise((resolve, reject) => {
      let answer = '';
      let stderr = '';
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const text = textFromStreamLine(line);
          if (text) { answer += text; onChunk(text); continue; }
          const status = statusFromStreamLine(line, req);
          if (status) onStatus?.(status);
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', reject); // includes AbortError on signal
      child.on('close', (code) => {
        if (signal.aborted) return reject(new Error('canceled'));
        if (code !== 0 && !answer) {
          return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        }
        resolve(answer);
      });
    });
  },
};
