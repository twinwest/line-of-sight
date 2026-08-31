# Line of Sight — Technical Architecture (v1)

Status: FINAL for v1, except items marked **[VERIFY IN M0]** — those are
assumptions the M0 spikes must confirm; if a spike contradicts one, update this
doc and record the finding in `docs/SPIKE_NOTES.md`.

---

## 1. System overview

```
 ┌──────────────────────────────┐        ┌─────────────────────────────┐
 │ Terminal                     │        │  ~/.claude/projects/**.jsonl │
 │  $ sight claude ...          │        │  ~/.codex/sessions/**.jsonl  │ (v1.5)
 │   └─ spawns `claude` (stdio  │        └──────────────┬──────────────┘
 │      inherited, fail-open)   │                       │ fs watch + scan (read-only)
 └──────────────┬───────────────┘                       ▼
                │ ensures running            ┌─────────────────────────┐
                ▼                            │ Daemon (Node/TS, single │
 ┌──────────────────────────────┐  HTTP/SSE  │ process)                │
 │ Browser: http://localhost:   │◀──────────▶│  · Adapters (ingestion) │
 │ 4989  (React SPA)            │            │  · SQLite store + FTS5  │
 │  · session list  · viewer    │            │  · HTTP API + SSE       │
 │  · select-to-ask · search    │            │  · Responder runner     │
 └──────────────────────────────┘            └───────────┬─────────────┘
                                                         │ spawn, read-only tools
                                                         ▼
                                             `claude -p ...` / `codex exec ...`
                                             / direct API (BYOK fallback)
```

One daemon process serves everything. No proxying of the agent's traffic, no
hooks required (pure file-tailing keeps us fail-open and version-independent).

## 2. Tech stack (decided — do not substitute)

- **Language**: TypeScript (strict), Node.js ≥ 20. Single npm package,
  workspaces optional but not required.
- **Daemon/HTTP**: Fastify. Live updates via **SSE** (simpler than WebSocket;
  we only push server→client).
- **Store**: `better-sqlite3`, single DB file `~/.sight/sight.db`, WAL
  mode. Full-text search via **FTS5 with the `trigram` tokenizer** (built into
  the SQLite bundled by better-sqlite3; trigram handles CJK + substring
  matching without a segmenter). **[VERIFIED M0]** trigram available
  (SQLite 3.53.4), but queries < 3 chars match nothing — use `LIKE '%q%'` on
  `messages.text_content` for queries shorter than 3 characters.
- **File watching**: `chokidar` on the transcript root dirs.
- **Frontend**: Vite + React + TypeScript. Styling: plain CSS modules or
  Tailwind — implementer's choice, but no heavy UI framework. Markdown
  rendering: `react-markdown` + `rehype-highlight` (code highlighting).
  Sanitize rendered HTML (transcripts contain untrusted content —
  agent/webpage text must not become live HTML/scripts).
- **CLI**: hand-rolled dispatch, no arg-parsing library (see DECISIONS.md
  2026-08-24 M4 — wrapper passthrough safety + startup latency).
  Distributed as an npm bin (`npm link` during dogfood).
  Note: publish as npm package `line-of-sight` (name verified available
  2026-08-19) with `"bin": {"sight": ...}`. The npm package `sight` itself is
  taken by a stale 2022 lib — irrelevant, since only the bin name is `sight`.
  GitHub home: the `getlineofsight` org (registered 2026-08); target repo
  `getlineofsight/line-of-sight`. Domain not registered yet (deferred until
  public release; first choice `lineofsight.dev`).
- **Tests**: `vitest`.

## 3. Repository layout

