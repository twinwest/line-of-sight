import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readConfig, writeConfig } from '../shared/config.js';
import { ANTHROPIC_OPTIONS, resolveResponder } from '../responders/index.js';
import type { ResponderRequest } from '../responders/types.js';
import { dialectFor } from '../shared/dialects/index.js';
import { pendingBlockId, toolOutcomes } from '../shared/outcomes.js';
import type { LiveSession, SessionMeta } from '../shared/types.js';
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

/** How long a `busy` claim is trusted with nothing moving behind it.
 *  The CLI writes `status: busy` once at turn start and never refreshes it, so
 *  a process that stops without writing `idle` — hung, suspended, crashed
 *  mid-turn — would otherwise pin its session "running" for as long as the pid
 *  lives (and abandoned `claude` processes survive for weeks). The longest
 *  silence measured inside a genuinely running turn is ~5.5 min
 *  (SPIKE_NOTES 2026-08-26: writes batch per assistant message), so this
 *  leaves ample margin; overshooting only greys a dot that re-lights on the
 *  next byte written, while undershooting is the forever-green bug.
 *  Calibrated on Claude Code's write batching; make it per-adapter only if
 *  the Codex spike finds a live signal with different silence behavior. */
const STALE_BUSY_MS = 15 * 60_000;

export function buildServer(store: Store, hub: SseHub,
    liveSessions: () => Map<string, LiveSession> = () => new Map(),
    reingest: (filePath: string) => void = () => {}): FastifyInstance {
  const app = Fastify({ logger: false });
  // so the CLI can tell a daemon that predates the current build
  const startedAt = Date.now();

  if (fs.existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
    // SPA fallback: non-/api paths serve the app shell
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  app.get<{ Querystring: { includeLastOpen?: string } }>('/api/health', (req) => {
    const base = { ok: true, pid: process.pid, startedAt };
    if (req.query.includeLastOpen) {
      return { ...base, lastViewerOpen: Number(store.getKv('last_viewer_open') ?? 0) };
    }
    return base;
  });

  /** Mark sessions whose agent process is active (see AgentAdapter.liveSessions).
   *  A `busy` claim also has to be corroborated by something still moving —
   *  its own status stamp or the transcript (see STALE_BUSY_MS). `waiting` is
   *  exempt: parked on the user is legitimately open-ended, and "waiting for
   *  you" is the signal the whole indicator exists to deliver. */
  /** Is the stored tail parked on an unresultted blocking tool use? Only
   *  consulted for 'alive' claims — agents with a waiting vocabulary report
   *  it themselves. A handful of tail events per live session per request. */
  const pendingAtTail = (m: { id: string; adapter: SessionMeta['adapter'] }): boolean => {
    const events = store.getEvents(m.id, { limit: 10 });
    return pendingBlockId(events, toolOutcomes(events), dialectFor(m.adapter)) !== null;
  };

  const withLive = <T extends { id: string; adapter: SessionMeta['adapter']; updatedAt: number;
      parentId?: string | null; endedAt?: number | null;
      turnOpen?: boolean | null; turnStartedAt?: number | null }>(metas: T[]): T[] => {
    const live = liveSessions();
    if (!live.size) return metas;
    const now = Date.now();
    return metas.map((m) => {
      // a subagent has no process of its own: it runs while its parent does
      // and the parent hasn't recorded its end. The quiet cap is a
      // belt-and-braces bound, not the signal: a run killed with no
      // task-notification (seen on disk) must not read busy for hours.
      if (m.parentId) {
        const running = live.has(m.parentId) && !m.endedAt && now - m.updatedAt <= STALE_BUSY_MS;
        return running ? { ...m, live: true, waiting: false, busySince: 0 } : m;
      }
      const s = live.get(m.id);
      if (!s) return m;
      // 'alive' proves the process exists, not that it is generating —
      // the transcript decides: turn ended ⇒ the open TUI is just idle,
      // grey immediately; parked on a blocking tool at the tail ⇒ waiting
      // (codex flushes pending calls, so the transcript can say so). Agents
      // without turn markers leave turnOpen null and fall through to the
      // staleness rule.
      if (s.state === 'alive' && m.turnOpen === false) return m;
      const busySince = s.state === 'alive' ? (m.turnStartedAt ?? 0) : s.since;
      const waiting = s.state === 'waiting' || (s.state === 'alive' && pendingAtTail(m));
      const lastSign = Math.max(busySince, m.updatedAt);
      if (!waiting && now - lastSign > STALE_BUSY_MS) return m;
      return { ...m, live: true, waiting, busySince };
    });
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
      // children = subagent runs; the viewer hangs them off their Task row
      return {
        session: withLive([session])[0], events,
        children: withLive(store.listChildren(session.id)),
        // names the Subagents popover's per-run groups (workflow_id → name)
        runs: store.workflowNames(session.id),
      };
    });

  // Re-parse a session and its children from byte 0 — for rows ingested by
  // an older adapter (e.g. before tool_use ids were stored). Derived data
  // only; the transcript is never touched.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/reingest', (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    const targets = [session, ...store.listChildren(session.id)];
    for (const s of targets) {
      store.resetSession(s.id);
      reingest(s.filePath);
    }
    return { ok: true, sessions: targets.length };
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

  app.get<{ Querystring: { adapter?: string } }>('/api/responder/status', async (req) => {
    // candidates() ignores unknown adapter strings, so pass the raw value through
    const engine = await resolveResponder(req.query.adapter as SessionMeta['adapter'] | undefined);
    const { responderModel, responderEffort } = readConfig();
    // never expose apiKey to the frontend
    return {
      engine: engine?.id ?? null,
      options: engine?.options ?? null,
      responderModel: responderModel ?? '',
      responderEffort: responderEffort ?? '',
    };
  });

  const EFFORTS = new Set(['', ...ANTHROPIC_OPTIONS.efforts]);

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

      const engine = await resolveResponder(session.adapter);
      if (!engine) {
        const pinned = readConfig().responder;
        return reply.code(409).send({
          error: pinned
            ? `configured responder '${pinned}' is not available`
            : 'no responder engine available',
        });
      }

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
        inlineContext: () => store.inlineContext(chat.sessionId, chat.anchorMessageId),
      };

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
