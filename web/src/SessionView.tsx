import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSession, type SessionMeta, type StoredEvent } from './api';
import { EventRow } from './Message';

const RUNNING_MS = 60_000;

/** Merge new events into the list, replacing by id (re-ingested lines) and keeping seq order. */
function merge(prev: StoredEvent[], incoming: StoredEvent[]): StoredEvent[] {
  const byId = new Map(prev.map((e) => [e.id, e]));
  let appended = false;
  for (const e of incoming) {
    if (!byId.has(e.id)) appended = true;
    byId.set(e.id, e);
  }
  const all = [...byId.values()];
  if (appended) all.sort((a, b) => a.seq - b.seq);
  return all;
}

export function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    fetchSession(id).then(({ session, events }) => {
      setSession(session);
      setEvents(events);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }, (e: unknown) => setError(String(e)));

    const es = new EventSource(`/api/sessions/${id}/stream`);
    es.onmessage = (msg) => {
      const incoming = JSON.parse(msg.data as string) as StoredEvent[];
      setEvents((prev) => merge(prev, incoming));
    };
    return () => es.close();
  }, [id]);

  // sticky auto-scroll: follow the tail only if already at the bottom
  useEffect(() => {
    if (atBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
  }, []);

  const loadEarlier = () => {
    const first = events[0];
    if (!first) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    void fetchSession(id, first.seq).then(({ events: older }) => {
      setEvents((prev) => merge(prev, older));
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - prevHeight; // keep viewport anchored
      });
    });
  };

  if (error) return <div className="page error">{error}</div>;
  if (!session) return <div className="page">Loading…</div>;
  const running = Date.now() - session.updatedAt < RUNNING_MS;
  return (
    <div className="session-view">
      <div className="session-header">
        <span className={`dot ${running ? 'live' : ''}`} title={running ? 'running' : 'idle'} />
        <span className="sh-title" title={session.title}>{session.title || '(untitled)'}</span>
        <span className="badge">{session.adapter === 'claude-code' ? 'claude' : session.adapter}</span>
        <span className="sh-dir">{session.projectDir ?? ''}</span>
        <span className="sh-time">{session.startedAt ? new Date(session.startedAt).toLocaleString() : ''}</span>
      </div>
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        {(events[0]?.seq ?? 1) > 1 && (
          <button className="load-earlier" onClick={loadEarlier}>Load earlier</button>
        )}
        {events.map((e) => <EventRow key={e.id} event={e} />)}
      </div>
    </div>
  );
}
