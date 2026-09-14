import { describe, expect, it } from 'vitest';
import { buildServer, SseHub } from '../src/daemon/server.js';
import { Store } from '../src/store/store.js';

describe('daemon shutdown', () => {
  it('app.close() resolves with an SSE stream still open', async () => {
    const store = new Store(':memory:');
    const app = buildServer(store, new SseHub());
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/sessions/s1/stream`, { signal: ctrl.signal });
    await res.body!.getReader().read();   // ': connected' — the stream is live
    // Fastify's default only drops idle sockets; this hung forever
    await expect(Promise.race([
      app.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('close hung')), 2000)),
    ])).resolves.toBeUndefined();
    ctrl.abort();
  });
});
