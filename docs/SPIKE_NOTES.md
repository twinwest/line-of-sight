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
- Content lives alongside the transcript: `<session-uuid>/subagents/agent-*.jsonl`
  (+ `.meta.json`) for subagent transcripts, and `memory/*.md` dirs. Top-level
  lines never had `isSidechain: true` (only `false` or absent) — sidechains
  live in the subagents dir instead.
  v1 ignored them; **2026-08-26 they are ingested as child sessions** —
  see the subagent addendum at the end of this file.
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
  *(Superseded for CLI ≥ 2.1.250 — see Addendum 2026-08-28: the pending
  `tool_use` now flushes before its result.)*
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

## Addendum 2026-08-26 — subagent transcripts (measured before implementing)

Surveyed all 25 `subagents/agent-*.jsonl` on this machine (7 parent sessions).

- **Layout is flat.** Every subagent file sits directly in
  `<session-uuid>/subagents/`, including runs spawned by another subagent.
  Every observed `meta.json` had `spawnDepth: 1`; no nested `subagents/` dir
  exists. ⇒ `parent_id` from the path always names the *top-level* session,
  never an intermediate agent.
- **`meta.json` is written first** (at spawn), before the transcript's first
  line — so reading it in `sessionMeta()` is safe. Shape:
  `{agentType, description, toolUseId, spawnDepth}`.
- **Line schema is the parent's.** Types observed across all 25 files:
  `assistant`, `user`, `attachment`, and `fork-context-ref` (1 line, 1 file).
  The last is the header of a context-forked subagent —
  `{agentId, parentSessionId, parentLastUuid, contextLength}`, a pointer with
  no content, so it joins `DROP_TYPES`. No other new type; `parseLine` needed
  no change.
- **`toolUseId` links to a Task row only 5 times in 25.** The other 20 are
  parallel/async Task batches where the CLI wrote the `tool_result` but never
  an `assistant` `tool_use` block with that id — the id appears *only* on the
  result. (Checked sibling transcripts too: 0 matches there, so it is not a
  nesting artifact.) ⇒ the viewer must anchor the link on the orphan
  `tool_result` as well as on the `tool_use` fold, or 80% of real subagents
  get no in-transcript entry point.
- **No liveness signal.** Subagents get no `~/.claude/sessions/<pid>.json`
  (that file is per CLI process), so `liveSessions()` can never mark one.

## Addendum 2026-08-27 — Codex spike (codex-cli 0.150.1; supersedes S3's "not installed")

Measured on 4 real sessions (1 interactive from the owner, 3 generated via
`codex exec` in a scratchpad — multi-turn coding, file edits, a mid-turn
SIGKILL, an `exec resume`). Fixtures: `test/fixtures/codex/entries.jsonl`
(14 representative redacted lines, one per type/subtype/role).

