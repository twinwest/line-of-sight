# CLI

The `sight` command: daemon lifecycle and local diagnostics.

## Sub-features

- status: reports whether the daemon runs, on which port, pid and version; exit 1 when it does not
- stats: daily `viewer_open` and `question_asked` counters for the last 14 days
- inspect: summarizes one transcript file (session id, adapter, event and tool counts)
- stop / start: stops the daemon; starts it detached
- wrappers: `sight claude`, `sight codex`, `sight open` (not driven here, see Gotchas)

## How to get to it (user POV)

`sight <command>` in a terminal. `sight --help` lists the commands.

## Driving it with sight-verify

These are shell commands, not `drive` scripts. `sight-verify.mjs sight …`
runs the built CLI with the isolated HOME and port.

```bash
V=tools/verify/sight-verify.mjs
node $V sight status; echo "exit=$?"        # daemon running on http://127.0.0.1:2121 (pid …, v…), exit=0
node $V sight stats                         # note the viewer_open total
echo "await page.goto('/')" | node $V drive
node $V sight stats                         # viewer_open total is one higher
node $V sight inspect "$TMPDIR/sight-verify-2121/home/.claude/projects/-verify-project/51e24591-d70b-4877-b3cd-394d6dbe1db8.jsonl"
```

End state that proves it: `status` names port 2121 and the version in
`package.json` with exit code 0; one page load raises `viewer_open` by
exactly one; `inspect` prints the seeded session id with `[claude-code]`.

Lifecycle, when a change touches start or stop:

```bash
node $V sight stop                          # sent SIGTERM to daemon (pid …)
node $V sight status; echo "exit=$?"        # daemon not running, exit=1
node $V sight start                         # daemon started on http://127.0.0.1:2121
node $V doctor                              # two FAILs: the launched pid is gone and a new pid owns the port
```

After a lifecycle run, `cleanup` (it also stops the daemon `sight start`
created inside the fake HOME) and `launch` again before driving anything else.

## Gotchas

- Never run `sight open`, `sight claude` or `sight codex` through the
  helper. `open` and the wrappers open a tab in the user's real browser, and
  the wrappers start the real agent. Their fail-open behavior is covered by
  `test/wrap.test.ts`.
- Run the bare `sight` binary only through the helper. Without the isolated
  HOME and port it talks to the user's own daemon on port 2020.
- `stats` counts every `drive` page load in the isolated instance. Compare
  totals before and after; do not assert an absolute number.
