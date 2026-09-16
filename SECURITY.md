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
- **Responder safeguards.** Claude Code runs with only `Read`, `Grep`, and
  `Glob`; write, shell, subagent, and web tools are blocked, and `--restricted`
  makes those read tools refuse any path outside the project and the
  session's transcript directory. Codex runs model-generated commands under
  `--sandbox read-only`; commands that stay inside that sandbox cannot write
  files or use command-level network access. See the Codex limitations below.
- **No telemetry.** Sight itself makes no telemetry or application network
  requests. When you ask a question, it launches your own agent CLI; that CLI
  talks to its model service and may use capabilities enabled in its own
  configuration.

## In scope

- A web page or other origin reading data from Sight or triggering actions.
- Transcript content that makes the viewer run script or load remote
  resources.
- Anything that lets the responder write files, execute commands outside its
  intended read-only boundary, or send data through an undeclared channel.
- Sight writing to your repository or changing agent state.

## Known limitations

- **The Codex responder currently has broad read access.** Sight uses Codex's
   `--sandbox read-only` mode, so model-generated commands can read any
  file available to the Codex process, including files outside the project.
  The Claude Code responder is confined (see above).
- **Codex configuration is inherited.** The Codex responder may load user and
  trusted-project configuration. Configured web search, apps, MCP servers,
  hooks, or approval behavior are separate capability surfaces and are not
  confined by `--sandbox read-only`, which applies to model-generated
  commands. Only use Codex Ask with configuration you trust.
- **Local processes running as you are out of scope.** They can already read
  `~/.claude`, `~/.codex`, and `~/.sight` directly.
- **Agent CLIs and model services.** Report issues in Claude Code, Codex
  CLI, or their services to their vendors.
