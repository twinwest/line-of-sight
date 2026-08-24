import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';

const adapter = claudeCodeAdapter('/tmp/fake-root');
const ctx = { filePath: '/tmp/fake-root/-proj/00000000-0000-0000-0000-000000000000.jsonl', byteOffset: 0 };

function fixtureLines(name: string): string[] {
  const p = path.join(import.meta.dirname, 'fixtures', 'claude-code', name);
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
}

describe('claudeCode.parseLine on real fixture lines', () => {
  const lines = fixtureLines('entries.jsonl');

  it('never throws and never returns undefined', () => {
    for (const line of lines) {
      const evs = adapter.parseLine(line, ctx);
      expect(Array.isArray(evs)).toBe(true);
    }
  });

  it('maps user/assistant lines to message events with expected blocks', () => {
    const all = lines.flatMap((l) => adapter.parseLine(l, ctx));
    const messages = all.filter((e) => e.kind === 'message');
    expect(messages.length).toBeGreaterThanOrEqual(8);
    const blockTypes = new Set(messages.flatMap((m) => m.kind === 'message' ? m.blocks.map((b) => b.type) : []));
    for (const t of ['text', 'thinking', 'tool_use', 'tool_result']) {
      expect(blockTypes, `missing block type ${t}`).toContain(t);
    }
  });

  it('string user content becomes a text block and a title patch', () => {
    const line = lines.find((l) => {
      const j = JSON.parse(l) as { type?: string; message?: { content?: unknown } };
      return j.type === 'user' && typeof j.message?.content === 'string'
        && !(j.message.content as string).startsWith('<');
    });
    expect(line).toBeDefined();
    const [ev] = adapter.parseLine(line!, ctx);
    expect(ev).toMatchObject({ kind: 'message', role: 'user' });
    if (ev?.kind !== 'message') throw new Error('unreachable');
    expect(ev.blocks[0]).toMatchObject({ type: 'text' });
    expect(ev.sessionPatch?.title).toBeTruthy();
    expect(ev.sessionPatch?.titleSource).toBe('prompt');
    expect(ev.sessionPatch?.projectDir).toMatch(/^\//);
  });

  it('tool_result with array content flattens to output text', () => {
    const all = lines.flatMap((l) => adapter.parseLine(l, ctx));
    const results = all.flatMap((e) => e.kind === 'message' ? e.blocks : [])
      .filter((b) => b.type === 'tool_result');
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      if (r.type !== 'tool_result') continue;
      expect(typeof r.output).toBe('string');
      expect(typeof r.summary).toBe('string');
    }
  });

  it('image blocks are stored without base64 payload', () => {
    const all = lines.flatMap((l) => adapter.parseLine(l, ctx));
    const raws = all.flatMap((e) => e.kind === 'message' ? e.blocks : [])
      .filter((b) => b.type === 'raw');
    const serialized = JSON.stringify(raws);
    expect(serialized).not.toContain('REDACTED_BASE64');
  });

  it('title lines become sessionPatch metas', () => {
    const custom = lines.find((l) => l.includes('"custom-title"'))!;
    const ai = lines.find((l) => l.includes('"ai-title"'))!;
    const [cev] = adapter.parseLine(custom, ctx);
    const [aev] = adapter.parseLine(ai, ctx);
    expect(cev).toMatchObject({ kind: 'meta', sessionPatch: { titleSource: 'custom' } });
    expect(aev).toMatchObject({ kind: 'meta', sessionPatch: { titleSource: 'ai' } });
  });

  it('bookkeeping types are dropped, system kept as meta', () => {
    const byType = (t: string) => lines.filter((l) => JSON.parse(l).type === t)
      .flatMap((l) => adapter.parseLine(l, ctx));
    expect(byType('mode')).toHaveLength(0);
    expect(byType('file-history-snapshot')).toHaveLength(0);
    // the fixture attachment is date_change — reminder-class, dropped
    expect(byType('attachment')).toHaveLength(0);
    expect(byType('system')[0]).toMatchObject({ kind: 'meta' });
  });

  it('reminder attachments drop; hook and unknown attachments stay', () => {
    const mk = (sub: string) => JSON.stringify({
      type: 'attachment', uuid: 'a1', attachment: { type: sub, content: 'x' },
    });
    expect(adapter.parseLine(mk('total_tokens_reminder'), ctx)).toHaveLength(0);
    expect(adapter.parseLine(mk('task_reminder'), ctx)).toHaveLength(0);
    expect(adapter.parseLine(mk('hook_success'), ctx)[0])
      .toMatchObject({ kind: 'meta', label: 'attachment: hook_success' });
    expect(adapter.parseLine(mk('some_future_subtype'), ctx)[0])
      .toMatchObject({ kind: 'meta' });
  });
});

describe('claudeCode.parseLine on edge cases', () => {
  it('malformed and unknown lines become unknown events, no throw', () => {
    for (const line of fixtureLines('edge-cases.jsonl')) {
      const evs = adapter.parseLine(line, ctx);
      expect(evs).toHaveLength(1);
      expect(['unknown', 'message']).toContain(evs[0]!.kind);
    }
    const bad = adapter.parseLine('not json at all', ctx);
    expect(bad[0]).toMatchObject({ kind: 'unknown', id: `${ctx.filePath}:0` });
  });
});

describe('claudeCode.matches', () => {
  const root = '/tmp/fake-root';
  it('accepts only top-level uuid jsonl files', () => {
    expect(adapter.matches(`${root}/-proj/12345678-1234-1234-1234-123456789abc.jsonl`)).toBe(true);
    expect(adapter.matches(`${root}/-proj/12345678-1234-1234-1234-123456789abc/subagents/agent-x.jsonl`)).toBe(false);
    expect(adapter.matches(`${root}/-proj/memory/MEMORY.md`)).toBe(false);
    expect(adapter.matches(`${root}/-proj/notes.jsonl`)).toBe(false);
  });
});
