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
