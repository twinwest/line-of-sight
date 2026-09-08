import { describe, expect, it } from 'vitest';
import {
  CODEX_ARGS, codexCliResponder, statusFromJsonLine, textFromJsonLine,
} from '../src/responders/codexCli.js';

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
  it('offers the fast and balanced Codex models in the side panel', () => {
    expect(codexCliResponder.options).toEqual({
      models: ['gpt-5.6-terra', 'gpt-5.6-luna'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
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
});
