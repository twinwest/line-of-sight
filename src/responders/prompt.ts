import type { ResponderRequest } from './types.js';

/** The one composed-prompt template for all engines (ARCHITECTURE §6). */
export function composePrompt(req: ResponderRequest): string {
  const parts: string[] = [];
  parts.push(
    `You are answering a reader's question about a coding-agent session.`,
  );
  if (req.inlineContext) {
    parts.push(`Relevant excerpt of the session transcript:\n\n${req.inlineContext}`);
  } else {
    parts.push(
      `The full transcript is at ${req.sessionFilePath} — it is JSONL; ` +
      `read the relevant parts with your tools (Grep to locate the anchor text, ` +
      `Read with offsets for context).`,
    );
  }
  if (req.projectDir) parts.push(`The project lives at ${req.projectDir}.`);
  parts.push(
    `Be grounded: cite what in the transcript or files supports your answer. ` +
    `Answer concisely.`,
  );
  for (const t of req.priorTurns) {
    parts.push(`${t.role === 'user' ? 'PRIOR QUESTION' : 'PRIOR ANSWER'}: ${t.text}`);
  }
  parts.push(`ANCHOR (user-selected text): ${req.anchorText}`);
  parts.push(`QUESTION: ${req.question}`);
  return parts.join('\n\n');
}
