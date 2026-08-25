import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { nav } from './App';
import {
  createSideChat, fetchSession, fetchSideChats,
  type SessionMeta, type SideChat, type StoredEvent,
} from './api';
import { EventRow, isToolFlow } from './Message';
import { SidePanel } from './SidePanel';
import { buildTurns } from './turns';

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

export function SessionView({ id, targetMessageId = null }:
    { id: string; targetMessageId?: string | null }) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState('');
  const [sideChats, setSideChats] = useState<SideChat[]>([]);
  const [openChat, setOpenChat] = useState<SideChat | null>(null);
  const [askBtn, setAskBtn] = useState<AskButton | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // periodic re-render so running→idle flips (and the last turn folds) promptly
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  const refreshChats = useCallback(() => {
    void fetchSideChats(id).then(setSideChats, () => {});
  }, [id]);

  useEffect(() => {
    fetchSession(id, undefined, targetMessageId).then(({ session, events }) => {
      setSession(session);
      setEvents(events);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const target = targetMessageId
          && el.querySelector(`.event[data-mid="${CSS.escape(targetMessageId)}"]`);
        if (target) {
          atBottom.current = false;
          target.scrollIntoView({ block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 2500);
        } else {
          el.scrollTo({ top: el.scrollHeight });
        }
      });
    }, (e: unknown) => setError(String(e)));
    refreshChats();

    const es = new EventSource(`/api/sessions/${id}/stream`);
    es.onmessage = (msg) => {
      const incoming = JSON.parse(msg.data as string) as StoredEvent[];
      setEvents((prev) => merge(prev, incoming));
    };

    // events missed while the stream was down (or the tab was backgrounded and
    // throttled) never arrive on their own — re-pull the tail on reconnect/return
    const resync = () => {
      void fetchSession(id).then(({ session: meta, events: tail }) => {
        setSession(meta);
        setEvents((prev) => merge(prev, tail));
      }, () => {});
    };
    let opened = false;
    es.onopen = () => { if (opened) resync(); opened = true; };
    const onVisible = () => { if (!document.hidden) resync(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      es.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  // activity = real messages only; meta rows (away_summary, …) arriving after
  // idle must not re-expand the last turn or re-light the dot
  let lastMsgTs = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'message') { lastMsgTs = events[i]!.ts; break; }
  }
  const lastActivity = Math.max(session?.updatedAt ?? 0, lastMsgTs);
  const running = Date.now() - lastActivity < RUNNING_MS;

  // last turn: expanded while running (live-follow), folds once the session
  // goes idle — the 60s heuristic is the only end-of-session signal
  const items = useMemo(() => buildTurns(events, { foldLastTurn: !running }),
    [events, running]);

  const renderEvent = (e: StoredEvent, showRole: boolean) => (
    <div className="event-wrap" key={e.id}>
      {chatsByMessage.has(e.id) && (
        <button
          className="margin-marker"
          title="side chats on this message"
          onClick={() => setOpenChat(chatsByMessage.get(e.id)!.at(-1)!)}
        />
      )}
      <EventRow event={e} showRole={showRole} />
    </div>
  );

  /** Render a run of events, labeling the role only when it changes.
   *  Headless tool-flow rows don't interrupt the continuity. */
  const renderRun = (evs: StoredEvent[]) => {
    let prevRole: string | null = null;
    return evs.map((e) => {
      const headed = e.kind === 'message'
        && !isToolFlow(e.role, Array.isArray(e.body) ? e.body : []);
      const showRole = headed && e.role !== prevRole;
      if (headed) prevRole = e.role;
      return renderEvent(e, showRole);
    });
  };

  if (error) return <div className="page error">{error}</div>;
  if (!session) return <div className="page">Loading…</div>;
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
          {(() => {
            const out: React.ReactNode[] = [];
            let run: StoredEvent[] = [];
            const flush = () => {
              if (run.length) { out.push(...renderRun(run)); run = []; }
            };
            items.forEach((item, idx) => {
              if (item.type === 'event') { run.push(item.event); return; }
              flush();
              const anchored = item.events.filter((e) => chatsByMessage.has(e.id));
              const containsTarget = !!targetMessageId
                && item.events.some((e) => e.id === targetMessageId);
              out.push(
                <details className="turn-fold" key={`fold-${item.events[0]?.id ?? idx}`}
                  open={containsTarget || undefined}>
                  <summary>
                    ⏵ {item.events.length} steps
                    {item.toolCalls > 0 && ` · ${item.toolCalls} tool call${item.toolCalls > 1 ? 's' : ''}`}
                    {anchored.length > 0 && (
                      <button
                        className="margin-marker in-summary"
                        title="side chats inside these steps"
                        onClick={(ev) => {
                          ev.preventDefault();
                          setOpenChat(chatsByMessage.get(anchored[0]!.id)!.at(-1)!);
                        }}
                      />
                    )}
                  </summary>
                  {renderRun(item.events)}
                </details>,
              );
            });
            flush();
            return out;
          })()}
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
      {targetMessageId && (
        <button className="jump-latest" onClick={() => nav(`/s/${id}`)}>↓ Latest</button>
      )}
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
