import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readConfig, writeConfig } from '../shared/config.js';
import { resolveResponder } from '../responders/index.js';
import type { ResponderRequest } from '../responders/types.js';
import type { Store, StoredEvent } from '../store/store.js';

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

/** Fans ingested events out to open SSE connections, per session. */
export class SseHub {
  private clients = new Map<string, Set<import('node:http').ServerResponse>>();

  subscribe(sessionId: string, res: import('node:http').ServerResponse): void {
    let set = this.clients.get(sessionId);
    if (!set) this.clients.set(sessionId, (set = new Set()));
    set.add(res);
    res.on('close', () => { set.delete(res); });
  }

  broadcast(sessionId: string, events: StoredEvent[]): void {
    const set = this.clients.get(sessionId);
    if (!set?.size) return;
    const payload = `data: ${JSON.stringify(events)}\n\n`;
    for (const res of set) res.write(payload);
  }
}

const STAT_EVENTS = new Set(['viewer_open', 'question_asked']);

export function buildServer(store: Store, hub: SseHub,
    liveSessionIds: () => Set<string> = () => new Set()): FastifyInstance {
  const app = Fastify({ logger: false });

  if (fs.existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
    // SPA fallback: non-/api paths serve the app shell
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.get<{ Querystring: { includeLastOpen?: string } }>('/api/health', (req) => {
    const base = { ok: true, pid: process.pid };
    if (req.query.includeLastOpen) {
      return { ...base, lastViewerOpen: Number(store.getKv('last_viewer_open') ?? 0) };
    }
    return base;
  });

  /** Mark sessions whose agent process is mid-turn (see AgentAdapter.liveSessionIds). */
  const withLive = <T extends { id: string }>(metas: T[]): T[] => {
    const live = liveSessionIds();
    return live.size ? metas.map((m) => (live.has(m.id) ? { ...m, live: true } : m)) : metas;
  };

  app.get<{ Querystring: { project?: string; q?: string } }>('/api/sessions', (req) =>
    withLive(store.listSessions({ project: req.query.project, q: req.query.q })));

  app.get<{ Params: { id: string }; Querystring: { before_seq?: string; limit?: string; m?: string } }>(
    '/api/sessions/:id', (req, reply) => {
      const session = store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: 'not found' });
      let beforeSeq = req.query.before_seq ? Number(req.query.before_seq) : undefined;
      if (req.query.m) {
        // window ending shortly after the target message (search jump)
        const seq = store.getMessageSeq(req.params.id, req.query.m);
        if (seq !== null) beforeSeq = seq + 100;
      }
      const events = store.getEvents(req.params.id, {
        beforeSeq,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return { session: withLive([session])[0], events };
    });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    hub.subscribe(req.params.id, reply.raw);
    // reply stays open; fastify must not touch it further
    return reply;
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', (req) =>
    store.search(req.query.q ?? ''));

  app.get('/api/responder/status', async () => {
    const engine = await resolveResponder();
    const { responderModel, responderEffort } = readConfig();
    // never expose apiKey to the frontend
    return { engine: engine?.id ?? null, responderModel: responderModel ?? '', responderEffort: responderEffort ?? '' };
  });

  const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);

  app.put<{ Body: { responderModel?: string; responderEffort?: string } }>(
    '/api/responder/config', (req, reply) => {
      const { responderModel, responderEffort } = req.body ?? {};
      if (responderEffort !== undefined && !EFFORTS.has(responderEffort)) {
        return reply.code(400).send({ error: 'invalid effort' });
      }
      writeConfig({ responderModel, responderEffort });
      return { ok: true };
    });

  app.get<{ Querystring: { sessionId?: string } }>('/api/side-chats', (req, reply) => {
    if (!req.query.sessionId) return reply.code(400).send({ error: 'sessionId required' });
    return store.listSideChats(req.query.sessionId);
  });

  app.post<{ Body: { sessionId?: string; anchorMessageId?: string; anchorText?: string } }>(
    '/api/side-chats', (req, reply) => {
      const { sessionId, anchorMessageId, anchorText } = req.body ?? {};
      if (!sessionId || !anchorMessageId || !anchorText) {
        return reply.code(400).send({ error: 'sessionId, anchorMessageId, anchorText required' });
      }
      if (!store.getSession(sessionId)) return reply.code(404).send({ error: 'session not found' });
      return store.createSideChat(sessionId, anchorMessageId, anchorText);
    });

  // one in-flight answer per side chat
  const running = new Map<string, AbortController>();

  app.post<{ Params: { id: string }; Body: { question?: string } }>(
    '/api/side-chats/:id/ask', async (req, reply) => {
      const chat = store.getSideChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: 'not found' });
      const question = req.body?.question?.trim();
      if (!question) return reply.code(400).send({ error: 'question required' });
      const session = store.getSession(chat.sessionId);
      if (!session) return reply.code(404).send({ error: 'session not found' });

      const engine = await resolveResponder();
      if (!engine) return reply.code(409).send({ error: 'no responder engine available' });

      running.get(chat.id)?.abort();
      const ctrl = new AbortController();
      running.set(chat.id, ctrl);

      // persist the question immediately — must survive a daemon crash mid-answer
      store.appendSideChatTurn(chat.id, { role: 'user', text: question, ts: Date.now() });
      store.incrementStat('question_asked');

      const request: ResponderRequest = {
        question,
        anchorText: chat.anchorText,
        sessionFilePath: session.filePath,
        projectDir: session.projectDir,
        priorTurns: chat.turns.map(({ role, text }) => ({ role, text })),
      };
      if (engine.id === 'api') {
        request.inlineContext = store.inlineContext(chat.sessionId, chat.anchorMessageId);
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctrl.abort(); });
      const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ engine: engine.id });
      try {
        const answer = await engine.answer(request, (text) => send({ text }), ctrl.signal,
          (status) => send({ status }));
        store.appendSideChatTurn(chat.id, { role: 'assistant', text: answer, ts: Date.now() });
        send({ done: true });
      } catch (e) {
        send({ error: ctrl.signal.aborted ? 'canceled' : String(e), engine: engine.id });
      } finally {
        if (running.get(chat.id) === ctrl) running.delete(chat.id);
        reply.raw.end();
      }
      return reply;
    });

  app.post<{ Params: { id: string } }>('/api/side-chats/:id/cancel', (req) => {
    running.get(req.params.id)?.abort();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/side-chats/:id', (req) => {
    running.get(req.params.id)?.abort();
    store.deleteSideChat(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { event: string } }>('/api/stats/:event', (req, reply) => {
    if (!STAT_EVENTS.has(req.params.event)) return reply.code(400).send({ error: 'unknown event' });
    store.incrementStat(req.params.event);
    if (req.params.event === 'viewer_open') store.setKv('last_viewer_open', String(Date.now()));
    return { ok: true };
  });

  return app;
}
