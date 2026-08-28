import { useEffect, useMemo, useState } from 'react';
import { dialectFor } from '../../src/shared/dialects';
import { nav } from './App';
import { fetchSessions, type SessionMeta } from './api';
import { loadSeen } from './seen';
import { DOT_TITLE, RANK, sessionStatus } from './status';

export function shortDir(dir: string | null): string {
  if (!dir) return '';
  return dir.replace(/^\/Users\/[^/]+/, '~');
}

export function fmtTime(ts: number, now: number): string {
  if (!ts) return '';
  const age = now - ts;
  if (age < 60_000) return 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Poll every session's meta. Only the first failure surfaces — a later blip
 *  would flap the page between error and list. Shared with the topbar's
 *  sessions popover; there is no all-sessions SSE, so both poll. */
export function useSessions(): [SessionMeta[], string] {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const poll = (first = false) => fetchSessions().then(setSessions, (e: unknown) => {
      if (first) setError(String(e));
    });
    void poll(true);
    const t = setInterval(poll, 10_000);
    // background tabs get their timers throttled/frozen — resync on return
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return [sessions, error];
}

export function SessionList() {
  const [sessions, error] = useSessions();
  const [project, setProject] = useState('');

  const projects = useMemo(
    () => [...new Set(sessions.map((s) => s.projectDir).filter((p): p is string => !!p))].sort(),
    [sessions]);

  const seen = loadSeen();
  const now = Date.now();
  const shown = sessions
    .filter((s) => !project || s.projectDir === project)
    .map((s) => ({ s, st: sessionStatus(s, seen, now) }))
    .sort((a, b) => RANK[a.st] - RANK[b.st] || b.s.updatedAt - a.s.updatedAt);

  if (error) return <div className="page error">{error}</div>;
  return (
    <div className="page">
      <div className="list-controls">
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{shortDir(p)}</option>)}
        </select>
      </div>
      <div className="session-list">
        {shown.map(({ s, st }) => (
          <a key={s.id} className="session-row" href={`/s/${s.id}`}
             onClick={(e) => { e.preventDefault(); nav(`/s/${s.id}`); }}>
            <span className={`dot ${st}`} title={DOT_TITLE[st]} />
            <span className="row-title">{s.title || '(untitled)'}</span>
            <span className={`badge ${s.adapter}`}>{dialectFor(s.adapter).displayName}</span>
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
