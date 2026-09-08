# Usage guide

[Back to README](../README.md)

## Starting the viewer

Run `sight claude` or `sight codex` to start Sight alongside your agent.
All arguments are passed through to the CLI. The wrapper waits up to one
second for viewer startup, then launches your agent even if the viewer is
unavailable. Sight opens <http://127.0.0.1:2020> when no viewer tab is detected.

To use `claude` or `codex` directly, run `sight open` once. Existing and new
sessions appear automatically while Sight is running.

## Browsing subagents

Browse Claude Code subagent transcripts from their parent session. Expand
its tool steps to open a linked transcript, or use the **Subagents** menu
in the session header.

## Configuration

Ask defaults to the session's CLI, falling back to the other installed CLI
if unavailable. No Sight configuration is required.

Optional settings in `~/.sight/config.json`:

| Setting | Effect |
| --- | --- |
| `responder` | Pin Ask to `claude-cli` or `codex-cli`, with no fallback. |
| `responderModel` | Claude Ask model; also selectable in the Ask panel. |
| `responderEffort` | Claude Ask effort; also selectable in the Ask panel. |
| `codexResponderModel` | Codex Ask model; defaults to `gpt-5.6-terra`. |
| `codexResponderEffort` | Codex Ask effort; defaults to `medium`. |

Codex Ask model and effort are selectable in the Ask panel and stay separate
from the active Codex session and Claude Ask settings. A change applies to the
next question.
Set `SIGHT_PORT` to use a different port, for example `SIGHT_PORT=5121 sight open`.

## Help

`sight status` checks the background service; `sight stop` stops it.
`sight open`, `sight start`, or either wrapper starts it again.
See `sight --help` for all commands and `~/.sight/daemon.log` for startup errors.

Transcript formats change between CLI versions; unrecognized entries fall
back to raw JSON. If something renders incorrectly,
[open an issue](https://github.com/twinwest/line-of-sight/issues) with your
CLI version and the summary from `sight inspect <transcript.jsonl>`.
Review the output for private information before sharing it.

