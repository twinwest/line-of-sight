import type { SessionMeta, StoredEvent } from '../../src/shared/types';

export type { SessionMeta, StoredEvent };
export type { RenderBlock } from '../../src/shared/types';

export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  return res.json() as Promise<SessionMeta[]>;
}

export async function fetchSession(id: string, beforeSeq?: number):
    Promise<{ session: SessionMeta; events: StoredEvent[] }> {
  const qs = beforeSeq !== undefined ? `?before_seq=${beforeSeq}` : '';
  const res = await fetch(`/api/sessions/${id}${qs}`);
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return res.json() as Promise<{ session: SessionMeta; events: StoredEvent[] }>;
}

export function postStat(event: 'viewer_open' | 'question_asked'): void {
  void fetch(`/api/stats/${event}`, { method: 'POST' }).catch(() => {});
}
