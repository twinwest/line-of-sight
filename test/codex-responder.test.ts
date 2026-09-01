import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_ARGS, codexEngineLabel, statusFromJsonLine, textFromJsonLine } from '../src/responders/codexCli.js';

// Stream lines pinned from a real `codex exec --json` run (0.150.1,
// SPIKE_NOTES 2026-08-27).
const ANSWER_LINE = '{"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "`greet.py` defines functions that print greetings."}}';
const STARTED_LINE = '{"type": "item.started", "item": {"id": "item_1", "type": "command_execution", "command": "/bin/zsh -lc \\"sed -n \'1,200p\' greet.py\\"", "aggregated_output": "", "exit_code": null, "status": "in_progress"}}';

describe('CODEX_ARGS', () => {
  it('carries the read-only cage and the no-pollution flag', () => {
    const args = CODEX_ARGS('q');
    expect(args).toContain('--ephemeral');          // no rollout in ~/.codex/sessions
    expect(args).toContain('--json');
    expect(args.join(' ')).toContain('--sandbox read-only');
    expect(args[args.length - 1]).toBe('q');
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

describe('codexEngineLabel', () => {
  const withConfig = (toml: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
    const p = path.join(dir, 'config.toml');
    fs.writeFileSync(p, toml);
    return p;
  };

  it('reads top-level model + effort; ignores keys inside sections', () => {
    expect(codexEngineLabel(withConfig(
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n[profiles.x]\nmodel = "other"\n')))
      .toBe('codex · gpt-5.6-sol (medium)');
    expect(codexEngineLabel(withConfig('model = "gpt-5.6-sol"\n')))
      .toBe('codex · gpt-5.6-sol');
  });

  it('no model key or no file → plain "codex"', () => {
    expect(codexEngineLabel(withConfig('[notice]\nmodel = "not-top-level"\n'))).toBe('codex');
    expect(codexEngineLabel('/nonexistent/config.toml')).toBe('codex');
  });
});
