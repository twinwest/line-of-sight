import { useEffect, useState } from 'react';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { SessionView } from './SessionView';

export function nav(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
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
      </header>
      {sessionId
        ? <SessionView key={`${sessionId}:${target ?? ''}`} id={sessionId} targetMessageId={target} />
        : <SessionList />}
    </div>
  );
}
