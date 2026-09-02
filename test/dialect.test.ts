import { describe, expect, it } from 'vitest';
import { dialectFor, genericDialect, resumeCommand } from '../src/shared/dialects/index.js';
import type { RenderBlock, StoredEvent } from '../src/shared/types.js';

describe('dialectFor', () => {
  it('each agent gets its dialect and badge label', () => {
    expect(dialectFor('claude-code').displayName).toBe('claude');
    expect(dialectFor('codex').displayName).toBe('codex');
  });
});

// Pins the fallback contract for future agents without a dialect: the
// defensive floor — no cards, no queue strip, no plumbing detection.
describe('genericDialect', () => {
  it('is inert on shapes that would trigger the claude dialect', () => {
    const d = genericDialect;
    const tool: RenderBlock = {
      type: 'tool_use', id: 'i', toolName: 'AskUserQuestion', summary: '', input: {},
    };
    expect(d.isBlockingUse(tool)).toBe(false);
    expect(d.askQuestions(tool)).toBeNull();
    expect(d.chosenAnswer('"q"="a"', { question: 'q', header: '', multiSelect: false, options: [] }))
      .toBeNull();
    expect(d.isPlanUse({ ...tool, toolName: 'ExitPlanMode' })).toBe(false);
    expect(d.planMarkdown({ plan: '# p' }, null)).toBeNull();
    expect(d.planDraft({ ...tool, toolName: 'Write',
      input: { file_path: '/u/.claude/plans/x.md', content: '# p' } })).toBeNull();
    expect(d.editDiff({ ...tool, toolName: 'Edit',
      input: { old_string: 'a', new_string: 'b' } })).toBeNull();
    expect(d.plumbing('<task-notification>x')).toBeNull();
    expect(d.resumeArgv('x')).toBeNull();
    const queueOp: StoredEvent = {
      id: 'e', seq: 1, kind: 'meta', role: null, ts: 0,
      body: { label: 'queue-operation', raw: { operation: 'enqueue', content: 'x' } },
    };
    expect(d.isQueueOp(queueOp)).toBe(false);
    expect(d.queuedInputs([queueOp])).toEqual([]);
  });
});

describe('resumeCommand', () => {
  it("cd + the agent's own resume argv, directory shell-quoted", () => {
    expect(resumeCommand(dialectFor('claude-code'), 'a1b2-c3', "/Users/x/it's"))
      .toBe("cd '/Users/x/it'\\''s' && claude --resume a1b2-c3");
    expect(resumeCommand(dialectFor('codex'), 'a1b2-c3', null)).toBe('codex resume a1b2-c3');
  });

  it('null for agents without resume, and for ids that are not plain tokens', () => {
    expect(resumeCommand(genericDialect, 'a1', '/p')).toBeNull();
    for (const bad of ['-x', 'a b', 'a;rm', '../x', ''])
      expect(resumeCommand(dialectFor('claude-code'), bad, '/p')).toBeNull();
  });
});
