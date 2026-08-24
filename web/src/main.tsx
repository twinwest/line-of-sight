import { createRoot } from 'react-dom/client';
import { App } from './App';
import { postStat } from './api';
import './styles.css';

postStat('viewer_open');
createRoot(document.getElementById('root')!).render(<App />);
