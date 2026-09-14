import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCliResponder } from '../src/responders/claudeCli.js';
import { codexCliResponder } from '../src/responders/codexCli.js';
import { Store } from '../src/store/store.js';
import { buildServer, SseHub } from '../src/daemon/server.js';

vi.mock('../src/shared/config.js', async orig => ({
  ...(await orig<typeof import('../src/shared/config.js')>()),
  readConfig: () => ({ responder: 'claude-cli' }),
}));
afterEach(() => vi.restoreAllMocks());

describe('Ask strictly matches the session CLI', () => {
  it.each(['codex', 'claude-code'] as const)('does not fall back for an unavailable %s CLI', async adapter => {
    const match = adapter === 'codex' ? codexCliResponder : claudeCliResponder;
    const other = adapter === 'codex' ? claudeCliResponder : codexCliResponder;
    vi.spyOn(match, 'available').mockResolvedValue(false);
    const otherAvailable = vi.spyOn(other, 'available').mockResolvedValue(true);
    const otherAnswer = vi.spyOn(other, 'answer');
    const store = new Store(':memory:');
    const app = buildServer(store, new SseHub());
    try {
      store.upsertSession({ id: 's', adapter, filePath: '/synthetic/session.jsonl', projectDir: null,
        title: '', startedAt: 0, updatedAt: 0, messageCount: 0, parentId: null, toolUseId: null });
      const chat = store.createSideChat('s', 'm', 'anchor');
      const status = await app.inject(`/api/responder/status?adapter=${adapter}`);
      expect(status.json()).toMatchObject({ engine: null, error: expect.stringContaining(adapter === 'codex' ? 'Codex' : 'Claude') });
      const answer = await app.inject({ method: 'POST', url: `/api/side-chats/${chat.id}/ask`, payload: { question: 'why?' } });
      expect(answer.statusCode).toBe(409);
      expect(answer.json().error).toContain(match.id);
      expect(otherAvailable).not.toHaveBeenCalled();
      expect(otherAnswer).not.toHaveBeenCalled();
      expect(store.getSideChat(chat.id)?.turns).toEqual([]);
    } finally { await app.close(); store.close(); }
  });

  it('ignores a legacy Claude pin when probing a Codex session and prewarming its chat', async () => {
    vi.spyOn(codexCliResponder, 'available').mockResolvedValue(true);
    const claudeAvailable = vi.spyOn(claudeCliResponder, 'available').mockResolvedValue(true);
    const claudeWarm = vi.spyOn(claudeCliResponder, 'prewarm');
    const store = new Store(':memory:');
    const app = buildServer(store, new SseHub());
    try {
      store.upsertSession({ id: 's', adapter: 'codex', filePath: '/synthetic/session.jsonl', projectDir: null,
        title: '', startedAt: 0, updatedAt: 0, messageCount: 0, parentId: null, toolUseId: null });
      expect((await app.inject('/api/responder/status?adapter=codex')).json().engine).toBe('codex-cli');
      await app.inject({ method: 'POST', url: '/api/side-chats', payload: { sessionId: 's', anchorMessageId: 'm', anchorText: 'anchor' } });
      expect(claudeAvailable).not.toHaveBeenCalled();
      expect(claudeWarm).not.toHaveBeenCalled();
      expect((await app.inject('/api/responder/status')).json().engine).toBeNull();
      expect((await app.inject('/api/responder/status?adapter=unknown')).json().engine).toBeNull();
    } finally { await app.close(); store.close(); }
  });
});
