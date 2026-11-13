# Line of Sight feature map

Behavior-level inventory of what a user can do in Line of Sight, and how to
prove each part with `sight-verify.mjs`. Read the file for the feature a
change touches. For a broad regression, `node tools/verify/sight-verify.mjs walk`
runs every drive script below in order; the CLI file is shell commands and
is run by hand.

## Baseline preconditions

- `npm run build`, then `launch`, then a clean `doctor` (see `../README.md`).
- Every snippet is a `drive` script: pipe it to
  `node tools/verify/sight-verify.mjs drive`.
- Each `drive` run is a fresh browser with empty localStorage.
- Snippets that append to a seeded transcript change the instance for later
  runs. Every script must still pass on such an instance (`walk` twice in a
  row is the check); `cleanup` and `launch` restore the seeds.

## Features

- [session-list](session-list.md): home page: rows, status dot, project
  filter, in-session "Sessions" popover.
- [transcript-viewer](transcript-viewer.md): reading one session: header,
  step folding, tool rows, raw fallback, Copy Markdown, reply draft card.
- [live-tail](live-tail.md): new transcript lines appear in an open session
  without a reload.
- [search](search.md): global search box, grouped hits, jump to the message.
- [side-chat](side-chat.md): select text, Ask button, side panel, margin
  marker. Asking a question is opt-in (it spends the user's tokens).
- [cli](cli.md): `sight status`, `stats`, `inspect`, `start`, `stop` against
  the isolated instance.

## Not reachable from the seeds

Name these as unverified instead of faking them:

- Status `running`, `waiting` and `no update`. They come from the agent
  CLI's own process records, which the fake HOME does not have. Seeded
  sessions only show `idle` and `just finished`.
- Subagent transcripts, archived and `.zst` Codex rollouts. No seed carries
  them; add one to `SEEDS` in `sight-verify.mjs` when a change needs it.
- `sight claude`, `sight codex` and `sight open`. They start the real agent
  or open a tab in the user's own browser.
