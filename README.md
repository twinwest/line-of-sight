# Line of Sight

A local viewer for your coding-agent sessions. `sight claude` runs Claude Code exactly as before and opens the live transcript on localhost, where you can read it, copy from it, search across every session you've run, and select any text to ask about it.

<!-- TODO: 30s GIF — select-to-ask, then the same viewer on a codex session -->
![demo](docs/demo.gif)

## What it adds to the terminal

- **A readable, live transcript.** Finished turns fold their tool calls and narration away; conclusions stay visible.
- **Clean copy.** Any message, as Markdown, one click.
- **Select any text and ask.** A side chat about that exact passage, answered by a separate read-only invocation of your own agent CLI that reads the transcript and the repo. The working agent's context stays untouched, and the answer is kept.
- **Search across sessions.** Full-text, over everything you and the agent said, in any language.
- **A session list.** Every session by project, with what is running right now.

Works with Claude Code and Codex CLI. Subagent transcripts show up as child sessions of the turn that launched them.

## Install

Requires Node 20+ and `claude` and/or `codex` on your PATH.

```sh
npm install -g line-of-sight
sight claude        # instead of: claude
sight codex         # instead of: codex
sight open          # the viewer, at http://localhost:4989
```

`sight claude` passes every argument through untouched. If the viewer or its daemon is broken, the agent still runs. Line of Sight is never in the critical path.

## What it promises

- **Read-only.** It never writes to your repo and never touches the agent's state. The ask feature spawns your agent CLI with read-only tools only. There is no setting that changes this.
- **Local.** Transcripts are read in place from the files your CLI already writes. Questions and answers live in `~/.sight/sight.db`. No telemetry. The daemon makes no network calls; the only outbound traffic is the ask feature going through your own agent CLI. Every spawn and fetch site is in a handful of files, so you can check.
- **Zero push.** It never pops up, notifies, or interrupts. You open it.

## What it is not

Not a mission-control dashboard, not a cost tracker, not a multi-agent orchestrator, not a cloud service, not an IDE plugin. Those exist elsewhere. This is the thing you look at when you have to sign off on what the agent did.

## Configuration

`~/.sight/config.json`: `responder` (`claude-cli` or `codex-cli`), `responderModel`, `responderEffort`. The ask panel can set the same values. `SIGHT_PORT` overrides the port.

## Status

Built and used daily by one person for their own Claude Code and Codex sessions. Transcript formats are undocumented and change between CLI versions; an entry the parser doesn't recognize renders raw instead of breaking ingestion. Issues welcome, especially a transcript line that renders wrong: `sight inspect <file.jsonl>` shows how it was parsed.

## License

MIT. Made by [Ray](https://github.com/twinwest) at twinwest.
