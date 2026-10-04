import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SightConfig } from '../src/shared/config.js';

// the real config lives in ~/.sight; keep this test's writes in memory
let stored: SightConfig = {};
vi.mock('../src/shared/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/shared/config.js')>()),
  readConfig: () => stored,
  writeConfig: (patch: Partial<SightConfig>) => (stored = { ...stored, ...patch }),
}));

const { claudeCliResponder } = await import('../src/responders/claudeCli.js');
const { buildServer, SseHub } = await import('../src/daemon/server.js');
const { Store } = await import('../src/store/store.js');

afterEach(() => { stored = {}; vi.restoreAllMocks(); });

describe('the Ask web search switch', () => {
  it('is off by default, saved through the panel endpoint, reported by status', async () => {
    vi.spyOn(claudeCliResponder, 'available').mockResolvedValue(true);
    const app = buildServer(new Store(':memory:'), new SseHub());
    try {
      const status = async () => (await app.inject('/api/responder/status?adapter=claude-code')).json();
      expect((await status()).responderWebSearch).toBe(false);

      const on = await app.inject({ method: 'PUT', url: '/api/responder/config',
        payload: { engine: 'claude-cli', responderWebSearch: true } });
      expect(on.json()).toMatchObject({ ok: true, webSearch: true });
      expect((await status()).responderWebSearch).toBe(true);

      const bad = await app.inject({ method: 'PUT', url: '/api/responder/config',
        payload: { engine: 'claude-cli', responderWebSearch: 'yes' } });
      expect(bad.statusCode).toBe(400);
      expect(stored.responderWebSearch).toBe(true);
    } finally { await app.close(); }
  });
});