```
line-of-sight/
  package.json
  src/
    cli/            # bin entry: wrap, start/stop/status, open, stats
    daemon/         # fastify server, SSE hub, lifecycle (pidfile)
    adapters/       # Adapter interface + claudeCode.ts (+ codex.ts in v1.5)
    store/          # sqlite schema, queries, FTS
    responders/     # Responder interface + claudeCli.ts, codexCli.ts
    shared/         # types shared with frontend (SessionMeta, RenderBlock, ...)
      dialects/     # per-agent presentation policy (pure functions; see §9)
  web/              # vite react app (built to web/dist, served by daemon)
  test/
  docs/
```

## 4. Ingestion: the Adapter interface

```ts
// src/adapters/types.ts
export interface AgentAdapter {
  id: 'claude-code' | 'codex';           // extend by union, no registry magic
  /** Absolute dirs to scan/watch for transcripts. */
  roots(): string[];
  /** chokidar depth under each root; omit = unlimited. */
  watchDepth?: number;
  /** Cheap check: is this file a session transcript this adapter owns? */
  matches(filePath: string): boolean;
  /** Parse one jsonl line into zero or more normalized events. MUST NOT throw. */
  parseLine(line: string, ctx: { filePath: string; byteOffset: number }): NormalizedEvent[];
  /** Derive session metadata from path + first events. */
  sessionMeta(filePath: string, firstEvents: NormalizedEvent[]): SessionMeta;
  /** sessionId → what the agent process is doing right now ('busy' mid-turn,
   *  'waiting' parked on the user, 'alive' = process exists but the agent
   *  has no busy/idle vocabulary — the transcript's turn markers decide;
   *  since = when that state began, 0 if unknown), if the agent exposes
   *  such a signal. MUST NOT throw; empty map when unavailable. */
  liveSessions?(): Map<string, { state: 'busy' | 'waiting' | 'alive'; since: number }>;
}

Session ids must be globally unique across adapters (all adapters share one
sessions table and one merged live map) — derive them from the transcript's
own uuid.
```

### Normalized model (shared/types.ts)

```ts
export interface SessionMeta {
  id: string;              // adapter-scoped stable id (claude: session uuid from filename)
  adapter: 'claude-code' | 'codex';
  filePath: string;
  projectDir: string | null;
  title: string;           // custom-title > ai-title > first user prompt, truncated to 120 chars
  startedAt: number; updatedAt: number;
  messageCount: number;
}

export type NormalizedEvent =
  | { kind: 'message'; id: string; role: 'user' | 'assistant';
      ts: number; blocks: RenderBlock[]; sessionPatch?: SessionPatch }
  | { kind: 'meta'; id: string; ts: number; label: string; raw: unknown;
      sessionPatch?: SessionPatch }                                        // system/attachment entries
  | { kind: 'unknown'; id: string; ts: number; raw: unknown };             // defensive fallback

// Session metadata revealed mid-file (titles, cwd); applied by ingest with
// title precedence custom > ai > prompt (see DECISIONS.md 2026-08-24).
export interface SessionPatch {
  projectDir?: string;
  title?: string;
  titleSource?: 'custom' | 'ai' | 'prompt';
}

export type RenderBlock =
  | { type: 'text'; markdown: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id?: string | null; toolName: string; summary: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string | null; summary: string;
      output: string; isError: boolean }
  | { type: 'raw'; json: unknown };   // anything unrecognized inside a message
```

Notes:
- `id` must be stable across re-parses (use the transcript's own uuid when
  present; else `filePath:lineNo`). Q&A anchors reference message ids.
- `summary` for tool blocks is computed at parse time (e.g. `Read src/x.ts`,
  `Bash: npm test`). Keep heuristics per-adapter, simple, and safe on missing
  fields.

### Claude Code adapter specifics **[VERIFIED M0 — details in SPIKE_NOTES.md]**

- Transcript root: `~/.claude/projects/`. One subdirectory per project cwd
  (path munged **lossily**: `/` and `_` both → `-`; derive projectDir from
  the `cwd` field on message lines, never from the dir name), containing
  `<session-uuid>.jsonl` files. `matches()` accepts those plus subagent
  transcripts at `<uuid>/subagents/agent-*.jsonl`, ingested as child sessions
  of the surrounding `<uuid>` (see "Subagent sessions" below); `memory/*.md`
  and the `.meta.json` sidecars are not transcripts.
