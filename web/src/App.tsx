import { useEffect, useState } from 'react';
import { SessionList } from './SessionList';
import { SessionView } from './SessionView';

export function nav(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const sessionId = path.startsWith('/s/') ? path.slice(3) : null;
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); nav('/'); }}>
          Line of Sight
        </a>
      </header>
      {sessionId ? <SessionView key={sessionId} id={sessionId} /> : <SessionList />}
    </div>
  );
}
