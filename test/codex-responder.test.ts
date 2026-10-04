import { describe, expect, it, vi } from 'vitest';

let listed: string[] = [];
vi.mock('../src/shared/codexModels.js', () => ({ codexModels: () => listed }));

const {
  CODEX_ARGS, codexCliResponder, statusFromJsonLine, textFromJsonLine,
} = await import('../src/responders/codexCli.js');

// Stream lines pinned from a real `codex exec --json` run (0.150.1,
// SPIKE_NOTES 2026-08-27).
const ANSWER_LINE = '{"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "`greet.py` defines functions that print greetings."}}';
const STARTED_LINE = '{"type": "item.started", "item": {"id": "item_1", "type": "command_execution", "command": "/bin/zsh -lc \\"sed -n \'1,200p\' greet.py\\"", "aggregated_output": "", "exit_code": null, "status": "in_progress"}}';

describe('CODEX_ARGS', () => {
  it('uses Terra at medium effort without changing the read-only cage', () => {
    const args = CODEX_ARGS('q');
    expect(args).toContain('gpt-5.6-terra');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('--ephemeral');          // no rollout in ~/.codex/sessions
    expect(args).toContain('--json');
    expect(args.join(' ')).toContain('--sandbox read-only');
    // pinned: a user's `web_search = "live"` must not reach Ask — live mode
    // fetches pages, cached reads OpenAI's index only
    expect(args.join(' ')).toContain('--config web_search="cached"');
    expect(args[args.length - 1]).toBe('q');
  });

  it('lets the Ask responder override its model and effort', () => {
    const args = CODEX_ARGS('q', { model: 'gpt-5.6-luna', effort: 'low' });
    expect(args.slice(0, 5)).toEqual([
      'exec', '--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort="low"',
    ]);
  });
});

describe('codex Ask choices', () => {
  it("offers the models Codex's own picker lists, efforts up to high", () => {
    listed = ['gpt-6-astra', 'gpt-5.6-terra'];
    expect(codexCliResponder.options).toEqual({
      models: ['gpt-6-astra', 'gpt-5.6-terra'],
      efforts: ['low', 'medium', 'high'],
    });
    listed = [];
  });

  it('falls back to a fixed list when the cache is unreadable', () => {
    expect(codexCliResponder.options?.models).toEqual(['gpt-5.6-terra', 'gpt-5.6-luna']);
  });
});

describe('textFromJsonLine', () => {
  it('extracts completed agent_message text, ignores everything else', () => {
    expect(textFromJsonLine(ANSWER_LINE)).toContain('greet.py');
    expect(textFromJsonLine(STARTED_LINE)).toBe('');
    expect(textFromJsonLine('{"type":"turn.completed","usage":{}}')).toBe('');
    expect(textFromJsonLine('{"type":"item.completed","item":{"type":"command_execution"}}')).toBe('');
    expect(textFromJsonLine('not json')).toBe('');
  });
});

describe('statusFromJsonLine', () => {
  it('strips the shell wrapper off started commands', () => {
    expect(statusFromJsonLine(STARTED_LINE)).toBe("exec sed -n '1,200p' greet.py");
    expect(statusFromJsonLine(ANSWER_LINE)).toBe('');
    expect(statusFromJsonLine('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}'))
      .toBe('exec ls');
    expect(statusFromJsonLine('junk')).toBe('');
  });

  it('narrates web searches: the query only arrives on completion', () => {
    // lines from real `codex exec --json` runs (0.153.4, web_search="cached")
    const started = '{"type":"item.started","item":{"id":"item_1","type":"web_search","query":"","action":{"type":"other"}}}';
    const searched = '{"type":"item.completed","item":{"id":"item_1","type":"web_search","query":"Mindsera journaling app founder","action":{"type":"search","query":"Mindsera journaling app founder"}}}';
    const opened = '{"type":"item.completed","item":{"id":"item_2","type":"web_search","query":"https://nodejs.org/en/about/previous-releases","action":{"type":"other"}}}';
    expect(statusFromJsonLine(started)).toBe('searching the web');
    expect(statusFromJsonLine(searched)).toBe('searching the web for Mindsera journaling app founder');
    expect(statusFromJsonLine(opened)).toBe('reading https://nodejs.org/en/about/previous-releases');
    // a completed search with no query adds nothing over the started line
    expect(statusFromJsonLine('{"type":"item.completed","item":{"type":"web_search","query":""}}')).toBe('');
  });
});