- Line schema (observed on CLI 2.1.202–2.1.241; treat as unstable): JSON
  objects with `type` — observed: `user`, `assistant`, `system`, `attachment`,
  `mode`, `permission-mode`, `last-prompt`, `ai-title`, `custom-title`,
  `agent-name`, `bridge-session`, `queue-operation`, `file-history-snapshot`,
  `file-history-delta`, `atis-latch` (no `summary` seen) — plus `uuid`,
  `parentUuid`, `timestamp` (ISO ms Z), `sessionId`, `cwd`, and on message
  lines `message` (Messages-API-shaped; `content` is a **string or** array of
  blocks — `text`, `tool_use`, `tool_result`, `thinking`, `image`,
  `fallback`, ...). `tool_result.content` is itself string or array. Tool
  results arrive as `type: "user"` entries whose content is `tool_result`
  blocks — render those as part of the tool flow, not as user prompts.
  Non-message types are small — render as `meta`. `custom-title`/`ai-title`
  feed the session title (see SPEC 5.2).
- Top-level lines never had `isSidechain: true` (subagents live in the
  subagents dir); keep the defensive `meta` rendering if one ever appears.
- Fixtures from real (redacted) lines: `test/fixtures/claude-code/`.

### Subagent sessions

A subagent run is an ordinary session with two extra columns: `parent_id` (the
surrounding `<uuid>` dir — derived from the path, so always known) and
`tool_use_id` (from the sibling `agent-*.meta.json`, which also supplies the
title `agentType · description`; best-effort, the file is undocumented). Line
schema is identical to a top-level transcript, so `parseLine` is unchanged;
only `fork-context-ref` is new (dropped as bookkeeping). Workflow-tool runs
put their agents one level down, `subagents/workflows/<wf_id>/agent-*.jsonl`,
beside a `journal.jsonl` ledger (skipped); their meta.json has no
`toolUseId`, so they title as `workflow-subagent · <wf_id>` and have no row
link (DECISIONS 2026-08-28).

`listSessions()` returns `parent_id IS NULL` only — children are reached from
their parent, never from the session list. `/api/sessions/:id` carries
`children`, and the viewer keys them by `tool_use_id` to put a "transcript ↗"
link on the Task row. Two link sites, because the CLI writes Task calls two
ways: on the `tool_use` fold when the use reached the transcript, and on the
orphan `tool_result` when it did not (parallel Task batches write only
results). A child with no `meta.json` has no `tool_use_id` and gets no row
link — the header's "Subagents · N" popover is the fallback route.

No process signal of its own: subagents have no `~/.claude/sessions/
<pid>.json`. Their end is read from the parent transcript instead — the
`<task-notification>` line (async Agent/Task and Workflow calls; the
tool_result is only a spawn-ack) or a sync Task's tool_result — and stored
as `ended_at`; a child without one is running while its parent process is
(DECISIONS 2026-08-28).

### Ingestion pipeline

1. On daemon start: scan all adapter roots; for each transcript file, if
   `(filePath, size, mtime)` differs from the stored checkpoint, incrementally
   parse from the stored byte offset (files are append-only; if size shrank,
   re-parse from 0).
2. chokidar watches roots; on change, same incremental parse; new events go to
   (a) SQLite (messages + FTS) and (b) the SSE hub for live viewers.
3. Parsing must be line-buffered and tolerant of a partial last line (the
   checkpoint stays at the last complete newline; the tail is re-read once the
   newline arrives).

