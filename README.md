# Line of Sight

**Stay oriented while coding agents work.**

Line of Sight is a local, read-only companion for Claude Code and Codex CLI.
Follow live and past sessions, search across conversations, and ask questions
about any step—without touching the agent's working session.

![Line of Sight: reading a session and asking about selected text](docs/demo.gif)

## Quick start

Requires **macOS, Node.js 20+**, and `claude` or `codex` on your PATH.
Set up and authenticate the CLI you want to use first. Linux is untested.

```sh
npm i -g line-of-sight
sight open
```

Sight runs in the background and shows every Claude Code and Codex session,
past and live, at <http://127.0.0.1:2020>. Choose a session, select text, and
click **Ask**. Run `sight open` again after a restart.

To start Sight automatically with your agent, launch the agent through it:

```sh
sight claude    # or: sight codex
```

## Understand the work

- **Follow.** Read live sessions as they unfold, or return to past work
  without digging through terminal output.
- **Inspect.** See the conversation, tool calls, results, and subagent work
  in one readable view.
- **Ask.** Select any text and ask what happened, why the agent did it, or
  whether something deserves a closer look. Answers live in a separate,
  read-only side chat.
- **Search.** Find decisions and explanations across Claude Code and Codex
  sessions.
- **Copy.** Copy messages as Markdown or code blocks as plain code.

## Comprehension, not control

Line of Sight is not a control plane or mission-control dashboard for agents.
It does not orchestrate their work, send them commands, or reduce a session
to a completion status. It gives you a readable view of what happened and a
separate place to question it, while the working conversation stays untouched.

## Privacy and behavior

- **Read-only questions.** Sight cannot edit your project or send replies to
  the working agent. Claude Code uses restricted tools; Codex uses a
  read-only sandbox.
- **Local storage.** The viewer listens only on `127.0.0.1`. Transcripts are
  read from disk; indexed content, saved Q&A and, per question, a snapshot
  of the conversation around it live in `~/.sight`. There is no telemetry.
- **Model access.** Sight uses your CLI's authentication and model service.
  Questions, transcript context, and project content read by the responder
  are sent to that service, using your account's quota or billing.
- **Retention.** Sight mirrors the transcripts on disk. If a transcript is
  deleted, its session and saved side chats are removed from Sight too.
  Claude Code deletes transcripts itself after `cleanupPeriodDays` (30 by
  default). To keep your questions, answers and their conversation
  snapshot after that, set `keepSideChats` — see the usage guide.

## Help

See the [usage guide](docs/USAGE.md) for configuration and troubleshooting,
or run `sight --help` for all commands.

## License

[MIT](LICENSE)
