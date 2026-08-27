# M0 Spike Notes

Date: 2026-08-24. Machine: darwin, Claude Code 2.1.241, `codex` not installed.

## S1 — Claude Code transcript reality check

Examined all 5 project dirs under `~/.claude/projects/` (~6600 lines total),
including one 4.5MB July session (CLI v2.1.202) and current sessions (v2.1.241).

**Layout**
- `~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl` — confirmed.
- **Path munging is lossy**: `/` AND `_` both become `-`
  (`/Users/jane_doe/...` → `-Users-jane-doe-...`). ⇒ Do NOT derive projectDir
  from the dir name; use the `cwd` field present on message lines.
- Session id = filename uuid — confirmed.
- Non-transcript content lives alongside: `<session-uuid>/subagents/agent-*.jsonl`
  (+ `.meta.json`) for subagent transcripts, and `memory/*.md` dirs.
  `matches()` must accept only top-level `<uuid>.jsonl`. Top-level lines never
  had `isSidechain: true` (only `false` or absent) — sidechains live in the
  subagents dir instead. v1: ignore subagent files (their results appear in the
  parent's tool_result blocks anyway).
- Append-only: consistent with observations (timestamps strictly increasing);
  keep the size-shrank ⇒ reparse-from-0 guard anyway.
- Timestamps: ISO 8601 with ms, UTC `Z` (`2026-08-17T04:13:32.543Z`).

**Line `type` values observed** (count across all files):
`assistant` (2208), `user` (1376), `attachment` (433), `mode` (361),
`file-history-snapshot` (358), `system` (354), `last-prompt` (354),
`ai-title` (321), `permission-mode` (211), `bridge-session` (211),
`queue-operation` (50), `custom-title` (9), `agent-name` (9),
`file-history-delta` (5), `atis-latch` (3).
- No `summary` type in any file (docs assumed it might exist; older versions
  may differ — the `unknown` fallback covers it).
- `ai-title` / `custom-title` carry a per-session title (better than
  first-user-prompt; custom > ai). Multiple `ai-title` lines per session —
  last one wins.
- `system` lines have `subtype` (observed: `turn_duration`).
- `attachment` lines carry hook output, date changes, etc. (`.attachment.type`).
- Everything except `user`/`assistant` → render as `meta`/skip; all are small.

**Message lines** (`user` / `assistant`)
- Envelope fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`,
  `version`, `gitBranch`, `isSidechain`, `userType`, plus optional
  `isMeta`, `isApiErrorMessage`, `toolUseResult`, `slug`, `promptId`, ...
  Key sets vary line-to-line even within one file — parse field-by-field,
  never validate whole-object shape.
- `message.content` is **string** (326×, plain user prompts incl.
  local-command caveats) **or array** of blocks.
- Block types observed: `tool_use` (1037), `tool_result` (1037),
  `thinking` (690), `text` (495), `image` (2), `fallback` (2, model-fallback
  notice `{from:{model},to:{model}}`).
- `tool_result.content` is **string (999×) or array (42×)** of
  `text` / `image` / `tool_reference` blocks.
- Tool results arrive as `type:"user"` lines whose content is `tool_result`
  blocks — confirmed; must not render as user prompts.
- `image` blocks: `{source:{type:"base64",media_type,data}}` — data can be MBs.
- Assistant error lines: `isApiErrorMessage: true` + `error` field.

**Fixtures**: `test/fixtures/claude-code/entries.jsonl` — 23 real (shortest
representative, image data redacted) lines, one per type/shape above.
`edge-cases.jsonl` — malformed JSON, unknown type, unknown block, null message.

## S2 — `claude -p` as responder

All assumptions confirmed, on v2.1.241, **while this interactive session was
running concurrently** (no conflict):

- `claude -p "<q>" --allowedTools "Read,Grep,Glob"` works non-interactively,
  used Read on a 700KB transcript, answered groundedly, exited 0.
- Write cage: asked it to create a file with the same flags — Write tool
  denied, file not created, model reported "CANNOT-WRITE". B5 holds.
- **Latency**: simple prompt ~8s; read-a-transcript question ~24s wall clock.
  Seconds-scale — the panel's streaming indicator matters.
- **Streaming**: `--output-format stream-json` requires `--verbose` and
  `--include-partial-messages` for deltas. Stream is jsonl on stdout:
  filter to `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":...}}}`
  for the answer text; ignore `system`/`hook_*`/`assistant` snapshot lines.
- **Gotcha**: `-p` mode runs the user's hooks (SessionStart etc.) and loads
  CLAUDE.md — extra latency + system-noise lines in the stream. `--bare`
  would skip hooks but kills OAuth auth (API-key only) — unusable for
  subscription users. Accept the noise; filter by event type.

## S3 — `codex exec` smoke test

`codex` not on PATH on this machine. Recorded; codex responder ships in v1.5
as planned. No flag verification possible.

## S4 — FTS5 trigram

better-sqlite3 (v12, SQLite 3.53.4): `tokenize='trigram'` available.
- English substring (`"cremental"`) ✓, CJK ≥3 chars ✓, mixed CJK/Latin ✓.
- **Limitation**: queries with < 3 chars return nothing (trigram needs 3) —
  including 2-char CJK words, which are common.
- Decision: trigram FTS for queries ≥ 3 chars; `LIKE '%q%'` scan on
  `messages.text_content` for shorter queries (see DECISIONS.md).

## Addendum 2026-08-25 — transcript write granularity (no token streaming)

Measured because the viewer shows a long answer only when it lands whole.
Polled a live transcript's size once a second while a turn ran:

```
t=6s    7 lines      user message + metadata
t=7s    8 lines
t=8..18s 8 lines     model generating — file does not move
t=19s  11 lines      +4KB in one write
```

- **Blocks, not tokens.** Nothing is written mid-block. Token-level streaming
  from the transcript is impossible; `--include-partial-messages` exists only
  for `-p` (the responder path already uses it).
- ~~**But each block is its own line, written when that block completes** — not
  batched at turn end. Real gaps within one `requestId`:
  `thinking 17:29:41 (31KB) → text 17:31:03 (5.8KB)`, 82s apart;
  another 85s apart.~~ **WRONG — corrected by the 2026-08-26 addendum below.**
  Each block is its own *line*, but those gaps are the timestamps the lines
  carry (generation time), which say nothing about when they were written.
  Writes are batched per assistant message.
- The only genuinely live source is the TUI's own stdout via a PTY. Rejected:
  it is full-screen ANSI redraw (needs a headless terminal emulator, breaks on
  every CC rendering change), it puts a layer between the user and their agent
  in violation of B4 fail-open, and it carries *less* than the JSONL (thinking
  collapsed, tool output truncated).

Two fields in `~/.claude/sessions/<pid>.json` were not being used and now are:
`procStart` (UTC wall clock, no zone marker — `ps -o lstart=` prints the same
instant in local time) and `statusUpdatedAt` (turn start, epoch ms). See
DECISIONS.md 2026-08-25.

## Addendum 2026-08-26 — writes are batched per assistant message; `status: waiting`

Triggered by a dogfood report: an answer ending in an AskUserQuestion did not
appear in the viewer until the question was answered. Watched a live
transcript's byte size at 300ms while parking the CLI on a question:

```
+0.0s    START
+327.8s  +15543B  assistant:thinking | assistant:text(1157ch) |
                  assistant:tool_use[AskUserQuestion] | user:tool_result | attachment
```

- **The write unit is one assistant message plus its tool result**, flushed
  when the tool returns — not one write per block. 327s of nothing, then five
  lines in a single 15KB write at the moment the user answered.
- Confirmed by the complementary case in the same log: text sharing a message
  with a *non-blocking* tool (`text(137ch) | tool_use[Bash] | tool_result`)
  landed immediately, because Bash returns in milliseconds. So prose is held
  exactly as long as the tool it shares a message with.
- **Consequence**: the transcript can never show a blocking tool
  (AskUserQuestion / ExitPlanMode) while it is actually pending — `tool_use`
  and `tool_result` always arrive in the same write. Any "waiting for you"
  state derived from the transcript is structurally unreachable.
- **`status` has more values than `busy`/`idle`.** Watching
  `~/.claude/sessions/<pid>.json` across the same window (CC 2.1.235):

```
+0.0s    busy      transcript=3676676
+21.3s   waiting   transcript=3676676   ← question on screen, transcript frozen
+413.4s  shell     transcript=3680938   ← user interrupts and types
+532.1s  busy      transcript=3683984
```

  `waiting` is the CLI's own parked-on-the-user signal and is live — note the
  frozen transcript beside it. This is the only usable source for "the CLI
  needs you"; `liveSessions()` now reports it (DECISIONS.md 2026-08-26).
  Unverified: whether `waiting` also covers permission prompts (harmless
  either way — both mean the CLI needs the user), and what `shell` marks
  exactly (treated as not-live).

## Addendum 2026-08-26 — plan mode drafts the plan to disk before approval

Newer CC plan modes instruct the model to build its plan incrementally in
`~/.claude/plans/<slug>.md` (observed: `plan-mode-claude-bubbly-creek.md`)
via the ordinary `Write` tool, then call `ExitPlanMode` with no plan payload
of its own ("it will read the plan from the file you wrote").

- `Write` is non-blocking → returns in milliseconds → per the batching rule
  above, its transcript line **flushes immediately**, while the plan is still
  pending. Verified in transcript `72a69875-….jsonl` (this project): the
  `tool_use[Write]` carrying the full plan markdown in `input.content` was on
  disk minutes before the `ExitPlanMode` use/result pair landed.
- **Consequence**: the "pending plan is structurally unreachable" rule has a
  side door — the plan *content* (not the approval state) is visible early by
  recognizing Writes into `~/.claude/plans/`. The viewer promotes those to a
  draft plan card (DECISIONS.md 2026-08-26).
- Unverified: which CC versions do this (older ones pass the plan only in
  `ExitPlanMode.input.plan`), and whether follow-up revisions use `Edit`
  (deltas — not promotable to a full-text card). Both degrade safely: no
  matching Write → no draft card, everything else unchanged.
