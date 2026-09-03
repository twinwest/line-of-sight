import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  cancelAsk, deleteSideChat, fetchResponderStatus, fetchSideChat, getAsk, putResponderConfig,
  runAsk, subscribeAsks, type LiveSideChat, type ResponderStatus, type SessionMeta, type SideChat,
} from './api';
import { MD_COMPONENTS } from './Message';

const WIDTH_KEY = 'sight:panel-width';

const PRESETS = ['What is this?', 'Why did the agent do this?', 'Any problems with this?'];

export function SidePanel({ chat, adapter, siblings, onSwitch, onClose, onChanged }: {
  chat: SideChat;
  /** the viewed session's agent — asks route to its matching engine */
  adapter: SessionMeta['adapter'];
  /** other chats anchored to the same message (incl. this one) */
  siblings: SideChat[];
  onSwitch: (chat: SideChat) => void;
  onClose: () => void;
  onChanged: () => void;   // turns persisted or chat deleted — refetch
}) {
  // an ask outlives this component (see api.ts): once one has run for this chat
  // the registry holds the conversation, otherwise the fetched chat does
  const live = useSyncExternalStore(subscribeAsks, () => getAsk(chat.id));
  // …and outlives the page: a reload loses the registry but not the ask, so
  // when the chat ends on an unanswered question, poll the daemon for it
  const [remote, setRemote] = useState<LiveSideChat | null>(null);
  const turns = live?.turns ?? remote?.turns ?? chat.turns;
  const streaming = live?.streaming ?? null;   // in-flight answer text
  const progress = live?.progress ?? '';       // responder tool activity
  const error = live?.error ?? '';
  const lastQuestion = live?.question ?? '';
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ResponderStatus | null | undefined>(undefined);
  const [width, setWidth] = useState(() => {
    const w = parseFloat(localStorage.getItem(WIDTH_KEY) ?? '');
    return Number.isFinite(w) ? Math.min(700, Math.max(280, w)) : 400;
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  useEffect(() => { atBottom.current = true; setRemote(null); }, [chat.id]);
  // each answer re-schedules the next poll, so it stops on its own: once the
  // daemon reports no ask running, or the chat no longer ends on a question
  useEffect(() => {
    if (live || (remote && !remote.answering)) return;
    if (chat.turns.at(-1)?.role !== 'user') return;
    const t = setTimeout(() => {
      void fetchSideChat(chat.id).then((c) => {
        setRemote(c);
        if (!c.answering && c.turns.length > chat.turns.length) onChanged();
      }, () => {});
    }, remote ? 2000 : 0);
    return () => clearTimeout(t);
  }, [chat, live, remote, onChanged]);
  useEffect(() => { void fetchResponderStatus(adapter).then(setStatus); }, [adapter]);
  // sticky auto-scroll: follow the streaming answer only if already at the
  // bottom, so scrolling up to re-read isn't yanked back by every chunk
  useEffect(() => {
    if (atBottom.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turns, streaming]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
  };

  /** Grow the question box with its content (CSS max-height caps it and takes
   *  over with a scrollbar). Collapsing to `auto` first is what lets it shrink
   *  again — on deletion, and back to one row after a question is sent. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // box-sizing is border-box, so scrollHeight leaves out the border; without
    // adding it back the box lands short and shows a permanent scrollbar.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [input]);

  useEffect(() => { localStorage.setItem(WIDTH_KEY, String(width)); }, [width]);

  const busy = streaming !== null || (remote?.answering ?? false);

  const ask = (question: string) => {
    if (busy || !question.trim()) return;
    atBottom.current = true;   // asking re-arms the follow
    void runAsk(chat.id, question, chat.turns).then(onChanged);
    setInput('');
  };

  const startDrag = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) =>
      setWidth(Math.min(700, Math.max(280, startW + startX - ev.clientX)));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const close = () => {
    if (turns.length === 0 && !busy) void deleteSideChat(chat.id).then(onChanged);
    onClose();
  };

  return (
    <aside className="side-panel" style={{ width }}>
      <div className="panel-drag" onPointerDown={startDrag} />
      {siblings.length > 1 && (
        <div className="panel-head">
          <span className="chat-chips">
            {siblings.map((c, i) => (
              <button key={c.id} className={`chip ${c.id === chat.id ? 'active' : ''}`}
                onClick={() => onSwitch(c)}>{i + 1}</button>
            ))}
          </span>
        </div>
      )}
      <div className="anchor-wrap">
        <blockquote className="anchor">{chat.anchorText}</blockquote>
        <span className="panel-actions">
          <button className="copy-btn delete" onClick={() => {
            void deleteSideChat(chat.id).then(onChanged);
            onClose();
          }}>Delete</button>
          <button className="copy-btn" onClick={close}>✕</button>
        </span>
      </div>
      <div className="panel-body" ref={bodyRef} onScroll={onScroll}>
        {status?.engine === null && (
          <div className="setup-hint">
            No answer engine found. Install the <code>claude</code> or <code>codex</code> CLI.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            {t.role === 'assistant'
              ? <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{t.text}</Markdown></div>
              : <div>{t.text}</div>}
          </div>
        ))}
        {busy && (
          <div className="turn assistant">
            {streaming && <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{streaming}</Markdown></div>}
            {/* stays visible under partial text: both engines go quiet while
                researching (codex between whole-message chunks, claude during
                tool calls) and a frozen answer reads as a dead responder */}
            <div className="typing" title={progress || undefined}>{progress || 'thinking'}…</div>
            <button className="copy-btn cancel" onClick={() => cancelAsk(chat.id)}>Cancel</button>
          </div>
        )}
        {error && (
          <div className="panel-error">
            {error}
            {lastQuestion && !busy && (
              <button className="copy-btn" onClick={() => ask(lastQuestion)}>Retry</button>
            )}
          </div>
        )}
      </div>
      {turns.length === 0 && !busy && (
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p} className="preset" onClick={() => ask(p)}>{p}</button>
          ))}
        </div>
      )}
      <form className="panel-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <textarea ref={inputRef} rows={1} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. isComposing means an IME
            // has candidates open and this Enter is picking one — sending there
            // would cut every CJK sentence short. The old <input> got that for
            // free (browsers suppress form submit mid-composition); an explicit
            // keydown handler has to check for it.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            ask(input);
          }}
          placeholder="Ask about the selection…" disabled={busy} autoFocus />
        <div className="input-foot">
          {/* engines with dropdowns need no text label — the selectors say
              what answers; label-only engines (codex) show their model */}
          {status?.engine && !status.options &&
            <span className="engine-label">{status.label ?? status.engine}</span>}
          {status?.engine && status.options && <>
          <select
            title="responder model"
            value={status.responderModel}
            onChange={(e) => {
              putResponderConfig({ responderModel: e.target.value });
              setStatus({ ...status, responderModel: e.target.value });
            }}>
            {['', ...status.options.models].map((m) => <option key={m} value={m}>{m || 'model: default'}</option>)}
          </select>
          <select
            title="responder effort"
            value={status.responderEffort}
            onChange={(e) => {
              putResponderConfig({ responderEffort: e.target.value });
              setStatus({ ...status, responderEffort: e.target.value });
            }}>
            {['', ...status.options.efforts].map((ef) => <option key={ef} value={ef}>{ef || 'effort: default'}</option>)}
          </select>
          </>}
          <button type="submit" disabled={busy || !input.trim()} title="Ask (Enter)">↑</button>
        </div>
      </form>
    </aside>
  );
}
