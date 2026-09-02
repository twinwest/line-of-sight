import type { ResponderRequest } from './types.js';

/** The one composed-prompt template for all engines (ARCHITECTURE §6). */
export function composePrompt(req: ResponderRequest): string {
  const parts: string[] = [];
  parts.push(
    `You are answering a reader's question about a coding-agent session.`,
  );
  parts.push(
    `The full transcript is at ${req.sessionFilePath} — it is JSONL; ` +
    `read the relevant parts with your tools (Grep to locate the anchor text, ` +
    `Read with offsets for context).`,
  );
  if (req.projectDir) parts.push(`The project lives at ${req.projectDir}.`);
  if (req.excerpt) {
    parts.push(
      `Conversation around the anchor, extracted for you (rows labeled by ` +
      `role; this usually answers locate/orient questions without tools). It ` +
      `covers ONLY the vicinity of the anchor — if the question is about the ` +
      `whole session, or about anything not visible here, you MUST read the ` +
      `transcript file; never present an excerpt-only view as the full ` +
      `session. The transcript file remains the source of truth:\n\n${req.excerpt}`,
    );
  }
  if (req.branches) {
    parts.push(
      `This transcript contains branches the user rewound away from. It is a ` +
      `tree, not a list: lines carry parentUuid, and where several non-tool_result ` +
      `lines share a parent, the LAST one in the file is the path actually taken — ` +
      `earlier siblings and their descendants were abandoned, and near-identical ` +
      `wordings of the same prompt may appear on both sides. Authority order: for ` +
      `"what happened / how was it solved", only the path taken counts; abandoned ` +
      `branches may be cited only for "what was tried / why was it dropped", and ` +
      `must be labeled as abandoned when cited.`,
    );
    parts.push(req.branches.anchorAbandoned
      ? `The ANCHOR below sits INSIDE an abandoned branch: the question is about ` +
        `a path the conversation rewound away from — say so, and check what ` +
        `replaced it on the path taken.`
      : `The ANCHOR below is on the path taken; when you Grep for it, make sure ` +
        `you are not reading context around an abandoned copy.`);
  }
  parts.push(
    `If the question asks for judgment (problems, correctness, a review): ` +
    `read the relevant project files as they are NOW, not just the ` +
    `transcript — the repo may have moved past the anchored moment, so a ` +
    `problem the session already fixed must be reported as fixed, not as a ` +
    `problem. Report only real problems, worst first, and skip style nits; ` +
    `if it holds up, say so plainly.`,
  );
  parts.push(
    `Be grounded: cite what in the transcript or files supports your answer. ` +
    `Answer concisely, in the language the question is asked in.`,
  );
  for (const t of req.priorTurns) {
    parts.push(`${t.role === 'user' ? 'PRIOR QUESTION' : 'PRIOR ANSWER'}: ${t.text}`);
  }
  parts.push(`ANCHOR (user-selected text): ${req.anchorText}`);
  parts.push(`QUESTION: ${req.question}`);
  return parts.join('\n\n');
}
