# Session list

The home page: every ingested session, most actionable first, one row each.

## Sub-features

- rows: status dot, title, agent badge, project dir, message count, time, short id
- project-filter: dropdown that narrows the list to one project dir
- open-session: clicking a row opens `/s/<id>`
- copy-id: clicking the short id copies the full session id and does not navigate
- sessions-popover: inside a session, the topbar "Sessions" chip lists the other non-idle sessions

## How to get to it (user POV)

Open the viewer root, or click the "Line of Sight" brand from any page. The
popover is the "Sessions" chip at the top right of a session page.

## Driving it with sight-verify

```js
await page.goto('/');
const row = page.locator('.session-row', { hasText: 'Deep dive' });
await row.waitFor();
console.log('rows:', await page.locator('.session-row').count());            // 2
console.log('badge:', await row.locator('.badge').innerText());              // claude
console.log('dot:', await row.locator('.dot').getAttribute('title'));        // idle | just finished
console.log('filter options:', await page.locator('.list-controls select option').allInnerTexts());
await shot('session-list');

await row.locator('.row-id button').click();
console.log('copied id:', await page.evaluate(() => navigator.clipboard.readText()));
if (!page.url().endsWith('/')) throw new Error('copy-id navigated away');

await row.click();
await page.waitForURL('**/s/' + seeds.claude.id);
await page.locator('.topbar .chip', { hasText: 'Sessions' }).click();
console.log('popover:', await page.locator('.sessions-list').innerText());
await shot('sessions-popover');
```

End state that proves it: two rows, the Claude row badged `claude` and the
Codex row `codex`; the clipboard holds the full session id while the URL is
still `/`; the row click lands on `/s/<id>`.

## Gotchas

- The list polls every 10 seconds; it has no live stream. After changing a
  transcript, reload the page instead of waiting on the poll.
- Both seeds share one project dir, so the filter has a single project
  option. Proving that the filter narrows the list needs a seed with another `cwd`.
- A session the browser has not opened shows `just finished` for 10 minutes
  after its last write, then `idle`. "Opened" is tracked in localStorage,
  which is empty on every drive run.
- The popover hides idle sessions and the current one, so on aged seeds it
  reads "No other session is running."
