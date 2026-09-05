# Line of Sight

Read your Claude Code and Codex sessions in a local web viewer.
Select text and ask about it right in the viewer. A separate, read-only agent
answers without adding to your main agent's conversation.

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

Your agent runs in the same terminal, with all arguments passed through,
even if the viewer fails to start.

Sight opens <http://127.0.0.1:2020> when no viewer tab is detected. Open a session in the viewer, select text, and click **Ask**.

Prefer your usual commands? Start the viewer:

```sh
sight open
```

Then use `claude` or `codex` as usual. While Sight's background service is
running, new sessions appear automatically. Existing sessions are available too.

## Understand what your agent did

Coding agents make code easier to produce. Engineers still need to understand
the changes they sign off on. Sight helps you follow the work, question the
decisions, and revisit the context without polluting the main agent context.

- **Ask.** Get answers grounded in the session transcript and project files.
  Follow up in a saved side chat anchored to the selected message.
- **Search.** Find conversation text across sessions.
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

Codex Ask uses Codex's own model and effort configuration.
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
