import { describe, expect, it } from 'vitest';
import { CLAUDE_ARGS, statusFromStreamLine, textFromStreamLine } from '../src/responders/claudeCli.js';
import { candidates } from '../src/responders/index.js';
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

  it('seeds the excerpt between the pointer and the anchor, framed as non-authoritative', () => {
    const p = composePrompt({ ...REQ, excerpt: '[user]\nhello world' });
    expect(p).toContain('[user]\nhello world');
    expect(p).toContain('source of truth');
    expect(p.indexOf(REQ.sessionFilePath)).toBeLessThan(p.indexOf('hello world'));
    expect(p.indexOf('hello world')).toBeLessThan(p.indexOf('ANCHOR (user-selected text)'));
    // empty excerpt (unknown anchor): no stray framing paragraph
    expect(composePrompt({ ...REQ, excerpt: '' })).not.toContain('source of truth');
  });

  it('says nothing about branches unless the session has them', () => {
    expect(composePrompt(REQ)).not.toContain('abandoned');
    expect(composePrompt({ ...REQ, branches: null })).not.toContain('abandoned');
  });

  it('with branches: teaches the tree, authority order, and the anchor side', () => {
    const live = composePrompt({ ...REQ, branches: { anchorAbandoned: false } });
    expect(live).toContain('rewound away');
    expect(live).toContain('the LAST one in the file is the path actually taken');
    expect(live).toContain('labeled as abandoned when cited');
    expect(live).toContain('on the path taken');
    const dead = composePrompt({ ...REQ, branches: { anchorAbandoned: true } });
    expect(dead).toContain('INSIDE an abandoned branch');
  });
});

describe('candidates routing', () => {
  const ids = (cfg: Parameters<typeof candidates>[0], adapter?: 'claude-code' | 'codex') =>
    candidates(cfg, adapter).map((e) => e.id);

  it('defaults to claude-cli, codex-cli', () => {
    expect(ids({})).toEqual(['claude-cli', 'codex-cli']);
  });

  it('puts the engine matching the viewed session agent first', () => {
    expect(ids({}, 'codex')).toEqual(['codex-cli', 'claude-cli']);
    expect(ids({}, 'claude-code')).toEqual(['claude-cli', 'codex-cli']);
  });

  it('a config pin is the only candidate — no fallback, session agent ignored', () => {
    expect(ids({ responder: 'claude-cli' }, 'codex')).toEqual(['claude-cli']);
  });

  it('an unknown pin yields no candidates', () => {
    expect(ids({ responder: 'gemini-cli' as never })).toEqual([]);
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

  it('narrates tool activity for progress display', () => {
    const tool = (name: string, input: Record<string, string>) => JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] },
    });
    const ctx = { sessionFilePath: '/home/u/.claude/projects/-p/abc-123.jsonl', projectDir: '/home/u/proj' };
    expect(statusFromStreamLine(tool('Grep', { pattern: 'welcome page' }), ctx)).toBe('searching welcome page');
    expect(statusFromStreamLine(tool('Grep', { path: '/home/u/.claude/projects/-p/abc-123.jsonl' }), ctx))
      .toBe('searching the transcript');
    expect(statusFromStreamLine(tool('Read', { file_path: '/home/u/proj/web/src/SidePanel.tsx' }), ctx))
      .toBe('reading web/src/SidePanel.tsx');
    expect(statusFromStreamLine(tool('Read', { file_path: '/etc/hosts' }), ctx)).toBe('reading hosts');
    expect(statusFromStreamLine(tool('LS', { path: '/home/u/elsewhere' }), ctx)).toBe('LS elsewhere');
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

});
