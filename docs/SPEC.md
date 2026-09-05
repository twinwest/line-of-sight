# Line of Sight — Product Specification (v1)

Status: FINAL for v1. Decisions here were reached over a long design discussion;
the "why" is summarized inline so implementers don't need the original thread.

---

## 1. One-paragraph summary

Line of Sight is a **local-first, agent-agnostic companion app** for coding-agent CLI
sessions. It tails the local session transcripts that agent CLIs (Claude Code,
Codex CLI) already write to disk, renders them as a live, readable web page on
localhost, and adds four things the terminal cannot do: **clean copy**,
**select-any-text-and-ask** (a grounded side-chat answered by a separate
read-only LLM invocation, so the working agent's context stays clean),
**cross-session full-text search**, and a **session list**. It is launched by
wrapping the agent command: `sight claude` behaves exactly like `claude` plus
a viewer.

## 3. Design principles (binding)

| # | Principle | Practical meaning |
|---|-----------|-------------------|
| B1 | **Zero push** | UI never interrupts or prompts on its own. Interactions are ambient (glanceable) or pull (user-initiated) only. No quizzes, no gates, no popups. |
| B2 | Active cognition via workflow, not force | The learning mechanics are disguised as workflow actions (asking "what's the evidence?", distilling an answer). Never add educational friction. |
| B3 | Human's words are primary | (v1.5+, hypothesis slot) Machine summarizes; it never replaces what the user wrote. Not in v1 scope. |
| B4 | **Fail-open, off the critical path** | Wrapper spawns the agent with inherited stdio no matter what. Daemon/ingestion errors are logged, never surfaced as blocking. No proxying of agent traffic, ever. |
| B5 | **Line of Sight is read-only** | Responder invocations get read-only tools only (per-engine enforcement, see ARCHITECTURE §6). No write capability, no config toggle to enable one. This is a product promise. |
| B6 | **Data local, persisted, portable** | Q&A records and usage stats live in `~/.sight/` (SQLite). Transcripts are read in place, never copied wholesale or uploaded. No telemetry. |
| B7 | **Agent-agnostic, CLI-first** | Ingestion via per-agent adapters over local transcript files. v1 ships the Claude Code adapter; the adapter interface must make a Codex adapter a pure-addition change. |
| B8 | Retention is the north-star metric | v1 validates one question: does the builder still use it daily after 2 weeks? Learning-outcome metrics come later. |
| B9 | **Mirror the disk, don't archive it** | Sight renders the transcripts on disk and nothing else. When one goes away (the CLI's own retention cleanup, an `rm`), its session leaves Sight — subagent runs, side chats and all. No archive, no soft delete, no retention of our own. |

## 5. v1 features (complete list — nothing else)

### 5.1 C1 — Wrapper CLI (`sight`)

- `sight claude [args...]` — ensure daemon is running (start if not), open
  the viewer browser tab **once** (not on every invocation; see ARCHITECTURE
  §8), then exec/spawn `claude` with all args passed through and stdio
  inherited. Exit code = claude's exit code.
- `sight codex [args...]` — same wrapper for Codex CLI. (Full Codex
  transcript parsing, planned for v1.5, **shipped 2026-08-27** — adapter,
  dialect, and responder; see SPIKE_NOTES of that date.)
- `sight start` / `sight stop` / `sight status` — daemon lifecycle.
- `sight open` — (re)open the viewer in the browser.
- `sight stats` — print the local usage stats (daily viewer-opens and
  questions-asked for the last 14 days).
- Zero system-level install: no launchd/systemd; daemon is a detached child
  process; all state in `~/.sight/`; deleting that directory is a clean
  uninstall.

### 5.2 C2 — Live transcript viewer

- Renders a session's jsonl as a readable conversation document:
  - User prompts and assistant text rendered as Markdown (from source — the
    jsonl stores original unwrapped text, so no terminal wrap artifacts).
  - Tool calls collapsed by default to a one-line summary
    (`⏵ Read src/foo.ts`, `⏵ Bash npm test — exit 0`); click to expand full
    input/output. Long outputs scroll within the block.
  - Thinking blocks (if present in transcript) collapsed by default.
  - **Step folding**: every piece of prose the CLI shows stays visible —
    user prompts and all assistant text. Contiguous runs of non-prose
    events (tool calls/results, thinking-only rows, meta, CLI-plumbing
    user messages) collapse into one "⏵ N steps · M tool calls" row. The
    trailing run stays expanded while the session is running (live-follow)
    and folds once it goes idle (same running signal as the indicator).
    (Evolved during dogfood from turn-level folding — decided
    2026-08-25.)
  - Unknown/unparseable entries render as a collapsed raw-JSON block (never
    crash, never silently drop).
