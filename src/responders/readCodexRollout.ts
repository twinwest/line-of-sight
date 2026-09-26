// Bundled read-only helper for codex exec's existing sandbox. Emits decoded
// JSONL on stdout; never restores a transcript or creates a raw copy.
import { once } from 'node:events';
import { compressedLines } from '../adapters/codexRollout.js';

try {
  const filePath = process.argv[2];
  if (!filePath?.endsWith('.jsonl.zst')) throw new Error('Expected a compressed .jsonl.zst rollout path');
  for (const line of compressedLines(filePath)) {
    if (!process.stdout.write(line.text + '\n')) await once(process.stdout, 'drain');
  }
} catch (e) {
  process.stderr.write(`Cannot read compressed transcript: ${e instanceof Error ? e.message : 'decoder failed'}\n`);
  process.exitCode = 1;
}
