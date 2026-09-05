# Line of Sight — contributor guide

Line of Sight is a local-first, agent-agnostic companion viewer for coding-agent
CLI sessions (Claude Code, Codex CLI). Read `docs/ARCHITECTURE.md` first.
`docs/SPIKE_NOTES.md` documents the undocumented transcript formats the adapters
parse; `docs/SPEC.md` is what v1 is and, just as important, is not.

## Hard rules (product promises — a change that breaks one is a bug)

- **Fail-open, never in the critical path.** `sight claude` must behave exactly
  like bare `claude` even if every other part of Line of Sight is broken.
  Daemon errors never block or delay the wrapped agent.
- **Never write to the user's repo or mutate agent state.** The Q&A responder
  gets read-only tools only. No write tools, no toggle.
- **All user data stays local.** No network calls except the responder
  invocations, which go through the user's own agent CLI. No telemetry.
- **Zero push.** The UI never interrupts, pops up, or prompts on its own.
- **Mirror the disk, don't archive it.** A session whose transcript is gone
  leaves Sight, side chats included. No soft delete, no retention of our own.
- **Parse transcripts defensively.** Schemas are undocumented and change between
  CLI versions. Unknown entry types render as a raw fallback, never crash
  ingestion.

## Working style

- TypeScript strict mode. `npm run typecheck && npm run test` must pass before
  a change is done.
- Keep it lean: no speculative abstractions beyond `Adapter` and `Responder`.
  Deferred features (SPEC §6) are not scaffolded "for later".
- A fix in one adapter must not change another adapter's behaviour. If it has
  to, say so in the PR.
