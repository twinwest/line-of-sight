import { describe, expect, it } from 'vitest';
import { parsePlumbing } from '../web/src/plumbing.js';

describe('parsePlumbing', () => {
  it('human prompts pass through as null', () => {
    expect(parsePlumbing('fix this bug')).toBeNull();
    expect(parsePlumbing('  fix < 3 issues')).toBeNull();  // '<' not at start
  });

  it('generic plumbing gets its tag as label', () => {
    expect(parsePlumbing('<local-command-stdout>ok</local-command-stdout>'))
      .toMatchObject({ tag: 'local-command-stdout', label: 'local-command-stdout', result: null });
    expect(parsePlumbing('<command-name>/model</command-name>'))
      .toMatchObject({ tag: 'command-name' });
  });

  it('task-notification extracts summary label and markdown result', () => {
    const text = '<task-notification> <task-id>abc</task-id> '
      + '<status>completed</status> <summary>Agent "Map demand signals" finished</summary> '
      + '<note>fires each time</note> <result>## Research value: high\n\ndetails here</result>';
    const p = parsePlumbing(text)!;
    expect(p.tag).toBe('task-notification');
    expect(p.label).toBe('Agent "Map demand signals" finished');
    expect(p.result).toContain('## Research value: high');
    expect(p.result).not.toContain('<result>');
  });

  it('task-notification without closing result tag still extracts', () => {
    const p = parsePlumbing('<task-notification><summary>s</summary><result>partial…')!;
    expect(p.result).toBe('partial…');
  });
});
