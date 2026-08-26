import { useEffect, useState } from 'react';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { SessionView } from './SessionView';

export function nav(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'sight:theme';
const THEMES: { id: Theme; icon: string; label: string }[] = [
  { id: 'light', icon: '☀', label: 'Light' },
  { id: 'dark', icon: '☾', label: 'Dark' },
  { id: 'system', icon: '◐', label: 'Follow system' },
];

/** Anything unrecognised (or absent) means "follow the OS". */
function storedTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** Sets `data-theme` on <html>; styles.css turns that into a color-scheme
 *  override and light-dark() does the rest. The pre-paint script in
 *  index.html duplicates this — React mounts too late to avoid a flash of the
 *  wrong palette — so keep THEME_KEY and the attribute in sync with it. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return (
    <span className="theme-toggle">
      {THEMES.map((t) => (
        <button key={t.id} className={`chip ${t.id === theme ? 'active' : ''}`}
          title={t.label} aria-pressed={t.id === theme} onClick={() => setTheme(t.id)}>
          {t.icon}
        </button>
      ))}
    </span>
  );
}

export function App() {
  const [loc, setLoc] = useState(location.pathname + location.search);
  useEffect(() => {
    const onPop = () => setLoc(location.pathname + location.search);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const path = loc.split('?')[0]!;
  const sessionId = path.startsWith('/s/') ? path.slice(3) : null;
  const target = new URLSearchParams(loc.split('?')[1] ?? '').get('m');
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); nav('/'); }}>
          Line of Sight
        </a>
        <SearchBox />
        <ThemeToggle />
      </header>
      {sessionId
        ? <SessionView key={`${sessionId}:${target ?? ''}`} id={sessionId} targetMessageId={target} />
        : <SessionList />}
    </div>
  );
}
