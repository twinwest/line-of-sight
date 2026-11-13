# Live tail

While a transcript file grows, new messages appear in the open session
without a reload.

## Sub-features

- append: a new transcript line shows up in the open session within 2 seconds
- follow: the view stays at the bottom if it was at the bottom
- jump-latest: after scrolling up, new content does not move the view; a "↓ Latest" button returns to the tail

## How to get to it (user POV)

Open a session and leave the page open while the agent works. Nothing to click.

## Driving it with sight-verify

The agent is simulated by appending one line to the seeded transcript, which
is exactly what the CLI does to the real file.

```js
const fs = await import('node:fs');
const first = JSON.parse(fs.readFileSync(seeds.claude.file, 'utf8').split('\n')[0]);
const text = 'live tail probe ' + Date.now();

await page.goto('/s/' + seeds.claude.id);
await page.locator('.event[data-mid]').first().waitFor();
const before = await page.locator('.event[data-mid]').count();

const t0 = Date.now();
fs.appendFileSync(seeds.claude.file, JSON.stringify({
  ...first, uuid: crypto.randomUUID(), parentUuid: null,
  timestamp: new Date().toISOString(), message: { role: 'user', content: text },
}) + '\n');
await page.getByText(text).waitFor({ timeout: 2000 });
console.log('appeared after ms:', Date.now() - t0);
console.log('events:', before, '->', await page.locator('.event[data-mid]').count());
await shot('live-tail');
```

End state that proves it: the probe text is visible within 2 seconds and the
message count went up by one, with no reload in the script.

## Gotchas

- The append stays in the instance. Later runs see it in the transcript, in
  search and in the message count. `cleanup` and `launch` reset it.
- Appending does not turn the status dot to `running`. That state comes from
  the agent's process record, not from file freshness, and is not reachable
  from the seeds (see the README).
- The seeded transcript fits in one viewport, so `jump-latest` is not
  reachable as seeded. Append enough lines to overflow the pane first, then
  scroll up with `page.mouse.wheel` and append again.
- Build the appended line from an existing line of the same file. A
  hand-written line that misses fields the adapter reads proves nothing.
