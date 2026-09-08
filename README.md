# Line of Sight

Read your Claude Code and Codex sessions in a local web viewer.
Ask questions in a separate viewer while keeping your Claude Code or Codex
terminal available.
A separate, read-only agent answers without changing the main conversation.

![Line of Sight: reading a session and asking about selected text](docs/demo.gif)

## Quick start

Requires **macOS, Node.js 20+**, and `claude` or `codex` on your PATH.
Set up and authenticate the CLI you want to use first. Linux is untested.

```sh
npm i -g line-of-sight
sight claude    # use in place of claude
# or
sight codex     # use in place of codex
```

Sight runs in the background; Claude or Codex stays in your terminal with
all arguments passed through. The wrapper waits up to one second for viewer
startup, then launches your agent even if the viewer is unavailable.

Sight opens <http://127.0.0.1:2020> when no viewer tab is detected.
Choose a session, select text, and click **Ask**.

To keep using `claude` or `codex` directly, start the viewer once:

```sh
sight open
```

Existing and new sessions appear automatically while Sight is running.

## Understand what your agent did

Follow the work, question decisions, and revisit context before signing off.

- **Ask.** Get answers grounded in the session transcript and project files.
  Follow up in a saved side chat anchored to the selected message.
- **Search.** Find conversation text across Claude Code and Codex sessions.
- **Copy.** Copy messages as Markdown or code blocks as plain code.
- **Read.** Follow live updates with dialogue visible and tool steps folded
  away. Expand steps for details; browse Claude Code subagent transcripts
  from the parent session.

## Privacy and behavior

- **Read-only questions.** Ask cannot edit your project or send replies to
  the working agent. Claude Code uses restricted tools; Codex uses a
  read-only sandbox.
- **Local storage.** The viewer listens only on `127.0.0.1`. Transcripts are
  read from disk; indexed content and saved Q&A live in `~/.sight`.
  There is no telemetry.
- **Model access.** Ask uses your CLI's authentication and model service.
  Questions, transcript context, and project content read by the responder
  are sent to that service, using your account's quota or billing.
- **Retention.** Sight mirrors the transcripts on disk. If a transcript is
  deleted, its session and saved side chats are removed from Sight too.

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

## License

[MIT](LICENSE)
