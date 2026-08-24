import { useEffect, useMemo, useRef, useState } from 'react';
import { nav } from './App';
import { search, type SearchHit } from './api';

/** Render a snippet whose match ranges are \u0001...\u0002 delimited. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/([\u0001\u0002])/);
  let inMark = false;
  return (
    <span className="snippet">
      {parts.map((p, i) => {
        if (p === '\u0001') { inMark = true; return null; }
        if (p === '\u0002') { inMark = false; return null; }
        return inMark ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>;
      })}
    </span>
  );
}

export function SearchBox() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => {
      void search(q).then((h) => { setHits(h); setOpen(true); }, () => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('mousedown', onDown);
    return () => removeEventListener('mousedown', onDown);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; hits: SearchHit[] }>();
    for (const h of hits ?? []) {
      const g = map.get(h.sessionId) ?? { title: h.sessionTitle, hits: [] };
      g.hits.push(h);
      map.set(h.sessionId, g);
    }
    return [...map.entries()];
  }, [hits]);

  const go = (h: SearchHit) => {
    setOpen(false);
    nav(`/s/${h.sessionId}?m=${encodeURIComponent(h.messageId)}`);
  };

  return (
    <div className="search-box" ref={boxRef}>
      <input
        placeholder="Search all sessions…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits) setOpen(true); }}
      />
      {open && hits && (
        <div className="search-results">
          {!hits.length && <div className="empty">No matches</div>}
          {grouped.map(([sid, g]) => (
            <div key={sid} className="search-group">
              <div className="search-group-title">{g.title || '(untitled)'}</div>
              {g.hits.slice(0, 8).map((h, i) => (
                <button key={i} className="search-hit" onClick={() => go(h)}>
                  <Snippet text={h.snippet} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
