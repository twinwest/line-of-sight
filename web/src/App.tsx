import { useEffect, useState } from 'react';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { SessionsPopover } from './SessionsPopover';
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
function ThemeRow() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return (
    <div className="row">
      Theme
      <span className="theme-toggle">
        {THEMES.map((t) => (
          <button key={t.id} className={`chip ${t.id === theme ? 'active' : ''}`}
            title={t.label} aria-pressed={t.id === theme} onClick={() => setTheme(t.id)}>
            {t.icon}
          </button>
        ))}
      </span>
    </div>
  );
}

/* Reading controls (Aa popover): root font-size multiplier and transcript
 * line width, both as sliders. Values are bare numbers in localStorage; the
 * pre-paint script in index.html mirrors these keys AND ranges — a resized
 * reader would get a layout jump on every load otherwise — keep them in sync.
 * Ranges: size ×0.85–1.3 covers the 16–21.5px needs of every macOS scaling
 * tier (TYPOGRAPHY §0.4); measure 30–60rem = 66–133 latin chars (§6.1). */
const SIZE_KEY = 'sight:font-scale';
const MEASURE_KEY = 'sight:measure';
const SIZE = { min: 0.85, max: 1.3, step: 0.05, initial: 1 };
const MEASURE = { min: 30, max: 60, step: 1, initial: 45 };

/** Missing or garbage storage clamps/falls back — same rule as storedTheme(). */
function storedNum(key: string, r: { min: number; max: number; initial: number }): number {
  const n = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : r.initial;
}

function TypeControls() {
  const [size, setSize] = useState(() => storedNum(SIZE_KEY, SIZE));
  const [measure, setMeasure] = useState(() => storedNum(MEASURE_KEY, MEASURE));
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(size));
    localStorage.setItem(SIZE_KEY, String(size));
  }, [size]);
  useEffect(() => {
    document.documentElement.style.setProperty('--measure', `${measure}rem`);
    localStorage.setItem(MEASURE_KEY, String(measure));
  }, [measure]);
  return (
    <>
      <button className="chip" title="Appearance" popoverTarget="type-controls">Aa</button>
      <div id="type-controls" className="type-controls" popover="auto">
        <ThemeRow />
        <label>
          Text size
          <input type="range" min={SIZE.min} max={SIZE.max} step={SIZE.step}
            value={size} onChange={(e) => setSize(e.currentTarget.valueAsNumber)} />
        </label>
        <label>
          Line width
          <input type="range" min={MEASURE.min} max={MEASURE.max} step={MEASURE.step}
            value={measure} onChange={(e) => setMeasure(e.currentTarget.valueAsNumber)} />
        </label>
        <button className="chip"
          onClick={() => { setSize(SIZE.initial); setMeasure(MEASURE.initial); }}>
          Default
        </button>
      </div>
    </>
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
  const params = new URLSearchParams(loc.split('?')[1] ?? '');
  const target = params.get('m');
  const query = params.get('q');
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); nav('/'); }}>
          Line of Sight
        </a>
        <SearchBox />
        <span className="topbar-tools">
          <TypeControls />
          {sessionId && <SessionsPopover current={sessionId} />}
        </span>
      </header>
      {sessionId
        ? <SessionView key={`${sessionId}:${target ?? ''}:${query ?? ''}`} id={sessionId}
            targetMessageId={target} highlightQuery={query} />
        : <SessionList />}
    </div>
  );
}
