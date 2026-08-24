# Line of Sight — Implementation Session Guide

You are implementing **Line of Sight**: a local-first, agent-agnostic companion viewer
for coding-agent CLI sessions (Claude Code first, Codex CLI next). The full
product rationale, scope, and technical design are already decided. **Do not
re-litigate decisions** — they are recorded in the docs below with their
reasoning.

## Read in this order (all in `docs/`)

1. `docs/SPEC.md` — what we are building and, equally important, what we are NOT building
2. `docs/ARCHITECTURE.md` — components, data model, interfaces, tech stack (all decided)
3. `docs/PLAN.md` — ordered milestones M0–M5 with acceptance criteria. **Start with M0 (spikes).**

## Hard rules (from the product's design principles — violating these breaks the product)

- **Fail-open, never in the critical path.** The `sight claude` wrapper must
  behave exactly like bare `claude` even if every other part of Line of Sight is
  broken. Daemon errors must never block or delay the wrapped agent.
- **Line of Sight never writes to the user's repo or mutates any agent state.** The
  Q&A responder gets read-only tools only. No write tools, no toggle.
- **All user data stays local.** No network calls except the responder
  invocations (which go through the user's own agent CLI or their own API key).
- **Zero push.** The UI never interrupts, pops up, or prompts on its own.
- **Parse transcripts defensively.** Transcript schemas are undocumented and
  change between agent-CLI versions. Unknown entry types must render as a raw
  fallback, never crash ingestion.

## Working style

- Follow `docs/PLAN.md` milestone by milestone; each has acceptance criteria —
  verify them before moving on.
- M0 spike findings go into `docs/SPIKE_NOTES.md` (create it). Later milestones
  depend on those findings; if a spike contradicts an assumption in the docs,
  update the doc and note the change.
- TypeScript strict mode everywhere. `npm run typecheck && npm run test` must
  pass before a milestone is called done.
- Keep it lean: no speculative abstractions beyond the interfaces the docs
  explicitly define (`Adapter`, `Responder`). Deferred features (see SPEC §6)
  must not leak into v1 code.
