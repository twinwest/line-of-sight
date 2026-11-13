---
name: verify-sight
description: "Launch an isolated Line of Sight daemon and drive its web viewer (session list, transcript, search, live tail, side-chat panel) and the sight CLI the way a user does, capturing screenshots and state as proof. Use after changing anything under src/ or web/ to prove the behavior in the real app, or when asked to verify, screenshot, or demo the viewer."
---

# Verify Line of Sight

Proves behavior in the real app: a built daemon serving the built viewer,
driven through headless Chrome, against seeded transcripts. Unit tests
(`npm run test`) do not replace this, and this does not replace them.

Everything goes through one helper. Run it from the repo root:

```bash
node .claude/skills/verify-sight/sight-verify.mjs --help
```

It needs Node 20+, Google Chrome installed, and `npm install` done
(`playwright-core` is a devDependency; it downloads no browser).

## Isolation

The helper never touches the user's own Sight. It starts a second daemon with
`HOME` pointed at a scratch directory and `SIGHT_PORT=2121`, so `~/.sight`,
`~/.claude`, `~/.codex` and the daemon on port 2020 are out of reach.

Scratch dir: `$TMPDIR/sight-verify-2121/` (`home/`, `evidence/`, `state.json`).
`launch` prints the absolute paths. To run a second instance side by side, set
`SIGHT_VERIFY_PORT=<port>` on every command; the port also names the scratch dir.

Never drive `http://127.0.0.1:2020`. That is the user's live instance.

## Launch

```bash
npm run build
node .claude/skills/verify-sight/sight-verify.mjs launch
```

`launch` copies two fixtures into the fake HOME, starts
`dist/daemon/main.js` detached, and returns once `/api/sessions` lists both
seeded sessions. It prints `ready: http://127.0.0.1:2121`. A daemon that
answers `/api/health` but has not ingested the seeds is not ready.

Seeded sessions (available to drive scripts as `seeds`):

| Key | Title in the list | Source |
| --- | --- | --- |
| `seeds.claude` | `Deep dive` | `test/fixtures/claude-code/entries.jsonl` |
| `seeds.codex` | `help me better understand the structure…` | `test/fixtures/codex/entries.jsonl` |

Each has `.id` (the session id, so the page is `/s/<id>`) and `.file` (the
transcript copy inside the fake HOME, safe to append to).

Rebuild rules: after changing `web/`, `npm run build` is enough, because the
daemon serves `web/dist` from disk. After changing `src/`, rebuild, then
`cleanup` and `launch` again.

## Doctor

```bash
node .claude/skills/verify-sight/sight-verify.mjs doctor
```

Read-only. Run it before the first drive and whenever something looks off. It
checks that the daemon was launched by this helper, is alive, owns the port,
matches `package.json`'s version, runs a build newer than `src/` and
`web/src/`, and has ingested the seeds. Any `FAIL` line names the fix; exit
code is 1. A proof captured while doctor fails is not a proof.

## Drive

`drive` runs a Playwright script from stdin (or a file path) in a fresh
headless Chrome. Each run is a new browser: localStorage starts empty.

```bash
node .claude/skills/verify-sight/sight-verify.mjs drive <<'JS'
await page.goto('/');
await page.locator('.session-row', { hasText: 'Deep dive' }).click();
await page.locator('.event[data-mid]').first().waitFor();
await shot('transcript-open');
JS
```

In scope:

- `page`: a Playwright `Page`, `baseURL` set to the isolated instance, 1280×800,
  clipboard read/write granted.
- `shot(name)`: saves `evidence/<name>.png` and prints its path.
- `select(locator)`: selects a single-line element's text with a real mouse
  drag. Use it for select-to-ask; a scripted `Selection` fires no `mouseup`.
- `seeds`: see Launch.

The script is a Node async function body, so `await import('node:fs')` works.
Browser `console.error` and uncaught page errors are printed as
`[console.error]` / `[pageerror]`; treat any of them as a finding. When a
script throws, the helper saves `evidence/failure.png` first.

Selectors: the viewer has few ARIA labels or data attributes. Stable handles
are `.event[data-mid]` (one per message), visible text, `title` attributes
and placeholders. Class names are the fallback and are listed per feature
under [`features/`](features/). Wait on a locator, never on a fixed sleep.

The CLI goes through the same isolation:

```bash
node .claude/skills/verify-sight/sight-verify.mjs sight status
node .claude/skills/verify-sight/sight-verify.mjs sight stats
```

## Evidence

Evidence lives in `$TMPDIR/sight-verify-2121/evidence/` and survives
`cleanup`. Report the absolute paths `shot` printed.

A proof must meet all of these:

- Drive the user path: clicks, typing, mouse selection, real navigation. Use
  `page.evaluate` to read state after the user path ran, not to call
  handlers or set React state.
- Capture the action and the resulting state, not only the final screen.
  Print the asserted text or attribute next to the screenshot.
- Verify side effects where the feature has them: the clipboard after a copy,
  `sight stats` after a page load or a question, the transcript file after an
  append, `/api/...` after a write, a reload for anything that persists.
- No mocks. The seeded transcripts are real (redacted) CLI output behind the
  same ingestion path production uses.
- Read the feature file for the change under test and cover every entry point
  and state it lists that the change can affect.

When a path cannot be reached, name it and say what blocks it. Do not weaken
the journey to make it pass.

## Cleanup

```bash
node .claude/skills/verify-sight/sight-verify.mjs cleanup
```

Stops the daemon this helper started (by recorded pid, confirmed to be a
Sight daemon, never by process name), deletes the fake HOME and
`state.json`, and keeps `evidence/`. Run it after every run, including
failed ones. `drive` closes its own browser.

## Feature map

[`features/README.md`](features/README.md) indexes one file per user-facing
feature. Each file has the same four sections: `Sub-features`,
`How to get to it (user POV)`, `Driving it with sight-verify`, `Gotchas`.
When a change alters user-visible behavior, update the matching feature file
in the same PR.
