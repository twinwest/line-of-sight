import type { SessionMeta, SideChat, StoredEvent } from '../../src/shared/types';

export type { SessionMeta, SideChat, StoredEvent };
export type { RenderBlock, SideChatTurn } from '../../src/shared/types';

export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  return res.json() as Promise<SessionMeta[]>;
}

export async function fetchSession(id: string, beforeSeq?: number, targetMessageId?: string | null):
    Promise<{ session: SessionMeta; events: StoredEvent[] }> {
  const qs = beforeSeq !== undefined ? `?before_seq=${beforeSeq}`
    : targetMessageId ? `?m=${encodeURIComponent(targetMessageId)}` : '';
  const res = await fetch(`/api/sessions/${id}${qs}`);
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return res.json() as Promise<{ session: SessionMeta; events: StoredEvent[] }>;
}

export function postStat(event: 'viewer_open' | 'question_asked'): void {
  void fetch(`/api/stats/${event}`, { method: 'POST' }).catch(() => {});
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  snippet: string;   // match ranges delimited by \u0001...\u0002
}

export async function search(q: string): Promise<SearchHit[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search: ${res.status}`);
  return res.json() as Promise<SearchHit[]>;
}

export async function fetchSideChats(sessionId: string): Promise<SideChat[]> {
  const res = await fetch(`/api/side-chats?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`side-chats: ${res.status}`);
  return res.json() as Promise<SideChat[]>;
}

export async function createSideChat(sessionId: string, anchorMessageId: string, anchorText: string): Promise<SideChat> {
  const res = await fetch('/api/side-chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, anchorMessageId, anchorText }),
  });
  if (!res.ok) throw new Error(`create side-chat: ${res.status}`);
  return res.json() as Promise<SideChat>;
}

export async function deleteSideChat(id: string): Promise<void> {
  await fetch(`/api/side-chats/${id}`, { method: 'DELETE' });
}

export function cancelAsk(id: string): void {
  void fetch(`/api/side-chats/${id}/cancel`, { method: 'POST' }).catch(() => {});
}

export async function fetchResponderStatus(): Promise<string | null> {
  const res = await fetch('/api/responder/status');
  if (!res.ok) return null;
  return ((await res.json()) as { engine: string | null }).engine;
}

/** POST a question; stream chunks via callbacks. Resolves when the stream ends. */
export async function askStream(
  chatId: string,
  question: string,
  on: { chunk: (t: string) => void; error: (msg: string) => void },
): Promise<void> {
  const res = await fetch(`/api/side-chats/${chatId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok || !res.body) {
    on.error(`ask failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5)) as { text?: string; error?: string; engine?: string };
      if (ev.text) on.chunk(ev.text);
      if (ev.error) on.error(ev.engine ? `[${ev.engine}] ${ev.error}` : ev.error);
    }
  }
}
