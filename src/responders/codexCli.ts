import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composePrompt } from './prompt.js';
import type { Responder, ResponderRequest } from './types.js';

// Read-only cage (product promise B5): --sandbox read-only is enforced by
// codex's own sandbox — verified via a forced write attempt (blocked, file
// not created; SPIKE_NOTES 2026-08-27). --ephemeral keeps responder runs
// out of ~/.codex/sessions — the --no-session-persistence analog (without
// it every ask would appear as a session, the M5 pollution lesson).
// --json streams item-level events on stdout. options: null — codex runs on
// the user's own config.toml model; responderModel/responderEffort don't apply.
export const CODEX_ARGS = (prompt: string): string[] => [
  'exec',
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

/** Engine row label: what actually answers is codex on the user's own
 *  config.toml model. The keys are top-level simple strings, so a line scan
 *  (stopping at the first [section]) beats pulling in a toml parser. */
export function codexEngineLabel(configPath = path.join(os.homedir(), '.codex', 'config.toml')): string {
  let model = '';
  let effort = '';
  try {
    for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
      if (line.trimStart().startsWith('[')) break;
      const m = /^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/.exec(line);
      if (m?.[1] === 'model') model = m[2]!;
      else if (m?.[1] === 'model_reasoning_effort') effort = m[2]!;
    }
  } catch { /* no config → codex's own default model */ }
  if (!model) return 'codex';   // model unset → codex's own default, name unknown
  return effort ? `${model} (${effort})` : model;
}

export const codexCliResponder: Responder = {
  id: 'codex-cli',
  options: null,
  label: () => codexEngineLabel(),

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', ['codex'], (err) => resolve(!err));
    });
  },

  answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal,
         onStatus?: (s: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('codex', CODEX_ARGS(composePrompt(req)), {
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
