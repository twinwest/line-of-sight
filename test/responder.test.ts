import { describe, expect, it } from 'vitest';
import { CLAUDE_ARGS, statusFromStreamLine, textFromStreamLine } from '../src/responders/claudeCli.js';
import { composePrompt } from '../src/responders/prompt.js';
import { Store } from '../src/store/store.js';

const REQ = {
  question: 'What is the evidence for this?',
  anchorText: 'the parser is incremental',
  sessionFilePath: '/home/u/.claude/projects/-p/abc.jsonl',
  projectDir: '/home/u/proj',
  priorTurns: [
    { role: 'user' as const, text: 'earlier q' },
    { role: 'assistant' as const, text: 'earlier a' },
  ],
};

describe('composePrompt', () => {
  it('includes pointer, project dir, prior turns, anchor, and question in order', () => {
    const p = composePrompt(REQ);
    expect(p).toContain(REQ.sessionFilePath);
    expect(p).toContain('/home/u/proj');
    expect(p.indexOf('PRIOR QUESTION: earlier q')).toBeLessThan(p.indexOf('PRIOR ANSWER: earlier a'));
    expect(p.indexOf('ANCHOR')).toBeLessThan(p.indexOf('QUESTION: What is the evidence'));
  });

  it('uses inline context instead of the file pointer when provided', () => {
    const p = composePrompt({ ...REQ, inlineContext: 'CTX HERE' });
    expect(p).toContain('CTX HERE');
    expect(p).not.toContain(REQ.sessionFilePath);
  });
});

describe('claude-cli command construction', () => {
  it('uses exactly the M0-verified flags with a read-only tool cage', () => {
    const args = CLAUDE_ARGS('PROMPT');
    expect(args).toEqual([
      '-p', 'PROMPT',
      '--allowedTools', 'Read,Grep,Glob',
      '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch',
      '--no-session-persistence',
      '--setting-sources', '',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]);
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    const disallowed = args[args.indexOf('--disallowedTools') + 1]!;
    for (const banned of ['Write', 'Edit', 'Bash', 'WebFetch']) {
      expect(allowed).not.toContain(banned);
      expect(disallowed).toContain(banned);
    }
  });

  it('appends --model/--effort only when configured', () => {
    expect(CLAUDE_ARGS('P')).not.toContain('--model');
    expect(CLAUDE_ARGS('P')).not.toContain('--effort');
    const args = CLAUDE_ARGS('P', { model: 'claude-sonnet-5', effort: 'low' });
    expect(args.slice(-4)).toEqual(['--model', 'claude-sonnet-5', '--effort', 'low']);
  });

  it('extracts tool activity for progress display', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'welcome page' } }] },
    });
    expect(statusFromStreamLine(line)).toBe('Grep welcome page');
    expect(statusFromStreamLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] },
    }))).toBe('');
    expect(statusFromStreamLine('not json')).toBe('');
  });

  it('extracts only text deltas from stream-json lines', () => {
    expect(textFromStreamLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    }))).toBe('hi');
    expect(textFromStreamLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
    }))).toBe('');
    expect(textFromStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBe('');
    expect(textFromStreamLine('not json')).toBe('');
  });
});

describe('side chat store round-trip', () => {
  it('create, append turns, list, reload, delete', () => {
    const store = new Store(':memory:');
    const chat = store.createSideChat('s1', 'm1', 'anchor text');
    store.appendSideChatTurn(chat.id, { role: 'user', text: 'q1', ts: 1 });
    store.appendSideChatTurn(chat.id, { role: 'assistant', text: 'a1', ts: 2 });

    const loaded = store.getSideChat(chat.id)!;
    expect(loaded.anchorText).toBe('anchor text');
    expect(loaded.turns).toEqual([
      { role: 'user', text: 'q1', ts: 1 },
      { role: 'assistant', text: 'a1', ts: 2 },
    ]);
    expect(store.listSideChats('s1')).toHaveLength(1);

    store.deleteSideChat(chat.id);
    expect(store.getSideChat(chat.id)).toBeNull();
    expect(store.listSideChats('s1')).toHaveLength(0);
  });

  it('inlineContext returns text around the anchor only', () => {
    const store = new Store(':memory:');
    store.upsertSession({
      id: 's1', adapter: 'claude-code', filePath: '/f', projectDir: null,
      title: '', startedAt: 0, updatedAt: 0, messageCount: 0,
    });
    const events = Array.from({ length: 100 }, (_, i) => ({
      kind: 'message' as const, id: `m${i}`, role: 'user' as const, ts: i,
      blocks: [{ type: 'text' as const, markdown: `message number ${i}` }],
    }));
    store.appendEvents('s1', events, 1);
    const ctx = store.inlineContext('s1', 'm50', 5);
    expect(ctx).toContain('message number 50');
    expect(ctx).toContain('message number 45');
    expect(ctx).not.toContain('message number 40');
  });
});
