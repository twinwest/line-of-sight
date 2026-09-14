import fs from 'node:fs';
import { createRequire } from 'node:module';

export interface RolloutLine { text: string; byteOffset: number }
export interface DecodedRollout { fingerprint: string; consumed: number }

const stamp = (kind: 'zst' | 'plain', s: fs.BigIntStats) =>
  [kind, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');

/** Physical compressed positions never serve as decoded JSONL checkpoints. */
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

/** Stream complete decoded lines in bounded batches: 4 KiB input slices,
 *  128 KiB output slices, an 8 MiB history window, records up to 8 MiB,
 *  batches of ≤256 lines / ~512 KiB. Runs inline — native decode is far
 *  faster than the JSON parsing the caller does per batch, and the caller
 *  yields between batches. A failed frame never reports done. */
export async function readCompressedCodex(filePath: string,
    onBatch: (lines: RolloutLine[]) => void | Promise<void>): Promise<DecodedRollout> {
  const binding = loadDecoder();
  const ctx = new binding.DCtx();
  ctx.setParameter(binding.DParameter.windowLogMax, 23);
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = stamp('zst', fs.fstatSync(fd, { bigint: true }));
    const input = Buffer.allocUnsafe(4096);
    const output = Buffer.allocUnsafe(131072);
    let pending: Buffer = Buffer.alloc(0), offset = 0, consumed = 0, lastRet = 1;
    let batch: RolloutLine[] = [], batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const lines = batch;
      batch = []; batchBytes = 0;
      await onBatch(lines);
    };
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
          if (nl - start > 8 * 1024 * 1024) throw new Error('Decoded JSONL record exceeds 8 MiB');
          batch.push({ text: data.toString('utf8', start, nl).replace(/\r$/, ''), byteOffset: offset + start });
          batchBytes += nl - start + 1;
          consumed = offset + nl + 1;
          start = nl + 1;
          if (batchBytes >= 512 * 1024 || batch.length >= 256) await flush();
        }
        pending = Buffer.from(data.subarray(start));
        offset += start;
        if (pending.length > 8 * 1024 * 1024) throw new Error('Decoded JSONL record exceeds 8 MiB');
        if (!src.length && (produced < output.length || ret === 0)) break;
      }
    }
    if (lastRet !== 0) throw new Error('Incomplete compressed frame');
    if (pending.toString('utf8').trim()) throw new Error('Decoded transcript ends with an incomplete JSONL record');
    if (stamp('zst', fs.fstatSync(fd, { bigint: true })) !== before) throw new Error('Compressed source changed while reading');
    await flush();
    return { fingerprint: before, consumed };
  } finally { fs.closeSync(fd); }
}
