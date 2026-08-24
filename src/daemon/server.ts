import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
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

export function buildServer(store: Store, hub: SseHub): FastifyInstance {
  const app = Fastify({ logger: false });

  if (fs.existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
    // SPA fallback: non-/api paths serve the app shell
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.get('/api/health', () => ({ ok: true, pid: process.pid }));

  app.get<{ Querystring: { project?: string; q?: string } }>('/api/sessions', (req) =>
    store.listSessions({ project: req.query.project, q: req.query.q }));

  app.get<{ Params: { id: string }; Querystring: { before_seq?: string; limit?: string } }>(
    '/api/sessions/:id', (req, reply) => {
      const session = store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: 'not found' });
      const events = store.getEvents(req.params.id, {
        beforeSeq: req.query.before_seq ? Number(req.query.before_seq) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return { session, events };
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

  app.post<{ Params: { event: string } }>('/api/stats/:event', (req, reply) => {
    if (!STAT_EVENTS.has(req.params.event)) return reply.code(400).send({ error: 'unknown event' });
    store.incrementStat(req.params.event);
    return { ok: true };
  });

  return app;
}
