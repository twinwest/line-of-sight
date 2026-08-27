import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent, RenderBlock, SessionPatch } from '../shared/types.js';
import type { AgentAdapter } from './types.js';
import { parseTs, str, truncate } from './util.js';

// Line types that carry no conversational content (see SPIKE_NOTES.md);
// dropped from the event stream. Truly unknown types still fall through
// to the `unknown` fallback, so future schema additions stay visible.
// `queue-operation` is NOT here (it was until 2026-08-26): its enqueue/remove
// ops carry the text the user typed while the agent worked — the viewer
// derives the "queued, not yet read" strip from them (web/src/queue.ts).
// `fork-context-ref` opens the transcript of a subagent forked from its
// parent's context — a pointer ({parentSessionId, parentLastUuid,
// contextLength}), not content; the parent link comes from the path anyway.
const DROP_TYPES = new Set([
  'mode', 'permission-mode', 'last-prompt', 'bridge-session',
  'file-history-snapshot', 'file-history-delta',
  'atis-latch', 'agent-name', 'fork-context-ref',
]);

// Attachment subtypes that are pure bookkeeping/reminders (SPIKE_NOTES +
// dogfood): dropped like DROP_TYPES. Hook outputs, edited_text_file, and
// unknown subtypes keep rendering as meta.
const ATTACHMENT_DROP = new Set([
  'total_tokens_reminder', 'task_reminder', 'deferred_tools_delta',
  'skill_listing', 'agent_listing_delta', 'batching_reminder_sent',
  'date_change', 'plan_mode', 'plan_mode_exit', 'command_permissions',
  'auto_mode', 'silent_turn_reminder', 'mcp_instructions_delta',
]);

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const AGENT_JSONL = /^agent-[0-9a-z]+\.jsonl$/i;

type Json = Record<string, unknown>;

/** One-line human summary for a tool call, e.g. "Read src/foo.ts". */
function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Json;
  const arg = str(i.file_path) ?? str(i.path) ?? str(i.command) ?? str(i.pattern)
    ?? str(i.url) ?? str(i.query) ?? str(i.description) ?? '';
  return truncate(`${name} ${arg}`.trim(), 100);
}

/** Flatten a tool_result content (string | array of blocks) to display text. */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      const blk = b as Json;
      if (blk.type === 'text' && typeof blk.text === 'string') return blk.text;
      if (blk.type === 'image') return '[image]';
      return JSON.stringify(blk);
    }).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function contentToBlocks(content: unknown): RenderBlock[] {
  if (typeof content === 'string') return [{ type: 'text', markdown: content }];
  if (!Array.isArray(content)) return [{ type: 'raw', json: content }];
  return content.map((b): RenderBlock => {
    const blk = b as Json;
    switch (blk.type) {
      case 'text':
        return { type: 'text', markdown: str(blk.text) ?? '' };
      case 'thinking':
        return { type: 'thinking', text: str(blk.thinking) ?? '' };
      case 'tool_use': {
        const name = str(blk.name) ?? 'tool';
        return { type: 'tool_use', id: str(blk.id), toolName: name, summary: toolSummary(name, blk.input), input: blk.input };
      }
      case 'tool_result': {
        const output = flattenToolResult(blk.content);
        return {
          type: 'tool_result',
          toolUseId: str(blk.tool_use_id),
          summary: truncate(output.split('\n', 1)[0] ?? '', 100),
          output,
          isError: blk.is_error === true,
        };
      }
      case 'image': {
        // ponytail: base64 payloads are MBs; drop the data, keep a marker.
        const source = (blk.source ?? {}) as Json;
        return { type: 'raw', json: { type: 'image', media_type: source.media_type ?? null, note: 'image data omitted' } };
      }
      default:
        return { type: 'raw', json: blk };
    }
  });
}

/** pid → process start time as `ps` prints it, for pids that still exist.
 *  One `ps` call for the whole batch; a missing pid means the process is gone.
 *  `null` when ps itself is unusable — the caller must not read that as
 *  "every process is dead" and black out the running indicator wholesale. */
function procStarts(pids: number[]): Map<number, string> | null {
  if (!pids.length) return new Map();
  // spawnSync, not execFileSync: ps exits non-zero when any listed pid is gone,
  // and the surviving pids are still on stdout — throwing would lose them all
  const { stdout, error } = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart='],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (error || stdout == null) return null;   // no ps on this platform
  const map = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*\S)/.exec(line);
    if (m) map.set(Number(m[1]), m[2]!);
  }
  return map;
}

