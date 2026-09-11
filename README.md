# Line of Sight

A local web companion for Claude Code CLI and Codex CLI.
Browse live and past sessions from both tools, search across conversations,
and ask questions in a separate, read-only side chat.
Your main conversation stays unchanged.

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

Sight runs in the background while your agent stays in the terminal.
In the viewer at <http://127.0.0.1:2020>, choose a session, select text,
and click **Ask**.

To keep using `claude` or `codex` directly, start the viewer once:

```sh
sight open
```

Existing and new sessions appear automatically while Sight is running.

## Read, search, and ask

- **Browse.** Follow live sessions or revisit past conversations from
  Claude Code and Codex in one place.
- **Search.** Find conversation text across sessions from both CLIs.
- **Ask.** Select text and get answers grounded in the session and project
  files. Follow up in a saved side chat anchored to the selected message.
- **Copy.** Copy messages as Markdown or code blocks as plain code.

## Privacy and behavior

- **Read-only questions.** Sight cannot edit your project or send replies to
  the working agent. Claude Code uses restricted tools; Codex uses a
  read-only sandbox.
- **Local storage.** The viewer listens only on `127.0.0.1`. Transcripts are
  read from disk; indexed content and saved Q&A live in `~/.sight`.
  There is no telemetry.
- **Model access.** Sight uses your CLI's authentication and model service.
  Questions, transcript context, and project content read by the responder
  are sent to that service, using your account's quota or billing.
- **Retention.** Sight mirrors the transcripts on disk. If a transcript is
  deleted, its session and saved side chats are removed from Sight too.

## Help

See the [usage guide](docs/USAGE.md) for configuration and troubleshooting,
or run `sight --help` for all commands.

## License

[MIT](LICENSE)
