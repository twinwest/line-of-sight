# Search

One global box that searches the dialog (user prompts and assistant prose)
across all sessions.

## Sub-features

- query: typing searches after a 250 ms pause; results open under the box
- grouping: hits are grouped under their session title, each with a highlighted snippet
- no-matches: a query with no hit shows "No matches"
- jump: clicking a hit opens that session at that message, which flashes briefly
- short-and-cjk: queries under 3 characters and CJK text still match

## How to get to it (user POV)

The box in the top bar, placeholder "Search all sessions…", on every page.

## Driving it with sight-verify

```js
await page.goto('/');
const box = page.getByPlaceholder('Search all sessions…');

await box.fill('Say exactly');
const hit = page.locator('.search-hit').first();
await hit.waitFor();
console.log('group:', await page.locator('.search-group-title').first().innerText());   // Deep dive
console.log('highlighted:', await hit.locator('mark').allInnerTexts());
await shot('search-results');

await hit.click();
await page.waitForURL(/\/s\/.+\?m=.+&q=/);
await page.locator('.event.flash').waitFor();
console.log('flashed message:', await page.locator('.event.flash').innerText());
await shot('search-jump');

await box.fill('zzz-no-such-text');
await page.locator('.search-results .empty').waitFor();
console.log('empty state:', await page.locator('.search-results .empty').innerText());
```

End state that proves it: the hit sits under the `Deep dive` group with the
query inside `<mark>`; after the click the URL carries `?m=…&q=…` and the
message containing the query has the `flash` class.

## Gotchas

- Tool calls, tool output and thinking are not indexed, by design. A query
  that only appears inside a tool row correctly returns "No matches".
- The `flash` class is removed when its animation is cleaned up. Wait for it
  right after the navigation, not after other steps.
- The seeds contain no CJK text. To prove CJK matching, append a line with
  CJK content first (see [live-tail](live-tail.md)).
- Results close on a mousedown outside the box. Take the screenshot before
  clicking elsewhere.
