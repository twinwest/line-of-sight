import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Responder } from '../src/responders/types.js';

// the engine is resolved inside the route; swap it for one we can hold open
let answering: { resolve: (s: string) => void; signal: AbortSignal } | null = null;
const fake: Responder = {
  id: 'fake' as Responder['id'],
  available: async () => true,
  answer: (_req, onChunk, signal) => new Promise((resolve, reject) => {
    onChunk('partial');
    answering = { resolve, signal };
    signal.addEventListener('abort', () => reject(new Error('canceled')));
  }),
};
vi.mock('../src/responders/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/responders/index.js')>()),
  resolveResponder: async () => fake,
}));

const { buildServer, SseHub } = await import('../src/daemon/server.js');
const { Store } = await import('../src/store/store.js');

/** A listening server with one session and one side chat, plus its base URL. */
async function serve() {
  const store = new Store(':memory:');
  store.upsertSession({
    id: 's1', adapter: 'claude-code', filePath: '/f1', projectDir: '/p',
    title: 's', startedAt: 0, updatedAt: 0, messageCount: 0,
  });
  const chat = store.createSideChat('s1', 'm1', 'anchor');
  const app = buildServer(store, new SseHub());
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { store, chat, url, app };
}

/** POST an ask and return once its first chunk has arrived. */
async function startAsk(url: string, chatId: string, signal: AbortSignal) {
  const res = await fetch(`${url}/api/side-chats/${chatId}/ask`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'why?' }),
  });
  await res.body!.getReader().read();
  await vi.waitFor(() => expect(answering).not.toBeNull());
}

afterEach(() => { answering = null; });

describe('an ask outlives its HTTP connection', () => {
  it('a dropped client does not cancel the answer, and it still persists', async () => {
    const { store, chat, url, app } = await serve();
    const ctrl = new AbortController();
    await startAsk(url, chat.id, ctrl.signal);

    ctrl.abort();   // tab closed / reloaded / discarded mid-answer
    // proving a negative: give the server time to see the dead socket first
    await new Promise((r) => setTimeout(r, 150));
    expect(answering!.signal.aborted).toBe(false);
    answering!.resolve('the answer');

    await vi.waitFor(() => {
      expect(store.getSideChat(chat.id)!.turns).toMatchObject([
        { role: 'user', text: 'why?' }, { role: 'assistant', text: 'the answer' },
      ]);
    });
    await app.close();
  });

  it('an explicit cancel still aborts it, and nothing is persisted', async () => {
    const { store, chat, url, app } = await serve();
    await startAsk(url, chat.id, new AbortController().signal);

    await fetch(`${url}/api/side-chats/${chat.id}/cancel`, { method: 'POST' });
    await vi.waitFor(() => expect(answering!.signal.aborted).toBe(true));
    expect(store.getSideChat(chat.id)!.turns).toMatchObject([{ role: 'user', text: 'why?' }]);
    await app.close();
  });
});
