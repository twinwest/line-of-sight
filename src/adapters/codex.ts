import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent, RenderBlock, SessionPatch } from '../shared/types.js';
import type { AgentAdapter } from './types.js';
import { parseTs, str, truncate } from './util.js';

// Codex CLI rollout transcripts (0.150.x, SPIKE_NOTES 2026-08-27):
// ~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl, envelope
// {timestamp, ordinal, type, payload}. Two parallel streams share the file:
// raw model-API `response_item` lines and the TUI-level
// `event_msg/item_completed` item projection. The items are the readable
// model — clean user prompts (no <environment_context> wrapper), parsed
// commands WITH their output, structured file changes, plan documents — so
// ingestion reads items as primary and takes from response_item only what
// has no item form: function_call/-output (request_user_input). The item-
// echoed response_item types are dropped BY TYPE (a line-local parser can't
// dedupe by id); truly unknown shapes still fall through to `unknown`.

const ROLLOUT = /^rollout-.*\.jsonl$/;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Bookkeeping with no conversational content (SPIKE_NOTES): dropped, like
// the claude adapter's DROP_TYPES. Unknown envelope types render as unknown.
// task_started/task_complete are NOT here: they are turn-boundary markers,
// ingested as patch-only carriers (see parseLine) so liveness can tell a
// generating session from an open-but-idle TUI.
const DROP_TYPES = new Set(['world_state', 'turn_context']);
const DROP_EVENTS = new Set(['token_count', 'thread_settings_applied']);
// response_item types fully echoed by their item_completed projection
// (verified over every local session: reasoning 33/33, messages/commands
// covered with richer fields on the item side).
const ECHOED = new Set(['message', 'reasoning', 'custom_tool_call', 'custom_tool_call_output']);

type Json = Record<string, unknown>;

/** Join an item content array ({type:'text'|'Text', text}) to markdown. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => str((c as Json).text) ?? '').filter(Boolean).join('\n');
}

/** The human-readable command: ["/bin/zsh","-lc",cmd] → cmd. */
function commandLine(command: unknown): string {
  if (!Array.isArray(command)) return '';
  const parts = command.map((c) => str(c) ?? '');
  return (parts.length === 3 && parts[1] === '-lc' ? parts[2] : parts.join(' ')) ?? '';
}

/** One TUI item → zero or more events. MUST NOT throw. */
function itemToEvents(item: Json, ts: number, fallbackId: string): NormalizedEvent[] {
  const id = str(item.id) ?? fallbackId;
  switch (item.type) {
    case 'UserMessage': {
      const text = contentText(item.content);
      if (!text.trim()) return [];
      const patch: SessionPatch = {};
      // items are pre-filtered by the CLI, but keep the '<' guard anyway
      if (!text.trimStart().startsWith('<')) {
        patch.title = truncate(text.trim(), 120);
        patch.titleSource = 'prompt';
      }
      return [{ kind: 'message', id, ts, role: 'user',
        blocks: [{ type: 'text', markdown: text }],
        ...(patch.title ? { sessionPatch: patch } : {}) }];
    }
    case 'AgentMessage': {
      const text = contentText(item.content);
      if (!text.trim()) return [];
      return [{ kind: 'message', id, ts, role: 'assistant',
        blocks: [{ type: 'text', markdown: text }] }];
    }
    case 'Reasoning': {
      // reasoning is encrypted server-side; only a summary is ever readable
      const text = contentText(item.summary_text) || contentText(item.raw_content);
      if (!text.trim()) return [];
      return [{ kind: 'message', id, ts, role: 'assistant',
        blocks: [{ type: 'thinking', text }] }];
    }
    case 'CommandExecution': {
      // self-contained action + result: one message, use + result paired by id
      const cmd = commandLine(item.command);
      const output = str(item.aggregated_output) ?? [str(item.stdout), str(item.stderr)]
        .filter(Boolean).join('\n');
      const blocks: RenderBlock[] = [
        { type: 'tool_use', id, toolName: 'exec',
          summary: truncate(`exec ${cmd}`.trim(), 100),
          input: { command: item.command, cwd: item.cwd ?? null } },
        { type: 'tool_result', toolUseId: id,
          summary: truncate((output.split('\n', 1)[0] ?? ''), 100),
          output, isError: typeof item.exit_code === 'number' && item.exit_code !== 0 },
      ];
      return [{ kind: 'message', id, ts, role: 'assistant', blocks }];
    }
    case 'FileChange': {
      const changes = (item.changes ?? {}) as Json;
      const files = Object.keys(changes);
      const blocks: RenderBlock[] = [
        { type: 'tool_use', id, toolName: 'apply_patch',
          summary: truncate(`apply_patch ${files.map((f) => path.basename(f)).join(' ')}`, 100),
          input: changes },
        { type: 'tool_result', toolUseId: id,
          summary: str(item.status) ?? '',
          output: str(item.stdout) ?? str(item.status) ?? '',
          isError: item.status !== undefined && item.status !== 'completed' },
      ];
      return [{ kind: 'message', id, ts, role: 'assistant', blocks }];
    }
    case 'Plan': {
      // the plan is a document the user must be able to read — plain
      // markdown prose, never a fold (the codex dialect may card-ify later)
      const text = str(item.text);
      if (!text?.trim()) return [{ kind: 'unknown', id, ts, raw: item }];
      return [{ kind: 'message', id, ts, role: 'assistant',
        blocks: [{ type: 'text', markdown: text }] }];
    }
    default:
      return [{ kind: 'unknown', id, ts, raw: item }];
  }
}

