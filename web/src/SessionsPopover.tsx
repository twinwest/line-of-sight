import { dialectFor } from '../../src/shared/dialects';
import { nav } from './App';
import { fmtTime, shortDir, useSessions } from './SessionList';
import { loadSeen } from './seen';
import { dotTitle, otherSessions } from './status';

/** Topbar switcher for the other sessions that are running, waiting on you, or
 *  just finished — the session view's replacement for the search box, which is
 *  only useful from the list. Strictly pull: it opens on click, never notifies,
 *  and the chip's count is static (B1). It jumps; it does not control anything.
 *  Idle sessions are deliberately absent — that's what the list page is for. */
export function SessionsPopover({ current }: { current: string }) {
  const [sessions] = useSessions();
  const now = Date.now();
  const rows = otherSessions(sessions, current, loadSeen(), now);
  const waiting = rows.filter((r) => r.st === 'waiting').length;

  const go = (e: React.MouseEvent<HTMLElement>, path: string) => {
    e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
    nav(path);
  };

  return (
    <>
      <button className="chip" popoverTarget="sessions-list"
        title={waiting ? `${waiting} other session${waiting === 1 ? '' : 's'} waiting for you`
          : 'other sessions'}>
        Sessions{waiting ? ` · ${waiting}` : ''}
      </button>
      <div id="sessions-list" className="asks-list sessions-list" popover="auto">
        {rows.length === 0
          ? <div className="asks-hint">No other session is running.</div>
          : rows.map(({ s, st }) => (
            <button key={s.id} className="asks-item" onClick={(e) => go(e, `/s/${s.id}`)}>
              <span className="asks-q">
                <span className={`dot ${st}`} />
                <span className="asks-q-text">{s.title || '(untitled)'}</span>
                <span className={`badge ${s.adapter}`}>{dialectFor(s.adapter).displayName}</span>
              </span>
              <span className="asks-meta">
                {dotTitle(s, st, now)} · {shortDir(s.projectDir)} · {fmtTime(s.updatedAt, now)}
              </span>
            </button>
          ))}
        <button className="asks-item asks-all" onClick={(e) => go(e, '/')}>
          <span className="asks-meta">All sessions →</span>
        </button>
      </div>
    </>
  );
}
