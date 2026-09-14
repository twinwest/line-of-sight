import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CODEX_ASK_DEFAULTS, readConfig, responderSettings } from '../shared/config.js';
import { composePrompt } from './prompt.js';
import { CODEX_OPTIONS, type Responder, type ResponderRequest } from './types.js';

// Read-only cage (product promise B5): --sandbox read-only is enforced by
// codex's own sandbox — verified via a forced write attempt (blocked, file
// not created; SPIKE_NOTES 2026-08-27). --ephemeral keeps responder runs
// out of ~/.codex/sessions — the --no-session-persistence analog (without
// it every ask would appear as a session, the M5 pollution lesson).
// --json streams item-level events on stdout. Model and effort are always
// supplied from Sight's Codex-only Ask settings so the main session's config
// cannot leak into the side channel.
export const CODEX_ARGS = (prompt: string,
    opts: { model?: string; effort?: string } = {}): string[] => [
  'exec',
  '--model', opts.model ?? CODEX_ASK_DEFAULTS.model,
  '--config', `model_reasoning_effort="${opts.effort ?? CODEX_ASK_DEFAULTS.effort}"`,
  '--sandbox', 'read-only',
  '--ephemeral',
  '--json',
  '--skip-git-repo-check',   // projectDir may not be a git repo; home never is
  prompt,
];

interface JsonEvent {
  type?: string;
  item?: { type?: string; text?: string; command?: string };
}

/** Only Codex sees this decoder instruction; Claude's prompt/tools stay intact. */
export function codexPrompt(req: ResponderRequest): string {
  if (!req.sessionFilePath.endsWith('.jsonl.zst')) return composePrompt(req);
  const helper = fileURLToPath(new URL('./readCodexRollout.js', import.meta.url));
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(helper)} ${quote(req.sessionFilePath)}`;
  return composePrompt(req,
    `The full transcript is zstd-compressed at ${req.sessionFilePath}. Read its complete decoded JSONL through this bundled read-only command: ${command}. ` +
    `Use a pipeline with pipefail and rg/sed to locate relevant records, timestamps, or line ranges. ` +
    `No system zstd executable is needed. Never write a decompressed file or restore/resume the agent session. ` +
    `If decoding fails, state that source evidence is unavailable; partial output is not a complete transcript.`,
  );
}

function parse(line: string): JsonEvent | null {
  try {
    return JSON.parse(line) as JsonEvent;
  } catch {
    return null;
  }
}

/** Answer text from one --json stdout line ('' if none). The stream has no
 *  token deltas — completed `agent_message` items ARE the answer, arriving
 *  as item-sized chunks (including any "I'll look at…" preamble prose,
 *  which claude's delta stream also includes). */
export function textFromJsonLine(line: string): string {
  const ev = parse(line);
  if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message'
      && typeof ev.item.text === 'string') {
    return ev.item.text;
  }
  return '';
}

/** Progress line for the panel from `item.started` command executions:
 *  `/bin/zsh -lc "sed -n '1,200p' x.py"` → `sed -n '1,200p' x.py`. */
export function statusFromJsonLine(line: string): string {
  const ev = parse(line);
  if (ev?.type !== 'item.started' || ev.item?.type !== 'command_execution'
      || typeof ev.item.command !== 'string') return '';
  const cmd = /^\S+ -lc "?([\s\S]*?)"?$/.exec(ev.item.command)?.[1] ?? ev.item.command;
  const s = `exec ${cmd}`.trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

export const codexCliResponder: Responder = {
  id: 'codex-cli',
  options: CODEX_OPTIONS,

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', ['codex'], (err) => resolve(!err));
    });
  },

  answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal,
         onStatus?: (s: string) => void): Promise<string> {
    const { model, effort } = responderSettings('codex-cli', readConfig());
    return new Promise((resolve, reject) => {
      const child = spawn('codex', CODEX_ARGS(codexPrompt(req), { model, effort }), {
        cwd: req.projectDir ?? os.homedir(),
        // stdin MUST be ignored: with a piped stdin, `codex exec` waits for
        // EOF to append it to the prompt and never starts (measured)
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });
      let answer = '';
      let stderr = '';
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const text = textFromJsonLine(line);
          if (text) {
            const sep = answer ? '\n\n' : '';
            answer += sep + text;
            onChunk(sep + text);
            continue;
          }
          const status = statusFromJsonLine(line);
          if (status) onStatus?.(status);
        }
      });
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', reject); // includes AbortError on signal
      child.on('close', (code) => {
        if (signal.aborted) return reject(new Error('canceled'));
        if (code !== 0 && !answer) {
          return reject(new Error(`codex exited ${code}: ${stderr.slice(0, 500)}`));
        }
        resolve(answer);
      });
    });
  },
};
