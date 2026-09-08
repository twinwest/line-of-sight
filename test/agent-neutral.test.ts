import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Line of Sight is agent-agnostic, and so is its own contributor guide.
// AGENTS.md is the single source; a vendor-named file exists only because a
// CLI insists on its own name (Claude Code reads CLAUDE.md, never AGENTS.md),
// and then only as a pointer: a symlink, or an `@AGENTS.md` import. Anything
// that carries the guide's own lines is a second copy, and copies drift.
const ROOT = path.join(__dirname, '..');
const VENDOR = /^(CLAUDE|CODEX|GEMINI|QWEN|AGENT)\.md$|^\.(cursorrules|windsurfrules|clinerules)$/;
const IMPORT = /^@AGENTS\.md\s*$/m;

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function forked(file: string, guide: Set<string>): boolean {
  const p = path.join(ROOT, file);
  if (fs.lstatSync(p).isSymbolicLink()) return fs.readlinkSync(p) !== 'AGENTS.md';
  const text = fs.readFileSync(p, 'utf8');
  return !IMPORT.test(text) || lines(text).some((l) => guide.has(l));
}

describe('one contributor guide', () => {
  it('AGENTS.md is the source', () => {
    expect(fs.lstatSync(path.join(ROOT, 'AGENTS.md')).isFile()).toBe(true);
  });

  it('vendor-named instruction files only ever point to it', () => {
    const guide = new Set(lines(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')));
    expect(fs.readdirSync(ROOT).filter((f) => VENDOR.test(f) && forked(f, guide))).toEqual([]);
  });
});