## 5. Store (SQLite)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, adapter TEXT, file_path TEXT UNIQUE, project_dir TEXT,
  title TEXT DEFAULT '', title_source TEXT,
  started_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0,
  byte_offset INTEGER DEFAULT 0   -- always at a line boundary; partial tails re-read
);
CREATE TABLE messages (
  id TEXT, session_id TEXT, seq INTEGER, role TEXT, ts INTEGER,
  blocks_json TEXT,               -- serialized RenderBlock[]
  text_content TEXT,              -- concatenated searchable text
  PRIMARY KEY (session_id, id)
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text_content, content='messages', tokenize='trigram'
);
CREATE TABLE side_chats (
  id TEXT PRIMARY KEY, session_id TEXT, anchor_message_id TEXT,
  anchor_text TEXT, created_at INTEGER,
  turns_json TEXT                 -- [{role:'user'|'assistant', text, ts}]
);
CREATE TABLE stats (day TEXT, event TEXT, count INTEGER, PRIMARY KEY (day, event));
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);  -- e.g. last_viewer_open
```

- FTS kept in sync with triggers or explicit insert-after-write (implementer's
  choice; test it).
- The DB is derived data **except** `side_chats` and `stats` (user-owned;
  never wiped by a re-index; `sight reindex` may drop/rebuild sessions +
  messages only).

## 6. Responder (the answering engine) — pluggable, decoupled from the viewed agent

The engine answering side-chat questions is decoupled from the viewed agent
(any engine can answer about any session — the interface guarantees that),
but by default it **matches the viewed session's agent**: a Codex session is
answered by codex-cli, a Claude session by claude-cli. Rationale: a session's
presence on disk implies its CLI is installed and authenticated — routing by
session always picks a login the user actually has. A config pin overrides.

```ts
export interface Responder {
  id: 'claude-cli' | 'codex-cli';
  available(): Promise<boolean>;        // e.g. `which claude`
  /** Streamed answer. MUST be read-only (see per-engine notes).
   *  onStatus: optional tool-activity progress for the panel. */
  answer(req: ResponderRequest, onChunk: (s: string) => void,
         signal: AbortSignal, onStatus?: (s: string) => void): Promise<string>;
}

export interface ResponderRequest {
  question: string;
  anchorText: string;
  sessionFilePath: string;   // pointer — engine reads it itself when it has tools
  projectDir: string | null;
  priorTurns: { role: 'user' | 'assistant'; text: string }[];
}
```

**Resolution** (`responders/index.ts` — routing is a pure `candidates()`
function over config + session adapter; availability probing sits outside it):
1. `responder` pinned in `~/.sight/config.json` → that engine ONLY. If it is
   unavailable the ask fails with a readable 409 — no silent fallback to an
   engine the user didn't pick.
2. else the engine matching the viewed session's adapter
   (`claude-code`→`claude-cli`, `codex`→`codex-cli`) if available
3. else first available of claude-cli, codex-cli
4. none → UI shows setup hint (SPEC 5.4).

`GET /api/responder/status` reports the *default* engine (no session context);
the engine actually used is announced in the ask SSE's first frame.

### claude-cli responder **[VERIFIED M0]**

Spawn per question (cwd = projectDir if available, else home):

```
claude -p "<composed prompt>" --allowedTools "Read,Grep,Glob" \
  --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,Bash,Task,WebFetch,WebSearch" \
  --no-session-persistence --setting-sources "" \
  --output-format stream-json --include-partial-messages --verbose
