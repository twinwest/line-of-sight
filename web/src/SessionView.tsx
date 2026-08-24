import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSideChat, fetchSession, fetchSideChats,
  type SessionMeta, type SideChat, type StoredEvent,
} from './api';
import { EventRow } from './Message';
import { SidePanel } from './SidePanel';

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

interface AskButton { messageId: string; text: string; x: number; y: number }

export function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState('');
  const [sideChats, setSideChats] = useState<SideChat[]>([]);
  const [openChat, setOpenChat] = useState<SideChat | null>(null);
  const [askBtn, setAskBtn] = useState<AskButton | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const refreshChats = useCallback(() => {
    void fetchSideChats(id).then(setSideChats, () => {});
  }, [id]);

  useEffect(() => {
    fetchSession(id).then(({ session, events }) => {
      setSession(session);
      setEvents(events);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }, (e: unknown) => setError(String(e)));
    refreshChats();

    const es = new EventSource(`/api/sessions/${id}/stream`);
    es.onmessage = (msg) => {
      const incoming = JSON.parse(msg.data as string) as StoredEvent[];
      setEvents((prev) => merge(prev, incoming));
    };
    return () => es.close();
  }, [id, refreshChats]);

  // sticky auto-scroll: follow the tail only if already at the bottom
  useEffect(() => {
    if (atBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    setAskBtn(null);   // selection rect is stale once the transcript scrolls
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

  // selection → floating Ask button (SPEC 5.4): selection must sit inside one message
  const onMouseUp = useCallback(() => {
    // defer so a click that collapses the selection is seen as collapsed
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || sel.isCollapsed || !text) { setAskBtn(null); return; }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el = container instanceof Element ? container : container.parentElement;
      const msgEl = el?.closest<HTMLElement>('.event[data-mid]');
      if (!msgEl || !scrollRef.current?.contains(msgEl)) { setAskBtn(null); return; }
      const rect = range.getBoundingClientRect();
      setAskBtn({
        messageId: msgEl.dataset.mid!,
        text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    });
  }, []);

  const startAsk = () => {
    if (!askBtn) return;
    void createSideChat(id, askBtn.messageId, askBtn.text).then((chat) => {
      setSideChats((prev) => [...prev, chat]);
      setOpenChat(chat);
    });
    setAskBtn(null);
    window.getSelection()?.removeAllRanges();
  };

  const chatsByMessage = useMemo(() => {
    const map = new Map<string, SideChat[]>();
    for (const c of sideChats) {
      const list = map.get(c.anchorMessageId) ?? [];
      list.push(c);
      map.set(c.anchorMessageId, list);
    }
    return map;
  }, [sideChats]);

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
      <div className="view-split">
        <div className="transcript" ref={scrollRef} onScroll={onScroll} onMouseUp={onMouseUp}>
          {(events[0]?.seq ?? 1) > 1 && (
            <button className="load-earlier" onClick={loadEarlier}>Load earlier</button>
          )}
          {events.map((e) => (
            <div className="event-wrap" key={e.id}>
              {chatsByMessage.has(e.id) && (
                <button
                  className="margin-marker"
                  title="side chats on this message"
                  onClick={() => setOpenChat(chatsByMessage.get(e.id)!.at(-1)!)}
                />
              )}
              <EventRow event={e} />
            </div>
          ))}
        </div>
        {openChat && (
          <SidePanel
            key={openChat.id}
            chat={openChat}
            siblings={chatsByMessage.get(openChat.anchorMessageId) ?? [openChat]}
            onSwitch={setOpenChat}
            onClose={() => setOpenChat(null)}
            onChanged={refreshChats}
          />
        )}
      </div>
      {askBtn && (
        <button
          className="ask-btn"
          style={{ left: askBtn.x, top: askBtn.y }}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={startAsk}
        >Ask</button>
      )}
    </div>
  );
}
