import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { readConfig } from '../shared/config.js';
import { composePrompt } from './prompt.js';
import type { Responder, ResponderRequest } from './types.js';

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
export const CLAUDE_ARGS = (prompt: string, opts: { model?: string; effort?: string } = {}): string[] => [
  '-p', prompt,
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
export function statusFromStreamLine(line: string): string {
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
    const s = `${String(block.name ?? 'tool')} ${arg ?? ''}`.trim();
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  }
  return '';
}

export const claudeCliResponder: Responder = {
  id: 'claude-cli',

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', ['claude'], (err) => resolve(!err));
    });
  },

  answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal,
         onStatus?: (s: string) => void): Promise<string> {
    const { responderModel, responderEffort } = readConfig();
    return new Promise((resolve, reject) => {
      const child = spawn('claude', CLAUDE_ARGS(composePrompt(req), {
        model: responderModel, effort: responderEffort,
      }), {
        cwd: req.projectDir ?? os.homedir(),
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
          const text = textFromStreamLine(line);
          if (text) { answer += text; onChunk(text); continue; }
          const status = statusFromStreamLine(line);
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