export function codexAdapter(root = path.join(os.homedir(), '.codex', 'sessions')): AgentAdapter {
  return {
    id: 'codex',
    roots: () => [root],
    // 3 = <root>/YYYY/MM/DD/rollout-*.jsonl
    watchDepth: 3,

    matches(filePath) {
      if (!ROLLOUT.test(path.basename(filePath))) return false;
      const dd = path.dirname(filePath);
      return path.dirname(path.dirname(path.dirname(dd))) === root;
    },

    // ~/.codex/thread-writer-locks/<session-uuid>.lock is held OPEN by the
    // live codex process for the session's whole lifetime and the fd dies
    // with the process — so unlike claude's status file, a claim here can
    // never go stale (SPIKE_NOTES 2026-08-27). The lock files themselves
    // persist after exit: existence means nothing, the open fd is the
    // signal, probed with one batched lsof. No busy/waiting distinction —
    // an open-but-idle TUI reads as busy until STALE_BUSY_MS expires it.
    // lsof missing or failing degrades to the timestamp heuristic.
    liveSessions() {
      const live = new Map<string, { state: 'busy' | 'waiting'; since: number }>();
      const lockDir = path.join(root, '..', 'thread-writer-locks');
      let locks: string[];
      try {
        locks = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
      } catch {
        return live;
      }
      if (!locks.length) return live;
      // lsof exits non-zero when any listed file is open by nobody, but
      // still prints the held ones — same spawnSync reasoning as the claude
      // adapter's `ps` batch.
      const { stdout, error } = spawnSync('lsof',
        ['-Fn', '--', ...locks.map((f) => path.join(lockDir, f))],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (error || !stdout) return live;
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('n')) continue;
        const uuid = UUID.exec(line.slice(1).replace(/\.lock$/, '.jsonl'))?.[1];
        if (uuid) live.set(uuid, { state: 'busy', since: 0 });
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
      const ts = parseTs(line.timestamp);
      const payload = (line.payload ?? {}) as Json;

      if (type === 'session_meta') {
        // patch-only carrier: cwd → projectDir, ts → startedAt; no display row
        const cwd = str(payload.cwd);
        return [{ kind: 'meta', id: fallbackId, ts, label: 'session_meta', raw: null,
          ...(cwd ? { sessionPatch: { projectDir: cwd } } : {}) }];
      }

      if (type && DROP_TYPES.has(type)) return [];

      if (type === 'event_msg') {
        const sub = str(payload.type);
        if (sub && DROP_EVENTS.has(sub)) return [];
        // turn boundaries → patch-only carriers (no display row). Unobserved
        // task_* subtypes (a future task_aborted, say — the likely Esc path)
        // defensively CLOSE the turn: a stuck-open turn pins the busy dot,
        // a wrongly-closed one just greys it until the next task_started.
        if (sub?.startsWith('task_')) {
          const patch: SessionPatch = sub === 'task_started'
            ? { turnOpen: true, turnStartedAt: ts }
            : { turnOpen: false };
          return [{ kind: 'meta', id: fallbackId, ts, label: sub, raw: null, sessionPatch: patch }];
        }
        if (sub === 'item_completed') {
          const item = payload.item;
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return itemToEvents(item as Json, ts, fallbackId);
          }
          return [{ kind: 'unknown', id: fallbackId, ts, raw: line }];
        }
        // unobserved event subtypes stay visible as small meta rows
        return [{ kind: 'meta', id: fallbackId, ts, label: `event_msg: ${sub ?? ''}`.trim(), raw: line }];
      }

      if (type === 'response_item') {
        const sub = str(payload.type);
        if (sub && ECHOED.has(sub)) return [];
        if (sub === 'function_call') {
          // request_user_input & friends; arguments is a JSON string
          const name = str(payload.name) ?? 'tool';
          let input: unknown = payload.arguments;
          try {
            if (typeof payload.arguments === 'string') input = JSON.parse(payload.arguments);
          } catch { /* keep the raw string */ }
          return [{ kind: 'message', id: str(payload.id) ?? fallbackId, ts, role: 'assistant',
            blocks: [{ type: 'tool_use', id: str(payload.call_id), toolName: name,
              summary: name, input }] }];
        }
        if (sub === 'function_call_output') {
          const output = str(payload.output) ?? JSON.stringify(payload.output ?? null);
          return [{ kind: 'message', id: str(payload.id) ?? fallbackId, ts, role: 'user',
            blocks: [{ type: 'tool_result', toolUseId: str(payload.call_id),
              summary: truncate(output.split('\n', 1)[0] ?? '', 100),
              output, isError: false }] }];
        }
        return [{ kind: 'unknown', id: str(payload.id) ?? fallbackId, ts, raw: line }];
      }

      return [{ kind: 'unknown', id: fallbackId, ts, raw: line }];
    },

    sessionMeta(filePath, firstEvents) {
      const ts = firstEvents[0]?.ts ?? 0;
      return {
        id: UUID.exec(path.basename(filePath))?.[1] ?? path.basename(filePath, '.jsonl'),
        adapter: 'codex',
        filePath,
        projectDir: null,   // filled by the session_meta cwd patch
        title: '',          // filled by the first UserMessage patch
        startedAt: ts,
        updatedAt: ts,
        messageCount: 0,
        parentId: null,
        toolUseId: null,
      };
    },
  };
}