```

(WebFetch removed from the M0-era flag set and mutating tools hard-blocked —
see DECISIONS.md 2026-08-24 M3: --allowedTools alone only auto-denies, while
--disallowedTools removes the tools structurally; WebFetch would allow
prompt-injection exfiltration of transcript text.)

Stdout is jsonl; answer text = `stream_event` lines with
`content_block_delta`/`text_delta` (ignore `system`, hook, and snapshot
lines — `-p` runs the user's hooks, which is accepted noise; `--bare` would
skip them but breaks OAuth auth).

- Composed prompt template (keep in one file, `responders/prompt.ts`):
  system-style preamble ("You are answering a reader's question about a
  coding-agent session. The full transcript is at <sessionFilePath> — read the
  relevant parts with your tools. The project lives at <projectDir>. Be
  grounded: cite what in the transcript or files supports your answer. Answer
  concisely.") + prior side-chat turns + `ANCHOR (user-selected text): ...` +
  `QUESTION: ...`.
- **Pointer, not payload**: do NOT inline the whole transcript. The engine
  reads the jsonl itself via Read/Grep. (Fallback for engines without tools:
  inline the anchor's surrounding ±30 messages, truncated to ~30k chars.)
- Billing rides the user's existing Claude subscription/login — that is the
  point of this design (target users are subscribers without API keys).
- M0 verified: works concurrently with an interactive `claude` session;
  `--allowedTools` blocks writes (file not created); latency seconds-scale
  (~8s trivial, ~24s transcript-reading question).

### codex-cli responder **[SHIPPED 2026-08-27 — verified on codex-cli 0.150.1]**

```
codex exec --sandbox read-only --ephemeral --json --skip-git-repo-check "<composed prompt>"
```

Same prompt template, spawned with stdin IGNORED (a piped stdin makes
`codex exec` wait for EOF to append it to the prompt). `--ephemeral` is the
`--no-session-persistence` analog — without it each ask writes a rollout
into `~/.codex/sessions`. `--json` has no token deltas: completed
`agent_message` items are the answer (item-sized chunks); `item.started`
command executions feed the progress line. `responderModel`/
`responderEffort` are NOT applied — they are claude-cli settings; codex
runs on the user's own config.toml model. Details: DECISIONS 2026-08-27.

### Engine config

- Optional for any engine: `"responderModel"` (claude-cli `--model`; CLI
  default otherwise) and `"responderEffort"` (low|medium|high|xhigh|max).
  Read per-ask — no daemon restart needed.
- A BYOK api engine (direct Messages API, no tools, inline excerpt as its
  grounding) existed through 2026-08-31 and was cut: it never ran (requires
  both CLIs absent plus a hand-configured key — contradicting "a session on
  disk implies its CLI is installed"), and its tool-less grounding forced
  every grounding improvement to be built twice. See DECISIONS 2026-08-31;
  the Responder interface is the seam to rebuild it against if a real user
  needs one.

### Read-only enforcement summary (product promise B5)

| Engine | Mechanism |
|---|---|
| claude-cli | `--allowedTools "Read,Grep,Glob"` + `--disallowedTools` on all mutating/exfiltrating tools |
| codex-cli | `--sandbox read-only` |

If an engine cannot guarantee read-only, it must not be offered as a
candidate.

## 7. HTTP API (daemon, port 4989 default, `SIGHT_PORT` to override; bind 127.0.0.1 only)

```
GET  /api/sessions?project=&q=            → SessionMeta[]
GET  /api/sessions/:id                    → SessionMeta + events (paginated: ?before_seq=&limit=200)
GET  /api/sessions/:id/stream             → SSE: new NormalizedEvents as they ingest
GET  /api/search?q=                       → [{ sessionId, sessionTitle, messageId, snippet }]  (match ranges U+0001…U+0002-delimited, no HTML — DECISIONS 2026-08-24 M4)
GET  /api/side-chats?sessionId=           → SideChat[] (for margin markers)
POST /api/side-chats                      → create { sessionId, anchorMessageId, anchorText }
POST /api/side-chats/:id/ask              → body { question }; response = SSE stream of chunks; persists turn on completion
POST /api/side-chats/:id/cancel
DELETE /api/side-chats/:id
POST /api/stats/:event                    → increment (viewer_open | question_asked)
GET  /api/responder/status                → { engine, responderModel, responderEffort } (never apiKey)
PUT  /api/responder/config                → { responderModel?, responderEffort? } → ~/.sight/config.json
GET  /api/health
```

Serve `web/dist` statically at `/`. SPA routes: `/` (session list),
`/s/:sessionId` (viewer, `?m=<messageId>` scroll target).

## 8. CLI behaviors (fail-open details)

`sight claude [args...]`:
1. Best-effort (wrap in try/catch, 1s timeout budget total): ensure daemon —
   check pidfile + `/api/health`; if down — or up but started before
   `dist/daemon/main.js` was last written (`/api/health.startedAt`), in which
   case SIGTERM it first — spawn detached
   (`child_process.spawn(node daemonEntry, { detached: true, stdio: 'ignore' })`).
2. Best-effort: open browser to `http://localhost:4989` **only if** no viewer
   opened in the last 6h (daemon tracks last `viewer_open`; ask
   `/api/health?includeLastOpen=1`); use `open` (macOS) via a small
   cross-platform helper.
