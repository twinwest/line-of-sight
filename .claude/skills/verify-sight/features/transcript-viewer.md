# Transcript viewer

One session rendered as a readable document: prose stays visible, everything
else folds.

## Sub-features

- header: status dot, title, agent badge, project dir, start time, short-id chip, "Asks · N" chip
- messages: user prompts and assistant text as Markdown, one `.event[data-mid]` each
- step-folding: runs of tool calls, thinking and meta collapse into "N steps · M tool calls"
- tool-rows: inside an open fold, each tool call is its own collapsed row
- raw-fallback: unrecognized entries render as a collapsed "raw block", never dropped
- copy-markdown: per-message button that copies the message's source Markdown
- reply-draft: "✎ Draft reply" at the tail opens a compose card; Copy is its only action; the draft persists per session

## How to get to it (user POV)

Click a row on the home page, or open `/s/<session id>` directly. Folds open
on click. The Copy Markdown button appears on hovering a message. The draft
toggle sits below the last message.

## Driving it with sight-verify

```js
await page.goto('/s/' + seeds.claude.id);
await page.locator('.event[data-mid]').first().waitFor();
console.log('header:', (await page.locator('.session-header').innerText()).replace(/\n/g, ' | '));
await shot('transcript-folded');

const fold = page.locator('.turn-fold', { hasText: 'tool call' });
await fold.locator('summary').first().click();
await fold.locator('.tool-name', { hasText: 'TaskList' }).waitFor();
console.log('raw blocks:', await page.locator('.fold.raw').count());
await shot('transcript-fold-open');

const msg = page.locator('.event', { hasText: 'No response requested.' });
await msg.hover();
await msg.locator('button[title="Copy Markdown"]').click();
console.log('clipboard:', await page.evaluate(() => navigator.clipboard.readText()));

await page.locator('.draft-toggle').click();
await page.getByPlaceholder('Write your reply here…').fill('draft survives reload');
await page.reload();
const kept = await page.getByPlaceholder('Write your reply here…').inputValue();
if (kept !== 'draft survives reload') throw new Error('draft lost on reload: ' + kept);
await shot('transcript-draft');
```

End state that proves it: the header reads `Deep dive | claude | …`; the
opened fold shows a `TaskList` tool row; the clipboard equals the message
text; the draft text is still in the card after a reload.

The Codex seed (`seeds.codex`) renders through the same components. Drive it
too when a change touches `src/adapters/codex*` or the Codex dialect.

## Gotchas

- Step counts and tool names come from the fixture. If the fixture changes,
  update this file; do not loosen the assertion.
- The Copy Markdown button is hidden until hover. Hover first, as a user would.
- A fresh page load scrolls to the tail. Messages above the fold are in the
  DOM; `shot` captures only the viewport.
- The `?m=<message id>&q=<query>` form of the URL is covered in
  [search](search.md).
