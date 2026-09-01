import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { nav } from './App';
import {
  createSideChat, fetchSession, fetchSessionMeta, fetchSideChats,
  type SessionMeta, type SideChat, type StoredEvent,
} from './api';
import { dialectFor, genericDialect, type Dialect } from '../../src/shared/dialects';
import { pendingBlockId, toolOutcomes, toolUseIds } from '../../src/shared/outcomes';
import { CopyButton, DialectCtx, EventRow, hasEventHead, OutcomesCtx } from './Message';
import { markSeen } from './seen';
import { shortDir } from './SessionList';
import { DOT_TITLE, RUNNING_MS, sessionStatus } from './status';
import { SidePanel } from './SidePanel';
import { buildTurns, isUserPrompt } from './turns';

/** Merge new events into the list, replacing by id (re-ingested lines) and keeping seq order. */
const IDLE_GAP_MS = 10 * 60 * 1000;
function formatGap(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : m < 24 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

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

/** Pulsing tail indicator with elapsed time since the turn started. */
function Generating({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const elapsed = since === 0 ? '' : s < 60 ? ` ${s}s` : ` ${Math.floor(s / 60)}m ${s % 60}s`;
  return <div className="generating">generating…{elapsed}</div>;
}

/** Compose the next prompt next to what it replies to; the only action is
 *  Copy — the user pastes into their own CLI (SPEC §6: injection stays cut).
 *  Deliberately not chat-shaped: collapsed behind a button, dashed "draft"
 *  card, no submit, Enter is a newline. localStorage so navigation can't eat
 *  a long draft. */
function ReplyDraft({ sessionId, events, dialect }:
    { sessionId: string; events: StoredEvent[]; dialect: Dialect }) {
  const key = `sight:draft:${sessionId}`;
  const copiedKey = `sight:draft-copied:${sessionId}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? '');
  const [open, setOpen] = useState(text !== '');
  // focus only on click-to-open — an autoFocus'd card restored at page load
  // would silently steal the keyboard from the transcript
  const clicked = useRef(false);

  // A copied draft clears once ANY newer user prompt arrives — the
  // conversation moved on, so the draft was sent or superseded (owner's
  // call: simpler than text-matching the delivered message). Editing after
  // Copy removes the stamp below, so writing that was never copied in its
  // current form is never auto-cleared.
  useEffect(() => {
    const copiedAt = Number(localStorage.getItem(copiedKey) ?? 0);
    if (!copiedAt || !events.some((e) => e.ts > copiedAt && isUserPrompt(e, dialect))) return;
    localStorage.removeItem(key);
    localStorage.removeItem(copiedKey);
    setText('');
    setOpen(false);
  }, [events, key, copiedKey, dialect]);

  // card ⇄ toggle swaps morph via the View Transitions API (both elements
  // share a view-transition-name in styles.css). flushSync so the DOM change
  // lands inside the transition callback; browsers without the API swap
  // instantly. Clearing is the user's move — emptying the textarea.
  const swap = (next: boolean) => {
    const apply = () => flushSync(() => setOpen(next));
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition) doc.startViewTransition(apply); else apply();
  };

  if (!open) {
    const firstLine = text.trim().split('\n')[0] ?? '';
    return (
      <button className="draft-toggle" onClick={() => { clicked.current = true; swap(true); }}>
        ✎ {firstLine || 'Draft reply'}
      </button>
    );
  }
  return (
    <div className="draft-card">
      <div className="draft-head">
        <span>Draft — copy into your terminal to send</span>
        <button className="copy-btn" title="Minimize — draft kept (Esc)"
          onClick={() => swap(false)}>−</button>
        <CopyButton text={() => text} label="Copy for CLI"
          onCopied={() => {
            localStorage.setItem(copiedKey, String(Date.now()));
            setTimeout(() => swap(false), 1000);
          }} />
      </div>
      <textarea rows={3} value={text} placeholder="Write your reply here…"
        ref={(el) => { if (clicked.current) { el?.focus(); clicked.current = false; } }}
        onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) swap(false); }}
        onChange={(e) => {
          setText(e.target.value);
          localStorage.setItem(key, e.target.value);
          localStorage.removeItem(copiedKey);   // edited since copy → re-armed as uncopied
        }} />
    </div>
  );
}

/** Temporarily mark query matches inside el via the CSS Custom Highlight API
 *  — no DOM mutation, so a React re-render can't conflict (worst case the
 *  marks vanish early, and they're transient anyway). No-op where the API is
 *  missing or nothing matches; the message-level flash still locates the hit. */
function markMatches(el: Element, query: string): boolean {
  if (!('highlights' in CSS)) return false;
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? '';
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      ranges.push(r);
    }
  }
  if (!ranges.length) return false;
  CSS.highlights.set('search-hit', new Highlight(...ranges));
  return true;
}

export function SessionView({ id, targetMessageId = null, highlightQuery = null }:
    { id: string; targetMessageId?: string | null; highlightQuery?: string | null }) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [children, setChildren] = useState<SessionMeta[]>([]);
  const [runs, setRuns] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [sideChats, setSideChats] = useState<SideChat[]>([]);
  // by id, not by object: the chat's turns change under us (a question is
  // persisted the moment it's asked) and a held snapshot would go stale
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const openChat = sideChats.find((c) => c.id === openChatId) ?? null;
  const [askBtn, setAskBtn] = useState<AskButton | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const applyMeta = useCallback(({ session, children, runs }:
      { session: SessionMeta; children: SessionMeta[]; runs: Record<string, string> }) => {
    setSession(session);
    setChildren(children);
    setRuns(runs);
  }, []);
  // rebuilt by the poll below when the browser gives up on reconnecting
  const esRef = useRef<EventSource | null>(null);

  // anything arriving while the view is open counts as seen — clears the
  // list's "just finished" state; later activity re-arms it
  useEffect(() => { if (session) markSeen(id); }, [id, session, events]);

  const refreshChats = useCallback(() => {
    void fetchSideChats(id).then(setSideChats, () => {});
  }, [id]);

  useEffect(() => {
    fetchSession(id, undefined, targetMessageId).then(({ session, events, children, runs }) => {
      applyMeta({ session, children, runs });
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
          const marked = !!highlightQuery && markMatches(target, highlightQuery);
          setTimeout(() => {
            target.classList.remove('flash');
            if (marked) CSS.highlights.delete('search-hit');
          }, 2500);
        } else {
          el.scrollTo({ top: el.scrollHeight });
        }
      });
    }, (e: unknown) => setError(String(e)));
    refreshChats();

    // events missed while the stream was down (or the tab was backgrounded and
    // throttled) never arrive on their own — re-pull the tail on reconnect/return
    const resync = () => {
      void fetchSession(id).then(({ session: meta, events: tail, children: kids, runs: r }) => {
        applyMeta({ session: meta, children: kids, runs: r });
        setEvents((prev) => merge(prev, tail));
      }, () => {});
    };
    let opened = false;
    const connect = () => {
      const es = new EventSource(`/api/sessions/${id}/stream`);
      es.onmessage = (msg) => {
        const incoming = JSON.parse(msg.data as string) as StoredEvent[];
        setEvents((prev) => merge(prev, incoming));
      };
      es.onopen = () => { if (opened) resync(); opened = true; };
      esRef.current = es;
    };
    connect();
    const onVisible = () => { if (!document.hidden) resync(); };
    document.addEventListener('visibilitychange', onVisible);

    // Poll the meta so busy→idle flips (and the last turn folds) promptly:
    // `live`, updatedAt and a freshly spawned subagent all change with no SSE
    // event to announce them. Same tick: a reconnect attempt that hits the
    // daemon mid-restart (every rebuild) closes the EventSource for good —
    // the browser never retries a failed reconnect — so rebuild it here;
    // onopen then resyncs the tail missed while it was down.
    const t = setInterval(() => {
      void fetchSessionMeta(id).then(applyMeta, () => {});
      if (esRef.current?.readyState === EventSource.CLOSED) connect();
    }, 10_000);

    return () => {
      clearInterval(t);
      esRef.current?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, refreshChats, applyMeta]);

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
      setOpenChatId(chat.id);
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
  // session.live is the agent's own busy flag (long model turns write nothing);
  // the timestamp heuristic covers agents/versions that don't expose one
  const running = session?.live || Date.now() - lastActivity < RUNNING_MS;

  // the viewed session's presentation policy — stable per adapter, so the
  // memoized rows below don't reconcile on every meta poll
  const dialect = useMemo(() => (session ? dialectFor(session.adapter) : genericDialect),
    [session?.adapter]);

  // trailing tool run: expanded while running (live-follow), folds once the
  // session goes idle. Queue bookkeeping rows feed the queued strip below
  // instead of rendering (or padding the fold counts).
  const items = useMemo(
    () => buildTurns(events.filter((e) => !dialect.isQueueOp(e)), dialect, { foldTail: !running }),
    [events, running, dialect]);

  // input typed while the agent works, not yet read by it — the CLI shows
  // this under its spinner; gate on `running` so a session killed with a
  // stale queue doesn't dangle it forever
  const queued = useMemo(() => running ? dialect.queuedInputs(events) : [],
    [events, running, dialect]);

  // blocking tools (the dialect's isBlockingUse): pair each use with its
  // result so the cards can mark chosen/approved, and detect "the CLI is
  // parked on a question at the tail". Gated on `running`: a session killed
  // mid-question must not claim "waiting for you" forever.
  const outcomes = useMemo(() => toolOutcomes(events), [events]);
  const useIds = useMemo(() => toolUseIds(events), [events]);
  const pendingEventId = useMemo(() => running ? pendingBlockId(events, outcomes, dialect) : null,
    [events, outcomes, running, dialect]);
  // Task tool_use id → the subagent session it spawned, so the Task row can
  // open it. A child whose meta.json was missing has no toolUseId and simply
  // never gets a row link (it is still reachable from the header count).
  const subagents = useMemo(() => new Map(
    children.filter((c) => c.toolUseId).map((c) => [c.toolUseId!, c] as const)), [children]);
  const outcomesCtx = useMemo(() => ({ outcomes, useIds, pendingEventId, subagents }),
    [outcomes, useIds, pendingEventId, subagents]);
  // Subagents popover: direct Task runs flat, Workflow runs folded per run id
  // (named from the API's `runs`, a fact the ingester stored off the launch ack).
  const childGroups = useMemo(() => {
    const groups = new Map<string | null, SessionMeta[]>();
    for (const c of children) {
      const key = c.workflowId ?? null;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    // direct children (null key) first, runs in insertion order
    return [...groups.entries()].sort(([a], [b]) => Number(a !== null) - Number(b !== null));
  }, [children]);

  const renderEvent = (e: StoredEvent, showRole: boolean) => (
    <div className="event-wrap" key={e.id}>
      {chatsByMessage.has(e.id) && (
        <button
          className="margin-marker"
          title="side chats on this message"
          onClick={() => setOpenChatId(chatsByMessage.get(e.id)!.at(-1)!.id)}
        />
      )}
      <EventRow event={e} showRole={showRole} />
    </div>
  );

  /** Render a run of events, labeling the role only when it changes.
   *  Headless rows (tool flows, tool_use/thinking-only) don't interrupt it. */
  const renderRun = (evs: StoredEvent[]) => {
    let prevRole: string | null = null;
    let prevTs = 0;
    return evs.flatMap((e) => {
      const headed = hasEventHead(e, dialect);
      const showRole = headed && e.role !== prevRole;
      if (headed) prevRole = e.role;
      // an idle stretch (you walked away, the CLI sat) reads as a seam, not
      // one continuous exchange — ambient, so a thin rule with the gap
      const gap = prevTs && e.ts ? e.ts - prevTs : 0;
      if (e.ts) prevTs = e.ts;
      const row = renderEvent(e, showRole);
      return gap >= IDLE_GAP_MS
        ? [<div className="idle-gap" key={`gap-${e.id}`}>{formatGap(gap)} idle</div>, row]
        : [row];
    });
  };

  if (error) return <div className="page error">{error}</div>;
  if (!session) return <div className="page">Loading…</div>;
  // same derivation as the list's dot; viewing = seen, so 'done' can't occur here
  const dotStatus = sessionStatus(session, { [session.id]: Date.now() }, Date.now());
  return (
    <div className="session-view">
      <div className="session-header">
        <span className={`dot ${dotStatus}`} title={DOT_TITLE[dotStatus]} />
        {session.parentId && (
          <a className="chip" href={`/s/${session.parentId}`} title="back to the session that spawned this subagent"
             onClick={(e) => { e.preventDefault(); nav(`/s/${session.parentId!}`); }}>↑ parent</a>
        )}
        <span className="sh-title" title={session.title}>{session.title || '(untitled)'}</span>
        <span className={`badge ${session.adapter}`}>{session.parentId ? 'subagent' : dialect.displayName}</span>
        {/* subagent ids are Line of Sight's own, not CLI session ids — nothing to copy */}
        {!session.parentId && (
          <span className="sh-id" title={`${session.id} — click to copy`}>
            <CopyButton text={() => session.id} label={session.id.slice(0, 8)} doneLabel="copied" />
          </span>
        )}
        <span className="sh-dir">{shortDir(session.projectDir)}</span>
        <span className="sh-time">{session.startedAt ? new Date(session.startedAt).toLocaleString() : ''}</span>
        {/* also the only way into a subagent whose Task row is outside the
            loaded window, or whose meta.json never linked it to one */}
        {children.length > 0 && (
          <>
            <button className="chip" popoverTarget="subagents-list" title="subagents this session spawned">
              Subagents · {children.length}
            </button>
            <div id="subagents-list" className="asks-list" popover="auto">
              {childGroups.map(([wf, kids]) => {
                const rows = kids.map((c) => (
                  <button key={c.id} className="asks-item" onClick={(e) => {
                    e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                    nav(`/s/${c.id}`);
                  }}>
                    <span className="asks-q">{c.title || '(untitled)'}</span>
                    <span className="asks-meta">
                      {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
                      {c.startedAt ? ` · ${new Date(c.startedAt).toLocaleTimeString()}` : ''}
                    </span>
                  </button>
                ));
                if (wf === null) return rows;
                return (
                  <details key={wf} className="wf-group">
                    <summary className="asks-meta">
                      {runs[wf] ?? 'workflow'} · {wf} · {kids.length}
                    </summary>
                    {rows}
                  </details>
                );
              })}
            </div>
          </>
        )}
        <button className="chip" popoverTarget="asks-list" title="side chats in this session">
          Asks · {sideChats.length}
        </button>
        <div id="asks-list" className="asks-list" popover="auto">
          {sideChats.length === 0
            ? <div className="asks-hint">Select any text in the transcript to ask about it.</div>
            : sideChats.map((c) => (
              <button key={c.id} className="asks-item" onClick={(e) => {
                e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                setOpenChatId(c.id);
              }}>
                <span className="asks-q">
                  {c.turns.find((t) => t.role === 'user')?.text ?? '(no question yet)'}
                </span>
                <span className="asks-meta">
                  “{c.anchorText}” · {new Date(c.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
        </div>
      </div>
      <DialectCtx.Provider value={dialect}>
      <OutcomesCtx.Provider value={outcomesCtx}>
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
                <details
                  className={item.type === 'abandoned' ? 'turn-fold abandoned' : 'turn-fold'}
                  key={`fold-${item.events[0]?.id ?? idx}`}
                  open={containsTarget || undefined}>
                  <summary>
                    {item.type === 'abandoned'
                      ? `⏵ abandoned branch · ${item.steps} step${item.steps === 1 ? '' : 's'}`
                      : `⏵ ${item.steps} step${item.steps === 1 ? '' : 's'}`}
                    {item.type === 'fold' && item.toolCalls > 0
                      && ` · ${item.toolCalls} tool call${item.toolCalls > 1 ? 's' : ''}`}
                    {anchored.length > 0 && (
                      <button
                        className="margin-marker in-summary"
                        title="side chats inside these steps"
                        onClick={(ev) => {
                          ev.preventDefault();
                          setOpenChatId(chatsByMessage.get(anchored[0]!.id)!.at(-1)!.id);
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
          {/* busySince is the agent's own turn-start clock; lastMsgTs is a
              fallback and is wrong when the loaded window ends mid-history
              (search jump), so prefer busySince whenever the CLI reports it.
              `waiting` is the CLI's own parked-on-the-user status: the only
              live source for it, since a blocking tool's tool_use line lands
              only once it has a result (SPIKE_NOTES 2026-08-26). The
              transcript-derived pendingEventId stays as the fallback. */}
          {session.waiting || pendingEventId
            ? <div className="awaiting">✋ waiting for your input in the CLI</div>
            : session.live && <Generating since={session.busySince || lastMsgTs} />}
          {queued.map((text, i) => (
            <div key={`q${i}`} className="event user queued">
              <span className="queued-tag">⏳ queued</span>{text}
            </div>
          ))}
          <ReplyDraft key={id} sessionId={id} events={events} dialect={dialect} />
        </div>
        {openChat && (
          <SidePanel
            key={openChat.id}
            chat={openChat}
            adapter={session.adapter}
            siblings={chatsByMessage.get(openChat.anchorMessageId) ?? [openChat]}
            onSwitch={(c) => setOpenChatId(c.id)}
            onClose={() => setOpenChatId(null)}
            onChanged={refreshChats}
          />
        )}
      </div>
      </OutcomesCtx.Provider>
      </DialectCtx.Provider>
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
