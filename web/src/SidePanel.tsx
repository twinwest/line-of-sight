import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  askStream, cancelAsk, deleteSideChat, fetchResponderStatus, putResponderConfig,
  type ResponderStatus, type SideChat,
} from './api';

const MODELS = ['', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const PRESETS = ['What is this?', "What's the evidence for this?", 'What alternatives were ruled out?'];

/** Answer links always open in a new tab — never navigate the viewer away. */
const MD_COMPONENTS = {
  a: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) =>
    <a {...props} target="_blank" rel="noreferrer" />,
};

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-btn" onClick={() => {
      void navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }}>{done ? '✓' : 'Copy'}</button>
  );
}

export function SidePanel({ chat, siblings, onSwitch, onClose, onChanged }: {
  chat: SideChat;
  /** other chats anchored to the same message (incl. this one) */
  siblings: SideChat[];
  onSwitch: (chat: SideChat) => void;
  onClose: () => void;
  onChanged: () => void;   // turns persisted or chat deleted — refetch
}) {
  const [turns, setTurns] = useState(chat.turns);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);   // in-flight answer text
  const [progress, setProgress] = useState('');                      // responder tool activity
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const [status, setStatus] = useState<ResponderStatus | null | undefined>(undefined);
  const [anchorExpanded, setAnchorExpanded] = useState(false);
  const [width, setWidth] = useState(400);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setTurns(chat.turns); setError(''); setStreaming(null); }, [chat.id]);
  useEffect(() => { void fetchResponderStatus().then(setStatus); }, []);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turns, streaming]);

  const busy = streaming !== null;

  const ask = (question: string) => {
    if (busy || !question.trim()) return;
    setError('');
    setLastQuestion(question);
    setTurns((t) => [...t, { role: 'user', text: question, ts: Date.now() }]);
    setStreaming('');
    setProgress('');
    let acc = '';
    void askStream(chat.id, question, {
      chunk: (t) => { acc += t; setStreaming(acc); },
      status: (s) => setProgress(s),
      error: (msg) => setError(msg),
    }).then(() => {
      setStreaming(null);
      setProgress('');
      if (acc) setTurns((t) => [...t, { role: 'assistant', text: acc, ts: Date.now() }]);
      onChanged();
    });
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

  const anchorLong = chat.anchorText.length > 500;
  const anchorShown = anchorExpanded || !anchorLong
    ? chat.anchorText : chat.anchorText.slice(0, 500) + '…';

  return (
    <aside className="side-panel" style={{ width }}>
      <div className="panel-drag" onPointerDown={startDrag} />
      <div className="panel-head">
        {siblings.length > 1 && (
          <span className="chat-chips">
            {siblings.map((c, i) => (
              <button key={c.id} className={`chip ${c.id === chat.id ? 'active' : ''}`}
                onClick={() => onSwitch(c)}>{i + 1}</button>
            ))}
          </span>
        )}
        <span className="panel-actions">
          <button className="copy-btn" onClick={() => {
            void deleteSideChat(chat.id).then(onChanged);
            onClose();
          }}>Delete</button>
          <button className="copy-btn" onClick={onClose}>✕</button>
        </span>
      </div>
      <blockquote className="anchor" onClick={() => setAnchorExpanded((v) => !v)}
        title={anchorLong ? 'click to expand' : undefined}>
        {anchorShown}
      </blockquote>
      <div className="panel-body" ref={bodyRef}>
        {status?.engine === null && (
          <div className="setup-hint">
            No answer engine found. Install the <code>claude</code> CLI, or put an API key in{' '}
            <code>~/.sight/config.json</code>:{' '}
            <code>{'{"responder":"api","apiKey":"sk-..."}'}</code>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            {t.role === 'assistant' && <span className="turn-copy"><CopyBtn text={t.text} /></span>}
            {t.role === 'assistant'
              ? <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{t.text}</Markdown></div>
              : <div>{t.text}</div>}
          </div>
        ))}
        {busy && (
          <div className="turn assistant">
            {streaming
              ? <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{streaming}</Markdown></div>
              : <div className="typing">{progress ? `⏵ ${progress}` : 'Thinking…'}</div>}
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
      {status?.engine && (
        <div className="engine-row">
          <span className="engine-label">{status.engine}</span>
          <select
            title="responder model"
            value={status.responderModel}
            onChange={(e) => {
              putResponderConfig({ responderModel: e.target.value });
              setStatus({ ...status, responderModel: e.target.value });
            }}>
            {MODELS.map((m) => <option key={m} value={m}>{m || 'model: default'}</option>)}
          </select>
          <select
            title="responder effort"
            value={status.responderEffort}
            onChange={(e) => {
              putResponderConfig({ responderEffort: e.target.value });
              setStatus({ ...status, responderEffort: e.target.value });
            }}>
            {EFFORTS.map((ef) => <option key={ef} value={ef}>{ef || 'effort: default'}</option>)}
          </select>
        </div>
      )}
      <form className="panel-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the selection…" disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>
    </aside>
  );
}
