import fs from 'node:fs';
import { createRequire } from 'node:module';

/** One transcript line as a reader yields it: `byteOffset` is where the
 *  line starts and `end` where the next one would (past the newline) — for
 *  a compressed source both are DECODED positions, the only coordinates
 *  that survive recompression. */
export interface RolloutLine { text: string; byteOffset: number; end: number }

const stamp = (kind: 'zst' | 'plain', s: fs.BigIntStats) =>
  [kind, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');

/** Identity of the physical file: same stamp ⇒ same bytes, nothing to
 *  replay. Physical compressed positions never serve as decoded checkpoints. */
export function codexFingerprint(filePath: string): string {
  return stamp(filePath.endsWith('.zst') ? 'zst' : 'plain', fs.statSync(filePath, { bigint: true }));
}

// The package's low-level subpath lacks NodeNext exports/types. Describe
// only the stable native calls used here; loading stays optional and lazy.
interface ZstdBinding {
  DParameter: { windowLogMax: number };
  DCtx: new () => {
    setParameter(parameter: number, value: number): void;
    decompressStream(output: Buffer, input: Buffer): [number, number, number];
  };
}

function loadDecoder(): ZstdBinding {
  try {
    return createRequire(import.meta.url)('zstd-napi/binding') as ZstdBinding;
  } catch {
    throw new Error('Compressed Codex support requires the optional zstd-napi decoder. Reinstall line-of-sight with optional dependencies.');
  }
}

const RECORD_MAX = 8 * 1024 * 1024;

/** Decode a `.jsonl.zst` rollout line by line: 4 KiB input slices, 128 KiB
 *  output slices, an 8 MiB history window, records up to 8 MiB. Synchronous
 *  (native decode is far cheaper than the JSON parse that follows); the
 *  caller batches and, where it can, yields. Throws — after the lines it
 *  already yielded — on an incomplete frame, a partial last record, or a
 *  file that changed underneath the read, so a consumer inside a
 *  transaction rolls back to its previous view. */
export function* compressedLines(filePath: string): Generator<RolloutLine> {
  const binding = loadDecoder();
  const ctx = new binding.DCtx();
  ctx.setParameter(binding.DParameter.windowLogMax, 23);
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = stamp('zst', fs.fstatSync(fd, { bigint: true }));
    const input = Buffer.allocUnsafe(4096);
    const output = Buffer.allocUnsafe(131072);
    let pending: Buffer = Buffer.alloc(0), offset = 0, lastRet = 1;
    for (;;) {
      const n = fs.readSync(fd, input, 0, input.length, null);
      if (!n) break;
      let src = input.subarray(0, n);
      for (;;) {
        const [ret, produced, used] = ctx.decompressStream(output, src);
        lastRet = ret;
        src = src.subarray(used);
        const data = Buffer.concat([pending, output.subarray(0, produced)]);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl < 0) break;
          if (nl - start > RECORD_MAX) throw new Error('Decoded JSONL record exceeds 8 MiB');
          yield { text: data.toString('utf8', start, nl).replace(/\r$/, ''), byteOffset: offset + start, end: offset + nl + 1 };
          start = nl + 1;
        }
        pending = Buffer.from(data.subarray(start));
        offset += start;
        if (pending.length > RECORD_MAX) throw new Error('Decoded JSONL record exceeds 8 MiB');
        if (!src.length && (produced < output.length || ret === 0)) break;
      }
    }
    if (lastRet !== 0) throw new Error('Incomplete compressed frame');
    if (pending.toString('utf8').trim()) throw new Error('Decoded transcript ends with an incomplete JSONL record');
    if (stamp('zst', fs.fstatSync(fd, { bigint: true })) !== before) throw new Error('Compressed source changed while reading');
  } finally { fs.closeSync(fd); }
}