/** Is this pid alive at all? The pre-`ps` check, kept as the fallback. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Does the running process match the start time the session file recorded?
 *  `procStart` is a UTC wall clock with no zone marker while `ps -o lstart=`
 *  prints local (verified across 11 sessions), so accept either reading — a
 *  recycled pid won't match both, and a future format change can't silently
 *  black out every live session. Unparseable ⇒ accept (fail-open on the check). */
function startsMatch(procStart: string | null, psStart: string): boolean {
  if (!procStart) return true;
  const actual = Date.parse(psStart);
  if (Number.isNaN(actual)) return true;
  return Date.parse(`${procStart} UTC`) === actual || Date.parse(procStart) === actual;
}

/** Subagent transcript (`<session-uuid>/subagents/agent-*.jsonl`) → its child
 *  metadata; null for an ordinary top-level transcript. The parent comes from
 *  the path, so it is always known; the sibling `.meta.json` adds the Task
 *  tool_use the run belongs to and a human title. That file is written at spawn
 *  time, before the transcript — but it is undocumented, so a missing or
 *  drifted one just costs the Task-row link, never the ingest. */
function subagentMeta(filePath: string):
    { parentId: string; toolUseId: string | null; title: string } | null {
  const dir = path.dirname(filePath);
  if (path.basename(dir) !== 'subagents') return null;
  let m: Json = {};
  try {
    m = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as Json;
  } catch { /* not written yet, unreadable, or gone */ }
  const title = [str(m.agentType), str(m.description)].filter(Boolean).join(' · ');
  return {
    parentId: path.basename(path.dirname(dir)),
    toolUseId: str(m.toolUseId),
    title: truncate(title, 120),
  };
}

/** First user prompt lines that are CLI plumbing, not a real prompt. */
function isRealPrompt(line: Json, text: string): boolean {
  if (line.isMeta === true) return false;
  const t = text.trimStart();
  return t.length > 0 && !t.startsWith('<');
}

