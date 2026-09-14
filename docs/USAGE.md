# Usage guide

[Back to README](../README.md)

## Starting the viewer

Run `sight claude` or `sight codex` to start Sight alongside your agent.
All arguments are passed through to the CLI. The wrapper waits up to one
second for viewer startup, then launches your agent even if the viewer is
unavailable. Sight opens <http://127.0.0.1:2020> when no viewer tab is detected.

To use `claude` or `codex` directly, run `sight open` once. Existing and new
sessions appear automatically while Sight is running.

## Archived and compressed Codex sessions

Sight discovers active and archived Codex rollouts, including `.jsonl.zst`,
without restoring or modifying agent files. Codex Ask reads compressed
content through Sight's bundled Node helper. No system `zstd` command is
required. Install with optional dependencies enabled for compressed support;
a missing decoder or corrupt/unsupported file shows a passive explanation
and prevents Ask from treating incomplete evidence as the full session.
The decoder accepts history windows and individual JSONL records up to
8 MiB; larger inputs show an explicit error. Total session size may be larger.

## Browsing subagents

Browse Claude Code subagent transcripts from their parent session. Expand
its tool steps to open a linked transcript, or use the **Subagents** menu
in the session header.

## Configuration

Ask uses the session's own CLI: Claude Code for Claude sessions, Codex for
Codex sessions. If it is unavailable, the panel tells you which CLI to install;
there is no cross-engine fallback. Settings live in `~/.sight/config.json`.

| Setting | Effect |
| --- | --- |
| `responderModel` | Claude Ask model; also selectable in the Ask panel. |
| `responderEffort` | Claude Ask effort; also selectable in the Ask panel. |
| `codexResponderModel` | Codex Ask model; defaults to `gpt-5.6-terra`. |
| `codexResponderEffort` | Codex Ask effort; defaults to `medium`. |
| `keepSideChats` | `true` keeps side chats after their transcript is gone (default: off, they go with the session). |

Codex Ask model and effort are selectable in the Ask panel and stay separate
from the active Codex session and Claude Ask settings. A change applies to the
next question.
Set `SIGHT_PORT` to use a different port, for example `SIGHT_PORT=5121 sight open`.

## Your side chats

Every question you ask is saved with its answers and a snapshot of the
conversation around the selected text, taken when you asked. Follow-ups in
the same side chat are answered against that same snapshot.

By default a side chat is removed when its transcript leaves the disk.
Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default,
in `~/.claude/settings.json`). Set `keepSideChats` to `true` to keep them;
they will not appear in the viewer once the session is gone, but the data
is yours to read:

```sh
sqlite3 -readonly ~/.sight/sight.db \
  "select anchor_text, turns_json, excerpt_json from side_chats"
```

`turns_json` is the questions and answers; `excerpt_json` is the snapshot
(`rows[]` of `{role, ts, text}` plus the session's path and title). Turning
the setting off again clears the kept side chats on the next start.

## Help

`sight status` checks the background service; `sight stop` stops it.
`sight open`, `sight start`, or either wrapper starts it again.
See `sight --help` for all commands and `~/.sight/daemon.log` for startup errors.

Transcript formats change between CLI versions; unrecognized entries fall
back to raw JSON. If something renders incorrectly,
[open an issue](https://github.com/twinwest/line-of-sight/issues) with your
CLI version and the summary from `sight inspect <transcript.jsonl>`.
Review the output for private information before sharing it.

