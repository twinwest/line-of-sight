import { useEffect, useMemo, useState } from 'react';
import { nav } from './App';
import { fetchSessions, type SessionMeta } from './api';

const RUNNING_MS = 60_000;

function shortDir(dir: string | null): string {
  if (!dir) return '';
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState('');
  const [project, setProject] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetchSessions().then(setSessions, (e: unknown) => setError(String(e)));
    const poll = () => fetchSessions().then(setSessions, () => {});
    const t = setInterval(poll, 10_000);
    // background tabs get their timers throttled/frozen — resync on return
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const projects = useMemo(
    () => [...new Set(sessions.map((s) => s.projectDir).filter((p): p is string => !!p))].sort(),
    [sessions]);

  const shown = sessions.filter((s) =>
    (!project || s.projectDir === project)
    && (!filter || s.title.toLowerCase().includes(filter.toLowerCase())));

  if (error) return <div className="page error">{error}</div>;
  return (
    <div className="page">
      <div className="list-controls">
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{shortDir(p)}</option>)}
        </select>
        <input placeholder="Filter titles…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="session-list">
        {shown.map((s) => (
          <a key={s.id} className="session-row" href={`/s/${s.id}`}
             onClick={(e) => { e.preventDefault(); nav(`/s/${s.id}`); }}>
            <span className={`dot ${s.live || Date.now() - s.updatedAt < RUNNING_MS ? 'live' : ''}`} />
            <span className="row-title">{s.title || '(untitled)'}</span>
            <span className="badge">{s.adapter === 'claude-code' ? 'claude' : s.adapter}</span>
            <span className="row-dir">{shortDir(s.projectDir)}</span>
            <span className="row-count">{s.messageCount}</span>
            <span className="row-time">{fmtTime(s.updatedAt)}</span>
          </a>
        ))}
        {!shown.length && <div className="empty">No sessions</div>}
      </div>
    </div>
  );
}