- **Live tail**: while the session file grows, new turns append in near-real
  time (≤ 2s latency) via SSE. Auto-scroll follows the tail only if the user is
  already at the bottom (standard log-viewer behavior).
- **Session header** (minimal, content-neutral): session title (precedence:
  transcript `custom-title` > `ai-title` > first user prompt truncated — see
  decided 2026-08-24), project directory, agent name, start time, running/idle
  indicator (running = the agent CLI reports itself busy or parked-on-the-user
  for this session, OR file modified within last 60s — decided
  2026-08-24 and 2026-08-26). At the transcript tail, a parked session shows
  "✋ waiting for your input in the CLI" instead of the generating indicator.
  A process that is alive but has written nothing past the stale cap is
  neither: the dot becomes a dashed ring titled "no update in 34m · process
  still alive" (decided 2026-09-02).
- Historical sessions (recorded before Line of Sight was installed) are fully
  browsable — ingestion scans the whole transcript directory, not just wrapped
  sessions.
- **Reply draft card**: a collapsed "✎ Draft reply" affordance at the
  transcript tail expands into a compose card for the user's next prompt.
  Copy is the only action — the user pastes into their own CLI; there is no
  send mechanism (§6: injection stays cut), no server involvement, and the
  card never appears on its own (zero-push). Drafts persist per session in
  the browser's localStorage; the card minimizes explicitly (− button or
  Esc, draft kept — the collapsed toggle shows the draft's first line) and
  tucks itself away after Copy. A copied draft clears itself once any newer
  user prompt arrives (the conversation moved on — the draft was sent or
  superseded); editing after Copy re-arms it as uncopied, so writing never
  auto-clears in its uncopied form. Manual clear = empty the textarea.
  Deliberately not chat-shaped (no pinned input,
  Enter is a newline) so it cannot be confused with select-to-ask, which
  addresses the responder, not the agent. (Added during dogfood — see
  decided 2026-08-26.)

### 5.3 C3 — Clean copy

The terminal breaks copy (display-layer hard wraps, TUI chrome `│ ⏺ ╭`, ANSI
residue). Line of Sight renders from source, so selection-copy is clean for free.
Additionally:

