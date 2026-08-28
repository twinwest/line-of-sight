import { describe, expect, it } from 'vitest';
import { claudeCodeDialect } from '../src/shared/dialects/index.js';
import type { RenderBlock, StoredEvent } from '../src/shared/types.js';
import { pendingBlockId, toolOutcomes } from '../src/shared/outcomes.js';

const { planMarkdown } = claudeCodeDialect;
// the dialect methods take blocks/AskQuestions; the raw-shape assertions predate that
const askQuestions = (input: unknown) => claudeCodeDialect.askQuestions(
  { type: 'tool_use', id: null, toolName: 'AskUserQuestion', summary: '', input });
const chosenAnswer = (output: string, question: string) => claudeCodeDialect.chosenAnswer(
  output, { question, header: '', multiSelect: false, options: [] });

// Shapes below are lifted from real Claude Code transcripts (2026-08), not
// invented — the parsing is substring-based on purpose, and these pin the
// exact strings it must survive.

const ASK_INPUT = {
  questions: [{
    question: 'Where should the two sliders go?',
    header: 'Control placement',
    multiSelect: false,
    options: [
      { label: 'Aa button + popover (Recommended)', description: 'One chip in the top bar', preview: '┌─┐\n└─┘' },
      { label: 'Two sliders always in the top bar', description: 'Drag any time' },
    ],
  }],
};

const ASK_RESULT = 'Your questions have been answered: "Where should the two sliders go?"="Aa button + popover (Recommended)"'
  + ' selected preview:\n┌─┐\n└─┘, "What does the size slider scale?"="Whole app (Recommended)". You can now continue.';

describe('askQuestions', () => {
  it('parses the real input shape, preview optional', () => {
    const qs = askQuestions(ASK_INPUT);
    expect(qs).toHaveLength(1);
    expect(qs![0]).toMatchObject({ question: 'Where should the two sliders go?', header: 'Control placement', multiSelect: false });
    expect(qs![0]!.options[0]!.preview).toContain('┌');
    expect(qs![0]!.options[1]!.preview).toBeUndefined();
  });

  it('rejects drifted shapes instead of guessing', () => {
    expect(askQuestions(null)).toBeNull();
    expect(askQuestions({ questions: 'x' })).toBeNull();
    expect(askQuestions({ questions: [] })).toBeNull();
    expect(askQuestions({ questions: [{ question: 'q', options: [{}] }] })).toBeNull();
  });
});

describe('chosenAnswer', () => {
  it('lifts each answer from the real result string, previews and all', () => {
    expect(chosenAnswer(ASK_RESULT, 'Where should the two sliders go?')).toBe('Aa button + popover (Recommended)');
    expect(chosenAnswer(ASK_RESULT, 'What does the size slider scale?')).toBe('Whole app (Recommended)');
    expect(chosenAnswer(ASK_RESULT, 'not asked')).toBeNull();
    expect(chosenAnswer('The user doesn\'t want to proceed', 'Where should the two sliders go?')).toBeNull();
  });
});

describe('planMarkdown', () => {
  it('prefers input.plan, falls back to the approval echo', () => {
    expect(planMarkdown({ plan: '# Plan\nbody' }, null)).toBe('# Plan\nbody');
    const approval = 'User has approved your plan. …\n\n## Approved Plan:\n# Plan\nbody';
    expect(planMarkdown({}, approval)).toBe('# Plan\nbody');
    expect(planMarkdown({}, null)).toBeNull();
    expect(planMarkdown({ plan: '  ' }, 'rejected')).toBeNull();
  });
});

describe('toolOutcomes + pendingBlockId', () => {
  let seq = 0;
  const msg = (id: string, role: 'user' | 'assistant', body: RenderBlock[]): StoredEvent =>
    ({ id, seq: ++seq, kind: 'message', role, ts: 0, body });
  const ask = (id: string, useId: string | null): StoredEvent =>
    msg(id, 'assistant', [{ type: 'tool_use', id: useId, toolName: 'AskUserQuestion', summary: 'AskUserQuestion', input: ASK_INPUT }]);
  const result = (id: string, useId: string): StoredEvent =>
    msg(id, 'user', [{ type: 'tool_result', toolUseId: useId, summary: 'ok', output: ASK_RESULT, isError: false }]);

  it('an unanswered blocking use at the tail is pending; answered is not', () => {
    const waiting = [ask('a1', 't1')];
    expect(pendingBlockId(waiting, toolOutcomes(waiting), claudeCodeDialect)).toBe('a1');
    const answered = [ask('a1', 't1'), result('r1', 't1')];
    expect(pendingBlockId(answered, toolOutcomes(answered), claudeCodeDialect)).toBeNull();
  });

  it('pre-id rows and ordinary tail messages never read as pending', () => {
    const oldData = [ask('a1', null)];
    expect(pendingBlockId(oldData, toolOutcomes(oldData), claudeCodeDialect)).toBeNull();
    const prose = [ask('a1', 't1'), result('r1', 't1'),
      msg('m1', 'assistant', [{ type: 'text', markdown: 'ok' }])];
    expect(pendingBlockId(prose, toolOutcomes(prose), claudeCodeDialect)).toBeNull();
  });
});
