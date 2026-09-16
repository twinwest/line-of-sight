# Security

Line of Sight reads your agent transcripts, which can contain source code,
credentials, and internal context. Security reports are taken seriously.

## Reporting a vulnerability

Report privately through GitHub:
[Report a vulnerability](https://github.com/twinwest/line-of-sight/security/advisories/new).
Please do not open a public issue.

Include the output of `sight version`, your Claude Code or Codex CLI version,
your macOS version, and steps to reproduce. Fixes ship in the latest npm
release only.

## What Sight does to protect you

- **Loopback only.** The viewer server listens on `127.0.0.1`.
- **No cross-site access.** Requests whose `Host` is not a loopback name are
  refused, which blocks DNS rebinding. Non-GET requests with a foreign
  `Origin` are refused.
- **No remote loads from rendered content.** Transcripts and answers are
  untrusted. A Content Security Policy stops them from loading remote images.
- **Read-only responder.** Claude Code runs with only `Read`, `Grep`, and
  `Glob`; write, shell, subagent, and web tools are blocked, and `--restricted`
  makes those read tools refuse any path outside the project and the
  session's transcript directory. Codex runs with `--sandbox read-only`,
  which blocks writes and network.
- **No telemetry.** The only network traffic is your own agent CLI talking to
  its model service when you ask a question.

## In scope

- A web page or other origin reading data from Sight or triggering actions.
- Transcript content that makes the viewer run script or load remote
  resources.
- Anything that lets the responder write files, run commands, or send data
  anywhere other than your agent CLI's model service.
- Sight writing to your repository or changing agent state.

## Known limitations

- **The Codex responder can read any file your user can read.** Codex's
  read-only sandbox limits writes and network, not reads, and offers no way
  to confine them. A transcript containing a prompt injection could steer it
  to read a file outside the project and quote it in an answer. That answer
  goes to your model service, as your agent's own traffic does, and is shown
  in your local viewer; with network closed inside the sandbox, that is the
  only exit. The Claude Code responder is confined (see above).
- **Local processes running as you are out of scope.** They can already read
  `~/.claude`, `~/.codex`, and `~/.sight` directly.
- **Agent CLIs and model services.** Report issues in Claude Code, Codex
  CLI, or their services to their vendors.
