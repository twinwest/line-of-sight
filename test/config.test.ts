import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Codex's model cache lives in the real ~/.codex; pin it so the defaults
// asserted below don't depend on the machine running the tests
let listed: string[] = [];
vi.mock('../src/shared/codexModels.js', () => ({ codexModels: () => listed }));

const {
  readConfig, responderConfigPatch, responderSettings, writeConfig,
} = await import('../src/shared/config.js');

describe('writeConfig merge semantics', () => {
  it('partial update keeps other keys; empty string clears; undefined untouched', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-cfg-')), 'config.json');
    writeConfig({ responderModel: 'claude-sonnet-5', responderEffort: 'medium' }, file);
    // updating one field must not wipe the other (regression: undefined deleted keys)
    writeConfig({ responderEffort: 'low', responderModel: undefined }, file);
    expect(readConfig(file)).toEqual({ responderModel: 'claude-sonnet-5', responderEffort: 'low' });
    // '' clears a key
    writeConfig({ responderModel: '' }, file);
    expect(readConfig(file)).toEqual({ responderEffort: 'low' });
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('stores Codex Ask settings separately from Claude Ask settings', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-cfg-')), 'config.json');
    writeConfig({
      responderModel: 'claude-sonnet-5',
      responderEffort: 'high',
      codexResponderModel: 'gpt-5.6-luna',
      codexResponderEffort: 'low',
    }, file);
    expect(readConfig(file)).toEqual({
      responderModel: 'claude-sonnet-5',
      responderEffort: 'high',
      codexResponderModel: 'gpt-5.6-luna',
      codexResponderEffort: 'low',
    });
  });

  it('resolves engine-specific settings with Sight defaults for both engines', () => {
    expect(responderSettings('codex-cli', {})).toEqual({ model: 'gpt-5.6-terra', effort: 'medium', webSearch: false });
    expect(responderSettings('codex-cli', {
      codexResponderModel: '', codexResponderEffort: '',
    })).toEqual({ model: 'gpt-5.6-terra', effort: 'medium', webSearch: false });
    // an unset Claude model must not fall through to the CLI's built-in
    // default, which can be the slowest model on the account
    expect(responderSettings('claude-cli', {})).toEqual({ model: 'sonnet', effort: 'medium', webSearch: false });
    expect(responderSettings('claude-cli', {
      responderModel: '', responderEffort: '',
    })).toEqual({ model: 'sonnet', effort: 'medium', webSearch: false });
    const config = {
      responderModel: 'claude-haiku-4-5',
      responderEffort: 'low',
      codexResponderModel: 'gpt-5.6-luna',
      codexResponderEffort: 'high',
    };
    expect(responderSettings('codex-cli', config)).toEqual({ model: 'gpt-5.6-luna', effort: 'high', webSearch: false });
    expect(responderSettings('claude-cli', config)).toEqual({ model: 'claude-haiku-4-5', effort: 'low', webSearch: false });
  });

  it('an unconfigured Codex ask follows Codex once it retires the default', () => {
    listed = ['gpt-6-astra', 'gpt-6-luna'];
    expect(responderSettings('codex-cli', {})).toEqual({ model: 'gpt-6-astra', effort: 'medium', webSearch: false });
    // a model the user picked is theirs, listed or not
    expect(responderSettings('codex-cli', { codexResponderModel: 'gpt-5.6-terra' }).model)
      .toBe('gpt-5.6-terra');
    listed = [];
  });

  it('web search is off unless the user turned it on, one switch for both CLIs', () => {
    expect(responderSettings('claude-cli', {}).webSearch).toBe(false);
    expect(responderSettings('codex-cli', {}).webSearch).toBe(false);
    expect(responderSettings('claude-cli', { responderWebSearch: true }).webSearch).toBe(true);
    expect(responderSettings('codex-cli', { responderWebSearch: true }).webSearch).toBe(true);
  });

  it('maps panel updates onto only the selected responder', () => {
    expect(responderConfigPatch('codex-cli', { model: 'gpt-5.6-luna' })).toEqual({
      codexResponderModel: 'gpt-5.6-luna',
    });
    expect(responderConfigPatch('claude-cli', { effort: 'high' })).toEqual({
      responderEffort: 'high',
    });
  });
});
