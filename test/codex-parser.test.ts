import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import type { RenderBlock } from '../src/shared/types.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'codex');
const ROOT = '/home/u/.codex/sessions';
const adapter = codexAdapter(ROOT);
const FILE = `${ROOT}/2026/08/27/rollout-2026-08-27T14-59-18-01a0453c-0b30-79d0-af26-6ca053010714.jsonl`;
const ctx = { filePath: FILE, byteOffset: 0 };

const line = (type: string, payload: unknown, ts = '2026-08-27T22:00:00.000Z') =>
  JSON.stringify({ timestamp: ts, ordinal: 0, type, payload });

describe('codexAdapter.matches', () => {
  it('accepts rollout files in the date tree, rejects everything else', () => {
    expect(adapter.matches(FILE)).toBe(true);
    expect(adapter.matches(`${ROOT}/2026/08/rollout-x.jsonl`)).toBe(false);       // too shallow
    expect(adapter.matches(`${ROOT}/2026/08/27/deep/rollout-x.jsonl`)).toBe(false); // too deep
    expect(adapter.matches(`${ROOT}/2026/08/27/notes.md`)).toBe(false);
    expect(adapter.matches('/elsewhere/2026/08/27/rollout-x.jsonl')).toBe(false);
  });
});

describe('codexAdapter.sessionMeta', () => {
  it('id = the filename uuid; adapter tagged codex', () => {
    const meta = adapter.sessionMeta(FILE, []);
    expect(meta.id).toBe('01a0453c-0b30-79d0-af26-6ca053010714');
    expect(meta.adapter).toBe('codex');
    expect(meta.projectDir).toBeNull();
  });
});

