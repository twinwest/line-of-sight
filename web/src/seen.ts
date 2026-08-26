/** Last time each session's view was open (localStorage), so the list can show
 *  "just finished" only for sessions with activity the user hasn't looked at. */

const KEY = 'sight.lastSeen';

export function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export function markSeen(id: string): void {
  const map = loadSeen();
  map[id] = Date.now();
  // the "just finished" window is 10min; day-old entries are dead weight
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(map)) if (map[k]! < cutoff) delete map[k];
  localStorage.setItem(KEY, JSON.stringify(map));
}
