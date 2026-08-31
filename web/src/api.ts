import type { SessionMeta, SideChat, SideChatTurn, StoredEvent } from '../../src/shared/types';

export type { SessionMeta, SideChat, StoredEvent };
export type { RenderBlock, SideChatTurn } from '../../src/shared/types';

export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  return res.json() as Promise<SessionMeta[]>;
}

export interface SessionPayload {
  session: SessionMeta;
  events: StoredEvent[];
  children: SessionMeta[];   // subagent runs spawned by this session
  runs: Record<string, string>;  // workflow run id → workflow name
}

export async function fetchSession(id: string, beforeSeq?: number, targetMessageId?: string | null):
    Promise<SessionPayload> {
  const qs = beforeSeq !== undefined ? `?before_seq=${beforeSeq}`
    : targetMessageId ? `?m=${encodeURIComponent(targetMessageId)}` : '';
  const res = await fetch(`/api/sessions/${id}${qs}`);
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return res.json() as Promise<SessionPayload>;
}

/** Metadata only (limit=0) — cheap enough to poll for `live` and new subagents. */
export async function fetchSessionMeta(id: string): Promise<SessionPayload> {
  const res = await fetch(`/api/sessions/${id}?limit=0`);
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return res.json() as Promise<SessionPayload>;
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

export interface ResponderStatus {
  engine: string | null;
  /** engine-declared model/effort choices; null = engine takes neither */
  options: { models: string[]; efforts: string[] } | null;
  responderModel: string;
  responderEffort: string;
}

export async function fetchResponderStatus(adapter?: SessionMeta['adapter']): Promise<ResponderStatus | null> {
  const res = await fetch(`/api/responder/status${adapter ? `?adapter=${adapter}` : ''}`);
  if (!res.ok) return null;
  return res.json() as Promise<ResponderStatus>;
}

export function putResponderConfig(cfg: { responderModel?: string; responderEffort?: string }): void {
  void fetch('/api/responder/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  }).catch(() => {});
}

/** An in-flight (and then finished) ask lives here rather than in the panel, so
 *  closing the panel or switching to a sibling chat mid-answer doesn't take the
 *  question with it — a remounted panel reattaches to the same stream. Entries
 *  are per page load; the daemon persists both turns either way. */
export interface Ask {
  turns: SideChatTurn[];      // the chat as this page has seen it
  question: string;           // last question asked here — Retry uses it
  streaming: string | null;   // in-flight answer text; null when not asking
  progress: string;           // responder tool activity
  error: string;
}
const asks = new Map<string, Ask>();
const askSubs = new Set<() => void>();

export function subscribeAsks(fn: () => void): () => void {
  askSubs.add(fn);
  return () => { askSubs.delete(fn); };
}
export function getAsk(id: string): Ask | undefined { return asks.get(id); }

// entries are replaced, never mutated: useSyncExternalStore compares by identity
function patchAsk(id: string, patch: Partial<Ask>): void {
  asks.set(id, { ...asks.get(id)!, ...patch });
  askSubs.forEach((f) => f());
}

/** Ask and stream the answer into the registry. Resolves when the stream ends. */
export async function runAsk(chatId: string, question: string, baseTurns: SideChatTurn[]): Promise<void> {
  const prev = asks.get(chatId);
  asks.set(chatId, {
    turns: [...(prev?.turns ?? baseTurns), { role: 'user', text: question, ts: Date.now() }],
    question, streaming: '', progress: '', error: '',
  });
  askSubs.forEach((f) => f());
  let acc = '';
  await askStream(chatId, question, {
    chunk: (t) => { acc += t; patchAsk(chatId, { streaming: acc }); },
    status: (s) => patchAsk(chatId, { progress: s }),
    error: (msg) => patchAsk(chatId, { error: msg }),
  });
  const cur = asks.get(chatId)!;
  patchAsk(chatId, {
    streaming: null,
    progress: '',
    turns: acc ? [...cur.turns, { role: 'assistant', text: acc, ts: Date.now() }] : cur.turns,
  });
}

/** POST a question; stream chunks via callbacks. Resolves when the stream ends. */
export async function askStream(
  chatId: string,
  question: string,
  on: { chunk: (t: string) => void; error: (msg: string) => void; status?: (s: string) => void },
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
      const ev = JSON.parse(line.slice(5)) as
        { text?: string; error?: string; engine?: string; status?: string };
      if (ev.text) on.chunk(ev.text);
      if (ev.status) on.status?.(ev.status);
      if (ev.error) on.error(ev.engine ? `[${ev.engine}] ${ev.error}` : ev.error);
    }
  }
}
