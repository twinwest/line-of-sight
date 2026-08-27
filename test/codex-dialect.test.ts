import { describe, expect, it } from 'vitest';
import { codexDialect } from '../src/shared/dialects/codex.js';
import type { RenderBlock } from '../src/shared/types.js';

// Shapes lifted from a real codex-tui 0.150.1 session (2026-08-27) — these
// pin the exact strings the parsing must survive.

const ASK_ARGS = {
  questions: [{
    header: 'Optimization goal', id: 'optimization_goal', question: 'Which area should be optimized first?',
    options: [
      { label: 'Reliability first (Recommended)', description: 'Fill in API/SSE/end-to-end tests.' },
      { label: 'User experience', description: 'Improve search and live updates.' },
    ],
  }],
};
const ASK_OUTPUT = '{"answers":{"optimization_goal":{"answers":["User experience"]}}}';

const use = (toolName: string, input: unknown): RenderBlock =>
  ({ type: 'tool_use', id: 'call_1', toolName, summary: toolName, input });

describe('codexDialect.askQuestions', () => {
  it('parses the real request_user_input shape, id carried for answers', () => {
    const b = use('request_user_input', ASK_ARGS);
    expect(codexDialect.isBlockingUse(b)).toBe(true);
    const qs = codexDialect.askQuestions(b)!;
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({
      question: 'Which area should be optimized first?', header: 'Optimization goal',
      id: 'optimization_goal', multiSelect: false,
    });
    expect(qs[0]!.options[1]).toMatchObject({ label: 'User experience' });
  });

  it('rejects drifted shapes and other tools instead of guessing', () => {
    expect(codexDialect.askQuestions(use('request_user_input', null))).toBeNull();
    expect(codexDialect.askQuestions(use('request_user_input', { questions: [{}] }))).toBeNull();
    expect(codexDialect.askQuestions(use('exec', ASK_ARGS))).toBeNull();
    expect(codexDialect.isBlockingUse(use('exec', {}))).toBe(false);
  });
});

describe('codexDialect.chosenAnswer', () => {
  const q = codexDialect.askQuestions(use('request_user_input', ASK_ARGS))![0]!;
  it('looks the answer up by question id in the structured output', () => {
    expect(codexDialect.chosenAnswer(ASK_OUTPUT, q)).toBe('User experience');
  });
  it('drift returns null: bad json, missing id, empty answers', () => {
    expect(codexDialect.chosenAnswer('not json', q)).toBeNull();
    expect(codexDialect.chosenAnswer('{"answers":{}}', q)).toBeNull();
    expect(codexDialect.chosenAnswer('{"answers":{"optimization_goal":{"answers":[]}}}', q)).toBeNull();
    expect(codexDialect.chosenAnswer(ASK_OUTPUT, { ...q, id: undefined })).toBeNull();
  });
  it('multiple answers join for display', () => {
    expect(codexDialect.chosenAnswer(
      '{"answers":{"optimization_goal":{"answers":["a","b"]}}}', q)).toBe('a, b');
  });
});

describe('codexDialect.editDiff', () => {
  it('add → whole-file pair; update → one pair per unified-diff hunk', () => {
    // real apply_patch update from the greet.py spike session
    const diff = '@@ -4,3 +4,8 @@\n \n+def farewell():\n+    print("Goodbye, world!")\n+\n+\n if __name__ == "__main__":\n     hello()\n+    farewell()\n';
    const pairs = codexDialect.editDiff(use('apply_patch', {
      '/x/greet.py': { type: 'update', unified_diff: diff, move_path: null },
      '/x/new.py': { type: 'add', content: 'x = 1' },
    }))!;
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.oldText).toBe('\nif __name__ == "__main__":\n    hello()');
    expect(pairs[0]!.newText).toContain('def farewell():');
    expect(pairs[0]!.newText).toContain('    farewell()');
    expect(pairs[1]).toEqual({ oldText: '', newText: 'x = 1' });
  });

  it('unknown change kinds are skipped; nothing usable → null', () => {
    expect(codexDialect.editDiff(use('apply_patch', {
      '/x/a.py': { type: 'mystery' },
    }))).toBeNull();
    expect(codexDialect.editDiff(use('exec', {}))).toBeNull();
  });
});

describe('codexDialect inert surfaces', () => {
  it('no plan cards, no queue, plumbing only on a leaked wrapper', () => {
    expect(codexDialect.isPlanUse(use('plan', {}))).toBe(false);
    expect(codexDialect.planDraft(use('apply_patch', {}))).toBeNull();
    expect(codexDialect.queuedInputs([])).toEqual([]);
    expect(codexDialect.plumbing('ordinary input')).toBeNull();
    expect(codexDialect.plumbing('<environment_context>x'))
      .toMatchObject({ tag: 'environment_context' });
  });
});
