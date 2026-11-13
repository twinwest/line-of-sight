---
name: verify-sight
description: "Launch an isolated Line of Sight daemon and drive its web viewer (session list, transcript, search, live tail, side-chat panel) and the sight CLI the way a user does, capturing screenshots and state as proof. Use after changing anything under src/ or web/ to prove the behavior in the real app, or when asked to verify, screenshot, or demo the viewer."
---

The verification harness is agent-neutral and lives in `tools/verify/`.
Read `tools/verify/README.md` and follow it; the feature map is under
`tools/verify/features/`.
