import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// SPEC B6: no network except responder invocations. This test makes the
// promise auditable — a grep
// over src/, so a stray fetch() can't ship silently.
const SRC = path.join(__dirname, '..', 'src');
const NET = /\bfetch\(|https?\.request\(|https?\.get\(|net\.connect\(|new WebSocket\(|from ['"](undici|axios|node-fetch|ws)['"]/;
// BYOK responder (the user's own key, ARCHITECTURE §6) and the CLI's
// localhost health probe are the only sanctioned call sites.
const ALLOWED = new Set(['responders/api.ts', 'cli/index.ts']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

describe('zero network (SPEC B6)', () => {
  it('no network calls outside the sanctioned sites', () => {
    const offenders = walk(SRC)
      .filter((f) => f.endsWith('.ts') && NET.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });

  it('the sanctioned sites only reach where they claim to', () => {
    const api = fs.readFileSync(path.join(SRC, 'responders/api.ts'), 'utf8');
    expect(api.match(/https?:\/\/[^'"`\s]+/g)).toEqual(['https://api.anthropic.com/v1/messages']);
    const cli = fs.readFileSync(path.join(SRC, 'cli/index.ts'), 'utf8');
    expect(cli.match(/https?:\/\/[^'"`\s$]+/g)).toEqual(['http://127.0.0.1:']);
  });

  it('daemon binds loopback only', () => {
    const main = fs.readFileSync(path.join(SRC, 'daemon/main.ts'), 'utf8');
    expect(main).toMatch(/listen\(\{[^}]*host: '127\.0\.0\.1'/);
  });

  it('no HTTP client in dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as
      { dependencies: Record<string, string> };
    for (const bad of ['axios', 'node-fetch', 'undici', 'ws', 'got']) {
      expect(pkg.dependencies).not.toHaveProperty(bad);
    }
  });
});
