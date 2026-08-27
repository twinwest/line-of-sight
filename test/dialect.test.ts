import { describe, expect, it } from 'vitest';
import { dialectFor } from '../src/shared/dialects/index.js';
import type { RenderBlock, StoredEvent } from '../src/shared/types.js';

// Pins the fallback contract the codex adapter task relies on: an agent
// without a dialect renders at the defensive floor — no cards, no queue
// strip, no plumbing detection.
describe('dialectFor', () => {
  it('claude-code gets its dialect and badge label', () => {
    expect(dialectFor('claude-code').displayName).toBe('claude');
  });

  it('codex falls back to generic with its own badge label', () => {
    const d = dialectFor('codex');
    expect(d.displayName).toBe('codex');
    // shapes that WOULD trigger the claude dialect must all be inert here
    const tool: RenderBlock = {
      type: 'tool_use', id: 'i', toolName: 'AskUserQuestion', summary: '', input: {},
    };
    expect(d.isBlockingUse(tool)).toBe(false);
    expect(d.askQuestions(tool)).toBeNull();
    expect(d.chosenAnswer('"q"="a"', 'q')).toBeNull();
    expect(d.isPlanUse({ ...tool, toolName: 'ExitPlanMode' })).toBe(false);
    expect(d.planMarkdown({ plan: '# p' }, null)).toBeNull();
    expect(d.planDraft({ ...tool, toolName: 'Write',
      input: { file_path: '/u/.claude/plans/x.md', content: '# p' } })).toBeNull();
    expect(d.editDiff({ ...tool, toolName: 'Edit',
      input: { old_string: 'a', new_string: 'b' } })).toBeNull();
    expect(d.plumbing('<task-notification>x')).toBeNull();
    const queueOp: StoredEvent = {
      id: 'e', seq: 1, kind: 'meta', role: null, ts: 0,
      body: { label: 'queue-operation', raw: { operation: 'enqueue', content: 'x' } },
    };
    expect(d.isQueueOp(queueOp)).toBe(false);
    expect(d.queuedInputs([queueOp])).toEqual([]);
  });
});