describe('codexAdapter.parseLine', () => {
  it('every real fixture line parses without throwing or vanishing silently', () => {
    const lines = fs.readFileSync(path.join(FIXTURES, 'entries.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim());
    for (const l of lines) expect(() => adapter.parseLine(l, ctx)).not.toThrow();
  });

  it('session_meta is a patch-only carrier with the cwd', () => {
    const [ev] = adapter.parseLine(line('session_meta', { id: 'x', cwd: '/repo' }), ctx);
    expect(ev).toMatchObject({ kind: 'meta', label: 'session_meta', raw: null,
      sessionPatch: { projectDir: '/repo' } });
  });

  it('bookkeeping drops: world_state, turn_context, token/settings event_msgs', () => {
    expect(adapter.parseLine(line('world_state', {}), ctx)).toEqual([]);
    expect(adapter.parseLine(line('turn_context', { cwd: '/x' }), ctx)).toEqual([]);
    for (const sub of ['token_count', 'thread_settings_applied']) {
      expect(adapter.parseLine(line('event_msg', { type: sub }), ctx)).toEqual([]);
    }
  });

  it('turn markers are patch-only carriers: started opens, complete closes', () => {
    const [started] = adapter.parseLine(line('event_msg', { type: 'task_started' }), ctx);
    expect(started).toMatchObject({ kind: 'meta', raw: null,
      sessionPatch: { turnOpen: true, turnStartedAt: Date.parse('2026-08-27T22:00:00.000Z') } });
    const [done] = adapter.parseLine(line('event_msg', { type: 'task_complete' }), ctx);
    expect(done).toMatchObject({ kind: 'meta', raw: null, sessionPatch: { turnOpen: false } });
    // unobserved task_* subtypes (the likely Esc/abort path) close defensively
    const [aborted] = adapter.parseLine(line('event_msg', { type: 'task_aborted' }), ctx);
    expect(aborted).toMatchObject({ kind: 'meta', raw: null, sessionPatch: { turnOpen: false } });
  });

  it('UserMessage → user text + title patch; AgentMessage → assistant text', () => {
    const [u] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix the bug' }] } }), ctx);
    expect(u).toMatchObject({ kind: 'message', role: 'user',
      blocks: [{ type: 'text', markdown: 'fix the bug' }],
      sessionPatch: { title: 'fix the bug', titleSource: 'prompt' } });
    const [a] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'done' }] } }), ctx);
    expect(a).toMatchObject({ kind: 'message', role: 'assistant',
      blocks: [{ type: 'text', markdown: 'done' }] });
  });

  it('encrypted Reasoning vanishes; a summary renders as thinking', () => {
    expect(adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'Reasoning', id: 'r1', summary_text: [], raw_content: [] } }), ctx)).toEqual([]);
    const [ev] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'Reasoning', id: 'r2', summary_text: [{ type: 'text', text: 'thought' }] } }), ctx);
    expect(ev).toMatchObject({ kind: 'message',
      blocks: [{ type: 'thinking', text: 'thought' }] });
  });

  it('CommandExecution → one message with a paired use + result', () => {
    const [ev] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'CommandExecution', id: 'exec-1',
        command: ['/bin/zsh', '-lc', 'npm test'], cwd: 'file:///repo',
        aggregated_output: 'ok\nmore', exit_code: 0, status: 'completed' } }), ctx);
    expect(ev?.kind).toBe('message');
    if (ev?.kind !== 'message') throw new Error('unreachable');
    const [use, result] = ev.blocks as RenderBlock[];
    expect(use).toMatchObject({ type: 'tool_use', id: 'exec-1', toolName: 'exec',
      summary: 'exec npm test' });
    expect(result).toMatchObject({ type: 'tool_result', toolUseId: 'exec-1',
      output: 'ok\nmore', isError: false });
  });

  it('a failing command marks the result as an error', () => {
    const [ev] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'CommandExecution', id: 'exec-2', command: ['x'],
        stdout: '', stderr: 'boom', exit_code: 1 } }), ctx);
    if (ev?.kind !== 'message') throw new Error('unreachable');
    expect(ev.blocks[1]).toMatchObject({ type: 'tool_result', output: 'boom', isError: true });
  });

  it('FileChange → apply_patch use with the structured changes as input', () => {
    const [ev] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'FileChange', id: 'fc-1', status: 'completed', stdout: 'Success',
        changes: { '/repo/a.py': { type: 'add', content: 'x = 1' } } } }), ctx);
    if (ev?.kind !== 'message') throw new Error('unreachable');
    expect(ev.blocks[0]).toMatchObject({ type: 'tool_use', toolName: 'apply_patch',
      summary: 'apply_patch a.py', input: { '/repo/a.py': { type: 'add', content: 'x = 1' } } });
    expect(ev.blocks[1]).toMatchObject({ type: 'tool_result', output: 'Success', isError: false });
  });

  it('Plan → visible markdown prose, never a fold', () => {
    const [ev] = adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'Plan', id: 'p1-plan', text: '# Plan\nbody' } }), ctx);
    expect(ev).toMatchObject({ kind: 'message', role: 'assistant',
      blocks: [{ type: 'text', markdown: '# Plan\nbody' }] });
  });

  it('request_user_input function_call parses its JSON-string arguments', () => {
    const args = JSON.stringify({ questions: [{ header: 'h', id: 'q1', question: 'pick one',
      options: [{ label: 'a', description: 'd' }] }] });
    const [ev] = adapter.parseLine(line('response_item', { type: 'function_call',
      id: 'fc1', call_id: 'call_1', name: 'request_user_input', arguments: args }), ctx);
    if (ev?.kind !== 'message') throw new Error('unreachable');
    expect(ev.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_1',
      toolName: 'request_user_input',
      input: { questions: [{ id: 'q1', question: 'pick one' }] } });
    const [out] = adapter.parseLine(line('response_item', { type: 'function_call_output',
      id: 'fo1', call_id: 'call_1', output: '{"answers":{"q1":{"answers":["a"]}}}' }), ctx);
    if (out?.kind !== 'message') throw new Error('unreachable');
    expect(out.blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call_1' });
  });

  it('item-echoed response_items are dropped by type', () => {
    for (const sub of ['message', 'reasoning', 'custom_tool_call', 'custom_tool_call_output']) {
      expect(adapter.parseLine(line('response_item', { type: sub, id: 'x' }), ctx)).toEqual([]);
    }
  });

  it('unknown shapes fall through to unknown, never crash', () => {
    expect(adapter.parseLine('not json', ctx)[0]).toMatchObject({ kind: 'unknown' });
    expect(adapter.parseLine(line('future_type', { x: 1 }), ctx)[0]).toMatchObject({ kind: 'unknown' });
    expect(adapter.parseLine(line('response_item', { type: 'future_item' }), ctx)[0])
      .toMatchObject({ kind: 'unknown' });
    expect(adapter.parseLine(line('event_msg', { type: 'item_completed',
      item: { type: 'FutureItem', id: 'f1' } }), ctx)[0]).toMatchObject({ kind: 'unknown' });
    // unobserved event subtypes stay visible as meta
    expect(adapter.parseLine(line('event_msg', { type: 'item_started', item: {} }), ctx)[0])
      .toMatchObject({ kind: 'meta', label: 'event_msg: item_started' });
  });
});

