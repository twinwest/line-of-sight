import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readConfig, responderConfigPatch, responderSettings, writeConfig,
} from '../src/shared/config.js';

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

  it('resolves engine-specific settings with a Terra/medium Codex default', () => {
    expect(responderSettings('codex-cli', {})).toEqual({ model: 'gpt-5.6-terra', effort: 'medium' });
    expect(responderSettings('codex-cli', {
      codexResponderModel: '', codexResponderEffort: '',
    })).toEqual({ model: 'gpt-5.6-terra', effort: 'medium' });
    expect(responderSettings('claude-cli', {})).toEqual({ model: '', effort: '' });
    const config = {
      responderModel: 'claude-haiku-4-5',
      responderEffort: 'low',
      codexResponderModel: 'gpt-5.6-luna',
      codexResponderEffort: 'high',
    };
    expect(responderSettings('codex-cli', config)).toEqual({ model: 'gpt-5.6-luna', effort: 'high' });
    expect(responderSettings('claude-cli', config)).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
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
