import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponderRequest } from '../src/responders/types.js';

// A pre-spawned process is only observable through spawn() and its stdin, so
// both are faked here; nothing in this file starts a real `claude`.
const spawn = vi.fn(() => new FakeChild());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawn(...(args as [])),
}));

let config: { responderModel?: string; responderEffort?: string } = {};
vi.mock('../src/shared/config.js', () => ({ readConfig: () => config }));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  written = '';
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = { end: (s: string) => { this.written = s; }, on: () => {} };
  kill(): boolean { this.killed = true; return true; }
}

const { claudeCliResponder } = await import('../src/responders/claudeCli.js');

const ask = (chatId: string): ResponderRequest => ({
  chatId, question: 'why?', anchorText: 'anchor',
  sessionFilePath: '/p/abc.jsonl', projectDir: '/proj', priorTurns: [],
});

/** Answer text as the CLI streams it, then a clean exit. */
function finish(child: FakeChild, text: string): void {
  child.stdout.write(`${JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })}\n`);
  child.emit('close', 0);
}

const lastChild = () => spawn.mock.results.at(-1)!.value as FakeChild;

// Each test uses its own chat id: the warm slot is module state, and a slot
// left behind by an earlier test must not be mistaken for this test's.
beforeEach(() => { spawn.mockClear(); config = {}; });

describe('pre-spawned responder (#12)', () => {
  it('prewarm spawns a promptless process that reads stdin, with the cage intact', () => {
    claudeCliResponder.prewarm!('warm-args', '/proj');
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('claude');
    // -p with no positional prompt: the question arrives later over stdin
    expect(args.slice(0, 4)).toEqual(['-p', '--input-format', 'stream-json', '--allowedTools']);
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash');
  });

  it('the ask reuses the warm process, handing it the prompt over stdin', async () => {
    claudeCliResponder.prewarm!('warm-hit', '/proj');
    const child = lastChild();

    const chunks: string[] = [];
    const answer = claudeCliResponder.answer(ask('warm-hit'), (c) => chunks.push(c),
      new AbortController().signal);

    expect(spawn).toHaveBeenCalledOnce();          // no second process
    const msg = JSON.parse(child.written) as { type: string; message: { content: string } };
    expect(msg.type).toBe('user');
    expect(msg.message.content).toContain('QUESTION: why?');
    expect(msg.message.content).toContain('/p/abc.jsonl');

    finish(child, 'hi');
    await expect(answer).resolves.toBe('hi');
    expect(chunks).toEqual(['hi']);
  });

  it('with no warm process the ask spawns cold, prompt on the command line', async () => {
    const answer = claudeCliResponder.answer(ask('no-warm'), () => {},
      new AbortController().signal);
    expect(spawn).toHaveBeenCalledOnce();
    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('QUESTION: why?');
    expect(args).not.toContain('--input-format');
    finish(lastChild(), 'cold');
    await expect(answer).resolves.toBe('cold');
  });

  it('a warm process belonging to another chat is not used', async () => {
    // it was spawned in that chat's project directory — Read/Grep there would
    // resolve against the wrong repo
    claudeCliResponder.prewarm!('warm-other', '/other-proj');
    const other = lastChild();

    const answer = claudeCliResponder.answer(ask('warm-mine'), () => {},
      new AbortController().signal);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(other.written).toBe('');
    finish(lastChild(), 'cold');
    await expect(answer).resolves.toBe('cold');
  });

  it('a warm process that died is not used — the ask spawns cold', async () => {
    claudeCliResponder.prewarm!('warm-dead', '/proj');
    lastChild().exitCode = 1;

    const answer = claudeCliResponder.answer(ask('warm-dead'), () => {},
      new AbortController().signal);
    expect(spawn).toHaveBeenCalledTimes(2);
    finish(lastChild(), 'cold');
    await expect(answer).resolves.toBe('cold');
  });

  it('a model change after the pre-spawn falls back to a cold process', async () => {
    config = { responderModel: 'claude-haiku-4-5' };
    claudeCliResponder.prewarm!('warm-stale', '/proj');
    const stale = lastChild();
    config = { responderModel: 'claude-opus-5' };

    const answer = claudeCliResponder.answer(ask('warm-stale'), () => {},
      new AbortController().signal);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(stale.written).toBe('');                // the stale standby got nothing
    const args = (spawn.mock.calls[1] as unknown as [string, string[]])[1];
    expect(args.slice(-2)).toEqual(['--model', 'claude-opus-5']);
    finish(lastChild(), 'cold');
    await expect(answer).resolves.toBe('cold');
  });

  it('cancel kills the warm process', async () => {
    claudeCliResponder.prewarm!('warm-cancel', '/proj');
    const child = lastChild();
    const ctrl = new AbortController();
    const answer = claudeCliResponder.answer(ask('warm-cancel'), () => {}, ctrl.signal);
    ctrl.abort();
    expect(child.killed).toBe(true);
    child.emit('close', null);
    await expect(answer).rejects.toThrow('canceled');
  });
});