- Every code block: a **Copy** button (copies code content only).
- Every message: a **Copy Markdown** button (copies the message's raw markdown).
- Native browser text selection must work everywhere in the transcript (do not
  break it with drag handlers).

### 5.4 C4 — Select-to-ask side chat (the heart of the product)

Interaction:

1. User selects any text inside the transcript view.
2. A small floating **Ask** button appears near the selection (does not obscure
   it; disappears on click-away).
3. Clicking it opens the **side panel** (right side, ~400px, resizable) with:
   - **Pinned anchor**: the selected text quoted at the top (display truncated
     to ~500 chars with expand; full text stored).
   - Three preset question buttons: **"What is this?"**, **"Why did the
     agent do this?"**, **"Any problems with this?"** — plus a free-text
     input.
4. The question is answered by a **Responder** (see ARCHITECTURE §6): a
   separate, read-only LLM invocation with access to the full session
   transcript and the project directory. The working agent's session is never
   touched.
5. Follow-up questions in the same side chat keep the side-chat's own history
   (multi-turn within the side chat).
6. Answers are copy-clean like the rest of the viewer: code blocks inside an
   answer carry a **Copy** button (§5.3), prose is selection-copied. There is
   no per-answer Copy button — distill-back means the user copies and pastes
   into the agent themselves, and the reply draft card (§5.2) is its primary
   path; no injection mechanism in v1.

Rules:

- **"The full session transcript" means one file.** The responder is scoped to
  the single transcript the side chat's session maps to. A `/clear` ends the
  agent's session and starts a new one with its own file, so it is a hard
  boundary: questions asked after a `/clear` cannot reach pre-clear context,
  and the responder says so rather than guessing. The pre-clear session keeps
  its own row and its own side chats.
- **Persistence is the default**: every side chat (anchor + all turns) is
  saved to the local store the moment it happens. A small delete button exists;
  there is no "don't save" mode. (This data is the future digest input.)
- **Margin markers**: any message that has ≥1 saved side chat anchored to it
  shows a small dot in the gutter; clicking the dot reopens the side chat(s).
- One side chat open at a time (v1). Opening a new one closes (not deletes)
  the previous.
- While the responder is running, show a streaming/typing indicator; a Cancel
  button kills the responder process.
- If no responder engine is available (no agent CLI detected), the Ask
  button still appears but the panel shows a one-time setup hint (install a
  CLI), never a dead end.

### 5.5 C5 — Cross-session full-text search

- One search box (global, in the header). Searches the dialog — user input
  and agent output as the reader saw it (markdown stripped) — across all
  sessions (SQLite FTS5). Thinking, tool calls and tool output are out of
  scope: they drown dialog hits, and searching file contents is the repo's
  grep's job (decided 2026-09-01).
- Results grouped by session (session title + date), each hit showing a
  snippet with the match highlighted.
- Clicking a hit opens that session scrolled to that message, briefly
  highlighted.
- Must handle CJK text (see ARCHITECTURE §5 for tokenizer requirement).

### 5.6 C6 — Session list (home page)

- All ingested sessions, newest first: title (same precedence as 5.2),
  agent badge (claude/codex), project dir (shortened), start time, message
  count, running indicator (same states as the 5.2 header dot).
- Filter by project directory (dropdown). No free-text title filter: the
  list is fully rendered, so the browser's find-in-page covers title lookup,
  and a second text input next to the global search box was confusing.
- Inside a session, the topbar replaces the search box (a list-page tool) with
  a **"Sessions · N" popover**: the same statuses, minus idle and minus the
  session you're in, most actionable first, one click to jump. Pull-only — it
  opens on click, the count is static text, and rows only navigate. Not
  mission control: no agent controls, no notifications, no auto-open.
- This is the answer to multi-session usage in v1 (no mission-control
  features; just a list).

### 5.7 Usage stats (local only)

- Local-only counters in SQLite: `viewer_open` (one per page load),
  `question_asked` (one per side-chat question).
- Surfaced only via `sight stats`. No UI, no network.

## 6. Explicitly OUT of v1 (do not build, do not scaffold "for later")

| Deferred/cut | Target | Note |
|---|---|---|
| Ambient problem map / status bar, hypothesis slot, model diff | v1.5 | Design exists in discussion; nothing in v1 code |
| ~~Codex transcript adapter (full parsing)~~ | **shipped 2026-08-27** | Adapter + dialect + responder (SPIKE_NOTES 2026-08-27) |
| ~~Subagent transcripts as child sessions~~ | **shipped 2026-08-26** | `<session>/subagents/agent-*.jsonl` ingested as child sessions, opened from the parent's Task row; linkage via meta.json `toolUseId` (getlineofsight/line-of-sight#4) |
| Digest / weekly review | v2 | Raw data (Q&A store) is already collected by 5.4 |
| Distill-back injection into the agent's terminal | — | v1 = copy button only |
| Claim–evidence linking / verification layer | v2 | |
| Decision ledger, code provenance ("blame → conversation"), audit views | v2+ | |
| Unfamiliar-concept auto-extraction | cut | Covered by select-to-ask |
| Any quiz/gate/forced-explanation mechanic | never (opt-in maybe later) | Violates B1/B2 |
| Multi-agent orchestration, kanban, notifications, cost dashboards | never | Crowded/commoditized; off-thesis |
| Cloud sync, accounts, team features, telemetry | not v1 | |
| IDE integrations | not planned | CLI-first (B7) |

## 7. Non-functional requirements

- **Performance**: a 50MB session jsonl must ingest without blocking the UI
  (stream-parse, incremental index) and the viewer must stay responsive
  (virtualized message list if needed — only add virtualization if a real
  session is measurably janky).
- **Latency**: new transcript lines visible in viewer ≤ 2s.
- **Privacy**: no outbound network from the daemon except responder
  invocations. Trivially auditable (all fetch/spawn sites in a few files).
- **Robustness**: malformed jsonl lines are skipped with a logged warning;
  a schema change in a future Claude Code version must degrade to raw-JSON
  rendering, not crash.
- **Platform**: macOS first (dev machine, darwin). Avoid gratuitous
  darwin-only APIs; Linux support should be a config-paths problem, not a
  rewrite.
