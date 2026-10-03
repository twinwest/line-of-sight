import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexModels } from '../src/shared/codexModels.js';
import { codexDefaultModel } from '../src/shared/config.js';

/** A models_cache.json as codex 0.153.4 writes it, trimmed to the fields read. */
function cache(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-codex-')), 'models_cache.json');
  fs.writeFileSync(file, body);
  return file;
}

describe('codexModels', () => {
  it("lists the models Codex's own picker shows, in its order", () => {
    const file = cache(JSON.stringify({
      fetched_at: '2026-10-02T23:08:56Z', client_version: '0.153.4',
      models: [
        { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
        { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
        { slug: 'gpt-5.6-terra', visibility: 'list', priority: 8 },
        { visibility: 'list' },
        null,
      ],
    }));
    expect(codexModels(file)).toEqual(['gpt-6-astra', 'gpt-5.6-terra']);
  });

  it('reads anything unexpected as unknown, never throws', () => {
    expect(codexModels('/nonexistent/models_cache.json')).toEqual([]);
    expect(codexModels(cache('{not json'))).toEqual([]);
    expect(codexModels(cache('{"models": {"slug": "x"}}'))).toEqual([]);
    expect(codexModels(cache('[]'))).toEqual([]);
  });
});

describe('codexDefaultModel', () => {
  it("keeps Sight's default while Codex lists it, or when the list is unknown", () => {
    expect(codexDefaultModel([])).toBe('gpt-5.6-terra');
    expect(codexDefaultModel(['gpt-6-astra', 'gpt-5.6-terra'])).toBe('gpt-5.6-terra');
  });

  it("falls to Codex's first pick once the default is retired", () => {
    expect(codexDefaultModel(['gpt-6-astra', 'gpt-6-luna'])).toBe('gpt-6-astra');
  });
});
