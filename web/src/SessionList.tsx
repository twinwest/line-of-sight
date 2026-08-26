import { useEffect, useMemo, useState } from 'react';
import { nav } from './App';
import { fetchSessions, type SessionMeta } from './api';
import { loadSeen } from './seen';

const RUNNING_MS = 60_000;
const DONE_MS = 10 * 60_000;

/** Actionability order: waiting on the user > unseen result > running > idle. */
type Status = 'waiting' | 'done' | 'busy' | 'idle';
const RANK: Record<Status, number> = { waiting: 0, done: 1, busy: 2, idle: 3 };
const DOT_TITLE: Record<Status, string> = {
  waiting: 'waiting for you', done: 'just finished', busy: 'running', idle: 'idle',
};

function status(s: SessionMeta, seen: Record<string, number>, now: number): Status {
  if (s.waiting) return 'waiting';
  if (s.live) return 'busy';
  if (now - s.updatedAt < DONE_MS && s.updatedAt > (seen[s.id] ?? 0)) return 'done';
  // adapters without a live signal: recent transcript activity = probably running
  if (now - s.updatedAt < RUNNING_MS) return 'busy';
  return 'idle';
}

function shortDir(dir: string | null): string {
  if (!dir) return '';
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

function fmtTime(ts: number, now: number): string {
  if (!ts) return '';
  const age = now - ts;
  if (age < 60_000) return 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
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

  const seen = loadSeen();
  const now = Date.now();
  const shown = sessions
    .filter((s) =>
      (!project || s.projectDir === project)
      && (!filter || s.title.toLowerCase().includes(filter.toLowerCase())))
    .map((s) => ({ s, st: status(s, seen, now) }))
    .sort((a, b) => RANK[a.st] - RANK[b.st] || b.s.updatedAt - a.s.updatedAt);

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
        {shown.map(({ s, st }) => (
          <a key={s.id} className="session-row" href={`/s/${s.id}`}
             onClick={(e) => { e.preventDefault(); nav(`/s/${s.id}`); }}>
            <span className={`dot ${st}`} title={DOT_TITLE[st]} />
            <span className="row-title">{s.title || '(untitled)'}</span>
            <span className="badge">{s.adapter === 'claude-code' ? 'claude' : s.adapter}</span>
            <span className="row-dir">{shortDir(s.projectDir)}</span>
            <span className="row-count">{s.messageCount}</span>
            <span className="row-time">{fmtTime(s.updatedAt, now)}</span>
          </a>
        ))}
        {!shown.length && <div className="empty">No sessions</div>}
      </div>
    </div>
  );
}