describe('codexAdapter.liveSessions', () => {
  const mkroot = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-'));
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'thread-writer-locks'), { recursive: true });
    return dir;
  };

  it('no lock dir → empty map', () => {
    const a = codexAdapter('/nonexistent/sessions');
    expect(a.liveSessions!().size).toBe(0);
  });

  it('a lock file nobody holds open is not live', () => {
    const dir = mkroot();
    const uuid = '01a04562-f9c1-7160-8b51-422756b17ff4';
    fs.writeFileSync(path.join(dir, 'thread-writer-locks', `${uuid}.lock`), '');
    const a = codexAdapter(path.join(dir, 'sessions'));
    expect(a.liveSessions!().has(uuid)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a lock held open by a live process is busy; released on death', async () => {
    const dir = mkroot();
    const uuid = '01a04562-f9c1-7160-8b51-422756b17ff4';
    const lock = path.join(dir, 'thread-writer-locks', `${uuid}.lock`);
    fs.writeFileSync(lock, '');
    // `tail -f` keeps the fd open the way the codex process does
    const holder = spawn('tail', ['-f', lock], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));   // let tail open the file
    const a = codexAdapter(path.join(dir, 'sessions'));
    try {
      // lsof may be unavailable in some environments — then the adapter
      // degrades to "no live sessions", which is the documented fallback
      const lsofWorks = await new Promise<boolean>((r) =>
        execFile('lsof', ['-v'], (err) => r(!err)));
      const live = a.liveSessions!();
      if (lsofWorks) {
        expect(live.get(uuid)).toMatchObject({ state: 'alive' });
      } else {
        expect(live.size).toBe(0);
      }
    } finally {
      holder.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(a.liveSessions!().has(uuid)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codexAdapter session_index.jsonl (AI thread names)', () => {
  const INDEX = '/home/u/.codex/session_index.jsonl';
  const UUID1 = '01a05dd9-9149-7e12-96a4-4d771586ae00';
  const idx = (id: string, name: string) =>
    JSON.stringify({ id, thread_name: name, updated_at: '2026-09-01T16:44:50.000Z' });

  it('is matched and flagged as a patch file; rollouts are not', () => {
    expect(adapter.matches(INDEX)).toBe(true);
    expect(adapter.patchFile!(INDEX)).toBe(true);
    expect(adapter.patchFile!(FILE)).toBe(false);
  });

  it('index lines become ai-title patches routed by session id', () => {
    const [ev] = adapter.parseLine(idx(UUID1, 'Compare repo ownership options'), { filePath: INDEX, byteOffset: 0 });
    expect(ev).toMatchObject({ kind: 'meta', raw: null,
      sessionPatch: { sessionId: UUID1, title: 'Compare repo ownership options', titleSource: 'ai' } });
    // malformed lines fall through, never throw
    expect(adapter.parseLine('{"id":"x"}', { filePath: INDEX, byteOffset: 0 })[0])
      .toMatchObject({ kind: 'unknown' });
  });

  it('ingest: the AI name overrides the prompt title, in either arrival order', async () => {
    const { Ingester } = await import('../src/daemon/ingest.js');
    const { Store } = await import('../src/store/store.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-index-'));
    const root = path.join(dir, 'sessions');
    const day = path.join(root, '2026', '09', '01');
    fs.mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-09-01T09-42-14-${UUID1}.jsonl`);
    fs.writeFileSync(rollout, line('event_msg', { type: 'item_completed',
      item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'long raw prompt' }] } }) + '\n');
    const index = path.join(dir, 'session_index.jsonl');
    fs.writeFileSync(index, idx(UUID1, 'long raw prompt (truncated)') + '\n' + idx(UUID1, 'Compare repo ownership options') + '\n');
    const a = codexAdapter(root);
    const store = new Store(':memory:');
    const ingester = new Ingester(store, [a]);

    // index first: patches drop (no session yet) — the whole-file replay heals
    ingester.ingestFile(a, index);
    expect(store.getSession(UUID1)).toBeNull();
    ingester.ingestFile(a, rollout);
    expect(store.getSession(UUID1)!.title).toBe('long raw prompt');
    ingester.ingestFile(a, index);
    expect(store.getSession(UUID1)!.title).toBe('Compare repo ownership options');
    // a later prompt (new first message never happens, but same priority rule:
    // prompt must not override ai)
    ingester.ingestFile(a, rollout);
    expect(store.getSession(UUID1)!.title).toBe('Compare repo ownership options');

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
