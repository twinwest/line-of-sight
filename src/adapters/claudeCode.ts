import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent, RenderBlock, SessionPatch } from '../shared/types.js';
import type { AgentAdapter } from './types.js';

// Line types that carry no conversational content (see SPIKE_NOTES.md);
// dropped from the event stream. Truly unknown types still fall through
// to the `unknown` fallback, so future schema additions stay visible.
const DROP_TYPES = new Set([
  'mode', 'permission-mode', 'last-prompt', 'bridge-session',
  'queue-operation', 'file-history-snapshot', 'file-history-delta',
  'atis-latch', 'agent-name',
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

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseTs(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

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
        return { type: 'tool_use', toolName: name, summary: toolSummary(name, blk.input), input: blk.input };
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

    // Only top-level <uuid>.jsonl directly inside a project dir — siblings
    // include <uuid>/subagents/*.jsonl and memory/*.md (see SPIKE_NOTES.md).
    matches(filePath) {
      return UUID_JSONL.test(path.basename(filePath))
        && path.dirname(path.dirname(filePath)) === root;
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
      return {
        id: path.basename(filePath, '.jsonl'),
        adapter: 'claude-code',
        filePath,
        projectDir: null,   // filled from cwd patches (dir name munging is lossy)
        title: '',
        startedAt: ts,
        updatedAt: ts,
        messageCount: 0,
      };
    },
  };
}
