# Side chat (select-to-ask)

Select text in a transcript, click Ask, and question it in a side panel. The
answer comes from a separate read-only run of the session's own agent CLI.

## Sub-features

- ask-button: a floating "Ask" button appears on a text selection inside one message; it disappears on click-away
- panel: opens on the right with the selection quoted as the anchor, three preset questions, a free-text input, model and effort pickers
- persistence: the side chat is saved the moment the panel opens; it survives a reload
- margin-marker: a message with a saved side chat shows a dot in the gutter that reopens it
- asks-chip: the header's "Asks · N" chip counts and lists the session's side chats
- delete: the panel's Delete button removes the side chat
- close: ✕ closes the panel; a side chat with no question yet is discarded on close
- answer: a preset or typed question streams an answer, with Cancel while it runs (opt-in, see Gotchas)

## How to get to it (user POV)

Open a session, drag across any text in a message, click the "Ask" button
that appears above the selection.

## Driving it with sight-verify

```js
await page.goto('/s/' + seeds.claude.id);
await select(page.getByText('Say exactly: hi'));
await page.locator('.ask-btn').waitFor();
await shot('ask-button');

await page.locator('.ask-btn').click();
await page.locator('.side-panel').waitFor();
console.log('anchor:', await page.locator('.side-panel .anchor').innerText());
console.log('presets:', await page.locator('.side-panel .preset').allInnerTexts());
console.log('chip:', await page.locator('.session-header .chip', { hasText: 'Asks' }).innerText());   // Asks · 1
await shot('side-panel');

await page.reload();
await page.locator('.margin-marker').click();
await page.locator('.side-panel .anchor').waitFor();
console.log('reopened from marker after reload');

await page.locator('.side-panel button', { hasText: 'Delete' }).click();
await page.locator('.margin-marker').waitFor({ state: 'detached' });
console.log('chip after delete:', await page.locator('.session-header .chip', { hasText: 'Asks' }).innerText());   // Asks · 0
```

End state that proves it: the anchor equals the selected text; the chip
reads `Asks · 1`; after a reload the margin marker reopens the same anchor;
after Delete the marker is gone and the chip reads `Asks · 0`.

## Gotchas

- Do not click a preset or send a question unless the task is about the
  answer path and the user agreed. It runs the real `claude -p` or
  `codex exec` and spends the user's tokens. The snippet above stops before
  that on purpose.
- The answer path has not been proven under the fake HOME. Whether the agent
  CLI finds its login there is unknown; if it does not, the panel shows an
  error, which is a harness limit, not a product bug.
- A scripted selection (`locator.selectText()`, `Selection.addRange`) does
  not show the Ask button; it listens for `mouseup`. Use `select()`.
- `select()` drags across one line. For text that wraps, pick a shorter element.
- A drag that starts at the edge of the transcript pane makes the browser
  autoscroll, the text leaves the pointer, and nothing is selected. `select()`
  centres the element first; a hand-written drag must do the same.
- Delete closes the panel first and removes the side chat a moment later.
  Wait for the marker to detach, not for the panel.
- The selection must sit inside a single message. Dragging across two
  messages shows no button, by design.