3. Always: `spawn('claude', args, { stdio: 'inherit' })`; forward SIGINT/SIGTERM;
   `process.exit(childCode)`.
Steps 1–2 failing must not delay step 3 by more than ~1s and must never abort it.

Daemon lifecycle: pidfile `~/.sight/daemon.pid`; `sight stop` sends
SIGTERM; stale pidfiles are detected via `/api/health` probe.

## 9. Frontend structure (guidance, not pixel spec)

### Per-agent presentation: dialects (src/shared/dialects/)

The adapter parses transcripts into RenderBlocks; how an agent's tools
*present* — which tool_use is a question card or a plan, how file edits
diff, what counts as CLI plumbing, the input-queue strip — is per-agent
presentation policy. That lives in a `Dialect`: pure
`RenderBlock/StoredEvent → data` functions (no React, no node APIs — the
directory is daemon-importable on purpose), dispatched by
`dialectFor(session.adapter)` with a generic fallback whose every method
returns null/false/[] — an agent without a dialect renders at the defensive
floor (plain folds, no cards). Deliberately NOT adapter-side semantic
normalization: presentation semantics churn fast and stored semantics would
tax every iteration with a re-ingest; promote a semantic into shared types
only once it recurs in ≥2 agents with the same shape (see DECISIONS
2026-08-27).

- Layout: left = content (list or transcript), right = collapsible side-chat
  panel. Global header: app name, reading controls, and — on the list page —
  the search box and project filter; on a session page the search box gives way
  to the "Sessions · N" switcher popover (SPEC §5.6).
- Transcript message rendering per RenderBlock type; tool_use/tool_result and
  thinking are `<details>`-style collapsed rows; `unknown`/`raw` are collapsed
  JSON `<pre>`.
- Selection → Ask button: on `mouseup` inside the transcript container, if
  `window.getSelection()` is non-empty and within one message element, show
  the floating button anchored to the selection rect. Record
  `anchorMessageId` = that message's id.
- Margin marker: absolute-positioned dot in the message gutter when
  `/api/side-chats` reports anchors for that message.
- Keep state simple: React Query or plain fetch+useState; no Redux.
- Dark/light: follow `prefers-color-scheme`; both must be readable (developer
  audience defaults to dark).

## 10. Error handling & logging

- Daemon log: `~/.sight/daemon.log` (append, size-capped rotate at 5MB).
- Parse warnings logged once per file per schema-surprise (no log spam per line).
- Responder failures surface in the side panel as a readable error with the
  engine name and a retry button — never a silent empty answer.

## 11. Security notes

- Bind 127.0.0.1 only. No auth in v1 (localhost, single user) — acceptable and
  documented.
- Sanitize all rendered markdown/HTML (transcripts contain untrusted text from
  webpages/tools). No `dangerouslySetInnerHTML` on unsanitized content.
- Responder prompts include transcript content — that content is untrusted;
  the read-only tool cage (B5) is the mitigation for prompt-injection attempts
  from transcript text. Never widen the toolset.