**Layout & identity**
- `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. Session id =
  filename uuid = `session_meta.payload.id` (verified equal) — uuid form, so
  the global-id contract from ARCHITECTURE §4 is satisfied as-is.
- Line envelope `{timestamp, ordinal, type, payload}`; `ordinal` strictly
  increasing across the whole file (survives resume).
- Rollout file is created ~0.4s after spawn and **appended incrementally
  while the turn runs** (writes observed every ~1s) — no Claude-style
  batch-at-message-end. SIGKILL mid-turn leaves a clean file: complete
  lines, trailing newline, zero malformed JSON, just no `task_complete`.
- `codex exec resume --last` **appends to the same rollout file**: still one
  `session_meta`, one new `turn_context` per turn. Append-only checkpoint
  ingestion works unchanged.
- The `~/.codex/*.sqlite` files (`thread_history_1` etc.) are a pagination
  INDEX over the rollout (`rollout_byte_offset` columns) — the jsonl remains
  the source of truth. `codex migrate-rollouts` exists ("migrate legacy
  local sessions to paginated thread history"): watch future versions for
  the jsonl being demoted.
- `session_meta.payload` carries `cwd` (projectDir source; also on every
  `turn_context`), plus provenance: `source: 'cli'|'exec'`, `originator:
  'codex-tui'|'codex_exec'` — sessions self-identify, which the adapter can
  use to badge or filter exec runs.
- Title: `~/.codex/session_index.jsonl` holds `{id, thread_name,
  updated_at}` — the ai-title analog, multiple entries per session,
  last-wins. Exec sessions get no entry → fall back to first user prompt.

**Line census** (233 lines across the 4 files)
- `session_meta`(4) · `event_msg`(116: item_completed 74, token_count 29,
  task_started 6, task_complete 5, thread_settings_applied 2) ·
  `response_item`(103: message 29, reasoning 26, custom_tool_call 24,
  custom_tool_call_output 24) · `world_state`(4) · `turn_context`(6).
- `response_item/message`: `role` user|assistant|developer; `content` is an
  array of `{type: 'input_text'|'output_text', text}`. User lines include
  `<environment_context>`/`<user_instructions>` pseudo-XML plumbing —
  '<'-prefixed, coincidentally the same convention Claude uses.
- `reasoning` is **encrypted** (`encrypted_content`; `summary` usually
  empty) — codex thinking is not renderable. Render a marker, or the
  summary when non-empty.
- `custom_tool_call`: `name` is always `exec` (the input is a JS-ish script
  calling `tools.exec_command(...)`, with apply_patch embedded as
  `*** Begin Patch` text inside it); paired with
  `custom_tool_call_output` by `call_id` — maps 1:1 onto the existing
  tool_use/tool_result RenderBlocks.
- `event_msg/item_completed` echoes response_items — 41/74 matched a
  `response_item.id` in-file; **33 did not**. Before the adapter blind-drops
  event_msg as redundant, check what the unmatched ones carry.

**Liveness**
- `~/.codex/thread-writer-locks/<uuid>.lock` is **flock-held by the live
  codex process** (verified with lsof during a live turn; the rollout fd is
  held open too). The file persists after exit, so existence ≠ live — the
  *hold* is the signal. `liveSessions()` can try a non-blocking flock per
  lock file; kernel releases flocks on process death, so unlike Claude's
  `status: busy` file this can never go stale — no STALE_BUSY_MS needed for
  codex. No busy/waiting distinction observed (see open questions).

**Interaction analogs**
- Plan mode exists: `turn_context.collaboration_mode.mode:
  'default'|'Plan'`, and a `request_user_input` tool (per-turn
  availability) is the AskUserQuestion analog. Transcript shapes unmeasured
  — needs a real interactive session driving them.
- `codex queue --thread <uuid> --message <text>` is the input-queue analog;
  it presumably rides `queue_1.sqlite`, not the rollout — unmeasured.

**Responder (S3 completed)**
- `codex exec --sandbox read-only --ephemeral "<prompt>"` verified: asked to
  create a file → replied BLOCKED, file not created; reads worked;
  **`--ephemeral` wrote no rollout** — it is the `--no-session-persistence`
  analog, and without it `codex exec` DOES pollute `~/.codex/sessions` (the
  M5 dogfood lesson repeats). Also available: `--json` (JSONL events on
  stdout — streaming, shape unverified), `-C <dir>` (workdir),
  `--skip-git-repo-check`, `--ignore-user-config` (the `--setting-sources
  ""` analog), `-o <file>` (last message). Caveat observed: exec runs
  auto-append a `[projects."<cwd>"] trust_level = "trusted"` entry to the
  user's config.toml.

**Open questions for the adapter/dialect task**
- What the 33 unmatched `item_completed` payloads carry.
- `request_user_input` / Plan-mode transcript shapes (drive a TUI session).
- Queue delivery path; typing-while-busy behavior in the TUI.
- `--json` stream event shapes for the responder.

## Addendum 2026-08-27 (later) — interactive TUI session: request_user_input + plan mode measured

The owner drove a real codex-tui session (resuming the morning thread) and
parked it on a question; observed live. Two of the four open questions above
are now answered:

- **`request_user_input` is a `function_call`** (not custom_tool_call),
  paired by `call_id` with a `function_call_output`. `arguments` is a JSON
  **string**: `{questions: [{header, id, question, options: [{label,
  description}]}]}` — strikingly close to Claude's AskUserQuestion (same
  header/question/options/label/description vocabulary!) but with a per-
  question `id`, and no `multiSelect`/`preview`. The answer is structured,
  not prose: `output` = `{"answers": {"<question-id>": {"answers":
  ["<label>"]}}}` (list-valued → multi-select capable). A codex dialect can
  render the same AskCard data shape; only the two parsers differ.
- **Pending questions ARE visible in the transcript**: the `function_call`
  line flushed to disk while the session sat parked on it (verified live —
  the file ended on a call with no output line). Codex does NOT have
  Claude's write-batching limitation, so a pendingBlockId-style "waiting
  for you" derivation genuinely works for codex — no liveness-file
  dependency needed for that state.
- Plan mode in practice: `turn_context.collaboration_mode.mode: 'plan'`,
  then ordinary assistant messages + request_user_input dialogs + read-only
  exec calls. No dedicated plan-document artifact type observed so far (no
  ExitPlanMode analog in the data yet); the plan conversation is plain
  messages.
- Liveness re-verified on the TUI: flock on the lock file held by the live
  `codex` process (pid observed via lsof), exactly as with exec.

Still open: the 33 unmatched item_completed payloads; queue delivery path;
`--json` stream shapes.

## Addendum 2026-08-28 — issue #5 verified: `sessions/<pid>.json` is alive on 2.1.250; the 2.1.247 probe was self-contaminated

Re-ran the issue #5 experiment against a real interactive CLI (prompt typed
keystroke-by-keystroke into the TUI via expect, no CLI-argument prompt).
The CLI auto-updated 2.1.247 → 2.1.250 during the first run; all clean
findings below are 2.1.250.

**The original probe contaminated itself.** Launching `claude` from inside a
Claude Code session (which is where the issue's expect probe ran — and where
this one initially ran too) hands the child `CLAUDE_CODE_CHILD_SESSION=1`.
On ≥ 2.1.247 the TUI then shows *"Transcript saving is off — inherited
CLAUDE_CODE_CHILD_SESSION marker"* and writes **neither transcript nor
`sessions/<pid>.json`**. That alone reproduces issue #5's findings 3/4
(no `<pid>.json`, no transcript flush, nothing on SIGKILL). Probes must
scrub `CLAUDE_CODE_CHILD_SESSION` (we also scrubbed `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_EXECPATH`, `AI_AGENT`, `CLAUDE_EFFORT`).

**Clean-environment findings (2.1.250, interactive, typed input):**

- `~/.claude/sessions/<pid>.json` is written at startup, before any prompt,
  and deleted on graceful exit. Schema grew (`kind: "interactive"`,
  `peerProtocol`/`peerFeatures`, `messagingSocketPath`, `name`/`nameSource`,
  `bridgeSessionId`) but every field `liveSessions()` reads — `sessionId`,
  `pid`, `procStart`, `status`, `statusUpdatedAt` — is unchanged.
  **No adapter change needed; the waiting banner is not threatened.**
- `status` transitions observed live: idle → busy → **waiting** (parked on
  an AskUserQuestion) → busy → idle. Same vocabulary as 2.1.235.
- The transcript flushes per message in near-real-time, as before.
- **Write batching changed since 2.1.235** (supersedes the 2026-08-26
  addendum's "structurally unreachable" conclusion for ≥ 2.1.250): the
  pending `AskUserQuestion` `tool_use` line hit the disk ~3s **before** its
  `tool_result`, and was observed on disk in the same second as
  `status: waiting`. There is now an on-disk pending-question side door —
  the same tail-derivation that works for codex's `request_user_input`
  (2026-08-27 addendum) would work for Claude Code too. Display work is
  deliberately NOT built here; recorded on issues #3/#5.
- New (to us) transcript line types seen: `bridge-session`, `atis-latch`,
  `cost-state`, `ai-title`. All flow through the raw fallback; ingestion
  unaffected.

**Probe methodology gotchas (for the next person driving a TUI):**

- An expect script must keep *reading* the pty. Sleep-based waits wedge the
  CLI once the 16KB pty buffer fills: blank TUI, frozen event loop,
  half-written session json — indistinguishable from a startup hang. Drain
  with `expect -timeout N <never-match>` instead of `sleep N`.
- Marker words must not appear whole in the typed prompt; the TUI echo
  false-positives any `expect` match (use split halves, e.g. ZEB + RAFISH,
  and match only the model-rendered concatenation).
- SIGKILLed probes leave stale `sessions/<pid>.json`/`.key` and
  `/tmp/cc-socks/*.sock` behind; `liveSessions()`'s pid + procStart
  verification already filters these (observed doing its job).
