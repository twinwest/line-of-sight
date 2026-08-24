import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '../src/shared/config.js';

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
});
