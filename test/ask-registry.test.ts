import { describe, expect, it, vi } from 'vitest';
import { getAsk, runAsk } from '../web/src/api.js';

/** A fake SSE response we can feed frame by frame, like the daemon does. */
function sseFetch() {
  let push!: (frame: unknown) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      push = (frame) => c.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
      close = () => c.close();
    },
  });
  vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
  return { push, close };
}

describe('the ask registry outlives the panel', () => {
  it('holds the question and the streaming answer under the chat id', async () => {
    const { push, close } = sseFetch();
    const done = runAsk('c1', 'why?', [{ role: 'user', text: 'earlier', ts: 0 }]);

    // the question is visible immediately — this is what a remounted panel reads
    expect(getAsk('c1')).toMatchObject({
      turns: [{ text: 'earlier' }, { role: 'user', text: 'why?' }],
      question: 'why?', streaming: '',
    });

    push({ status: 'Read' });
    push({ text: 'be' });
    push({ text: 'cause' });
    await vi.waitFor(() => expect(getAsk('c1')).toMatchObject({ streaming: 'because', progress: 'Read' }));

    close();
    await done;
    expect(getAsk('c1')).toMatchObject({
      turns: [{ text: 'earlier' }, { text: 'why?' }, { role: 'assistant', text: 'because' }],
      streaming: null, progress: '',
    });
  });
});