export function claudeCodeAdapter(root = path.join(os.homedir(), '.claude', 'projects')): AgentAdapter {
  return {
    id: 'claude-code',
    roots: () => [root],
    // 3 = deep enough for <project>/<uuid>/subagents/agent-*.jsonl
    watchDepth: 3,

    // <project>/<uuid>.jsonl (a session) and <project>/<uuid>/subagents/
    // agent-*.jsonl (a subagent run, ingested as that session's child).
    // Everything else alongside them — memory/*.md, the *.meta.json — is not
    // a transcript (see SPIKE_NOTES.md).
    matches(filePath) {
      const dir = path.dirname(filePath);
      if (UUID_JSONL.test(path.basename(filePath))) return path.dirname(dir) === root;
      return AGENT_JSONL.test(path.basename(filePath))
        && path.basename(dir) === 'subagents'
        && path.dirname(path.dirname(path.dirname(dir))) === root;
    },

    // ~/.claude/sessions/<pid>.json is written by the CLI itself and carries
    // {sessionId, pid, procStart, status, statusUpdatedAt} — the only signal
    // that survives a long model turn, which writes no transcript lines at all.
    // Observed statuses: 'busy' (mid-turn), 'waiting' (parked on the user),
    // 'shell', 'idle'. `waiting` is the ONLY live source for "the CLI needs
    // you": a blocking tool's tool_use line is written together with its
    // result, i.e. only after the user answers (SPIKE_NOTES 2026-08-26), so
    // the transcript cannot show a pending question while it is pending.
    // Undocumented, so every step is best-effort: a missing dir or changed
    // shape just means no live sessions, and the timestamp heuristic stays in
    // charge.
    liveSessions() {
      const live = new Map<string, { state: 'busy' | 'waiting'; since: number }>();
      const dir = path.join(root, '..', 'sessions');
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        return live;
      }
      const busy: { id: string; pid: number; procStart: string | null;
        state: 'busy' | 'waiting'; since: number }[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Json;
          const id = str(s.sessionId);
          const state = s.status === 'busy' ? 'busy' : s.status === 'waiting' ? 'waiting' : null;
          // out-of-range pids make ps bail on the whole batch, taking the valid
          // pids with it — drop them here (2^22 = Linux pid_max)
          if (!id || !state
              || typeof s.pid !== 'number' || s.pid <= 0 || s.pid >= 2 ** 22) continue;
          busy.push({
            id,
            pid: s.pid,
            procStart: str(s.procStart),
            state,
            // when that state began; 0 lets the client fall back to its own clock
            since: typeof s.statusUpdatedAt === 'number' ? s.statusUpdatedAt : 0,
          });
        } catch { /* stale or unreadable */ }
      }
      // absent from ps ⇒ process gone; start-time mismatch ⇒ the pid was
      // recycled by an unrelated process and this file is stale. If ps is
      // unusable, degrade to the plain liveness check rather than reporting
      // every session as dead — a recycled pid is a cosmetic wart, a blacked-out
      // running indicator is the M5 bug this whole signal exists to fix.
      const starts = procStarts(busy.map((b) => b.pid));
      for (const b of busy) {
        const entry = { state: b.state, since: b.since };
        if (!starts) {
          if (pidAlive(b.pid)) live.set(b.id, entry);
          continue;
        }
        const psStart = starts.get(b.pid);
        if (psStart && startsMatch(b.procStart, psStart)) live.set(b.id, entry);
      }
      return live;
    },

    parseLine(rawLine, ctx) {
      const fallbackId = `${ctx.filePath}:${ctx.byteOffset}`;
      let line: Json;
      try {
        const parsed: unknown = JSON.parse(rawLine);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return [{ kind: 'unknown', id: fallbackId, ts: 0, raw: parsed }];
        }
        line = parsed as Json;
      } catch {
        return [{ kind: 'unknown', id: fallbackId, ts: 0, raw: rawLine }];
      }

      const type = str(line.type);
      const id = str(line.uuid) ?? fallbackId;
      const ts = parseTs(line.timestamp);

      if (type === 'custom-title' || type === 'ai-title') {
        const title = str(line.customTitle) ?? str(line.aiTitle);
        if (!title) return [];
        const patch: SessionPatch = {
          title: truncate(title, 120),
          titleSource: type === 'custom-title' ? 'custom' : 'ai',
        };
        return [{ kind: 'meta', id, ts, label: type, raw: null, sessionPatch: patch }];
      }

      if (type && DROP_TYPES.has(type)) return [];

      // enqueue/dequeue/remove of the CLI's input queue; the viewer folds
      // these into derived queue state, they never render as rows
      if (type === 'queue-operation') {
        return [{ kind: 'meta', id, ts, label: 'queue-operation', raw: line }];
      }

      if (type === 'user' || type === 'assistant') {
        const message = line.message as Json | null | undefined;
        const content = message?.content;
        if (!message || content == null) {
          return [{ kind: 'unknown', id, ts, raw: line }];
        }
        const patch: SessionPatch = {};
        const cwd = str(line.cwd);
        if (cwd) patch.projectDir = cwd;
        if (type === 'user' && typeof content === 'string' && isRealPrompt(line, content)) {
          patch.title = truncate(content.trim(), 120);
          patch.titleSource = 'prompt';
        }
        return [{
          kind: 'message', id, ts, role: type,
          blocks: contentToBlocks(content),
          ...(Object.keys(patch).length ? { sessionPatch: patch } : {}),
        }];
      }

      if (type === 'system' || type === 'attachment') {
        // queued_command: input the user typed while the agent worked,
        // delivered mid-turn as an attachment — no plain user line ever
        // carries this text, so this IS the user speaking. Promote it to a
        // user message; non-human origins and drifted shapes stay meta.
        if (type === 'attachment') {
          const att = (line.attachment ?? {}) as Json;
          const origin = (att.origin ?? {}) as Json;
          if (att.type === 'queued_command' && origin.kind === 'human' && typeof att.prompt === 'string') {
            return [{ kind: 'message', id, ts, role: 'user', blocks: [{ type: 'text', markdown: att.prompt }] }];
          }
        }
        const subtype = type === 'system'
          ? str(line.subtype)
          : str((line.attachment as Json | undefined)?.type as unknown);
        // turn_duration: pure timing bookkeeping, one per turn — drop
        if (type === 'system' && subtype === 'turn_duration') return [];
        if (type === 'attachment' && subtype && ATTACHMENT_DROP.has(subtype)) return [];
        const label = `${type}: ${subtype ?? ''}`.trim().replace(/:$/, '');
        return [{ kind: 'meta', id, ts, label, raw: line }];
      }

      return [{ kind: 'unknown', id, ts, raw: line }];
    },

    sessionMeta(filePath, firstEvents) {
      const first = firstEvents[0];
      const ts = first?.ts ?? 0;
      // subagent ids are the filename's `agent-<hex>`, so they can't collide
      // with the uuid ids of top-level sessions
      const sub = subagentMeta(filePath);
      return {
        id: path.basename(filePath, '.jsonl'),
        adapter: 'claude-code',
        filePath,
        projectDir: null,   // filled from cwd patches (dir name munging is lossy)
        // a subagent's first user line is its whole spawn prompt — a terrible
        // title, so meta.json's description wins when there is one
        title: sub?.title ?? '',
        startedAt: ts,
        updatedAt: ts,
        messageCount: 0,
        parentId: sub?.parentId ?? null,
        toolUseId: sub?.toolUseId ?? null,
      };
    },
  };
}
