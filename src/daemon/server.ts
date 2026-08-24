import Fastify, { type FastifyInstance } from 'fastify';
import type { Store } from '../store/store.js';

export function buildServer(store: Store): FastifyInstance {
  const app = Fastify({ logger: false });

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

  app.get<{ Querystring: { q?: string } }>('/api/search', (req) =>
    store.search(req.query.q ?? ''));

  return app;
}
