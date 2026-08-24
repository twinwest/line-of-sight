# Line of Sight — Implementation Session Guide

You are implementing **Line of Sight**: a local-first, agent-agnostic companion viewer
for coding-agent CLI sessions (Claude Code first, Codex CLI next). The full
product rationale, scope, and technical design are already decided. 

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
- **Decision log.** You have latitude on implementation details (anything the
  docs don't pin down, or mark as "implementer's choice"). Record every
  non-obvious decision in `docs/DECISIONS.md` (create it) **at the moment you
  make it**, not retroactively. One entry each: date, milestone, what you
  decided, why, and a tag — `[choice]` for decisions within your latitude,
  `[deviation]` for anything that changes what SPEC/ARCHITECTURE/PLAN
  prescribe. For a `[deviation]`, also update the affected doc in the same
  commit. The hard rules above and SPEC §6 (the cut list) are not deviatable —
  if one seems wrong, stop and leave a question in DECISIONS.md instead of
  proceeding. The owner reviews this file at the end.
- Commit at least at every milestone boundary (smaller commits welcome), so
  the decision log and git history line up for review.
- M0 spike findings go into `docs/SPIKE_NOTES.md` (create it). Later milestones
  depend on those findings; if a spike contradicts an assumption in the docs,
  update the doc and note the change.
- TypeScript strict mode everywhere. `npm run typecheck && npm run test` must
  pass before a milestone is called done.
- Keep it lean: no speculative abstractions beyond the interfaces the docs
  explicitly define (`Adapter`, `Responder`). Deferred features (see SPEC §6)
  must not leak into v1 code.
