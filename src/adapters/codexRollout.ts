import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

export interface RolloutLine { text: string; byteOffset: number }
export interface DecodedRollout { fingerprint: string; consumed: number }

/** Physical compressed positions never serve as decoded JSONL checkpoints. */
export function codexFingerprint(filePath: string): string {
  const s = fs.statSync(filePath, { bigint: true });
  return [filePath.endsWith('.zst') ? 'zst' : 'plain', s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}

// Serialized into a worker rather than requiring a TS loader in tests or
// raising the Node 20 baseline. All runtime dependencies are local to this
// function. The native module is loaded only inside compressed reads.
async function rolloutWorker(): Promise<void> {
  const { parentPort: port, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
  const fs = require('node:fs') as typeof import('node:fs');
  const { createRequire } = require('node:module') as typeof import('node:module');
  if (!port) return;
  const fingerprint = (s: import('node:fs').BigIntStats) => ['zst', s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  let fd: number | undefined;
  try {
    // The package's low-level subpath lacks NodeNext exports/types. Describe
    // only the stable native calls used here; loading remains optional.
    const binding: { DParameter: { windowLogMax: number }; DCtx: new () => {
      setParameter(parameter: number, value: number): void;
      decompressStream(output: Buffer, input: Buffer): [number, number, number];
    } } = createRequire(workerData.moduleUrl)(workerData.decoder);
    const ctx = new binding.DCtx();
    ctx.setParameter(binding.DParameter.windowLogMax, 23); // 8 MiB history cap.
    fd = fs.openSync(workerData.filePath, 'r');
    const before = fingerprint(fs.fstatSync(fd, { bigint: true }));
    const input = Buffer.allocUnsafe(4096);
    const output = Buffer.allocUnsafe(131072);
    let pending: Buffer = Buffer.alloc(0), offset = 0, consumed = 0, lastRet = 1;
    let batch: { text: string; byteOffset: number }[] = [], batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const ack = new Promise<void>(resolve => port.once('message', () => resolve()));
      port.postMessage({ kind: 'batch', lines: batch });
      batch = []; batchBytes = 0;
      await ack; // At most one bounded batch in transit, even for high compression ratios.
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
    if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== before) throw new Error('Compressed source changed while reading');
    await flush();
    port.postMessage({ kind: 'done', fingerprint: before, consumed });
  } catch (e) {
    port.postMessage({ kind: 'error', error: e instanceof Error ? e.message.slice(0, 300) : 'Compressed read failed' });
  } finally { if (fd !== undefined) fs.closeSync(fd); port.close(); }
}

/** Stream complete decoded lines with bounded input/output and backpressure.
 *  No decoded transcript file is created. A failed frame never reports done. */
export function readCompressedCodex(filePath: string,
    onBatch: (lines: RolloutLine[]) => void | Promise<void>): Promise<DecodedRollout> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      const decoder = createRequire(import.meta.url).resolve('zstd-napi/binding');
      worker = new Worker(`(${rolloutWorker.toString()})()`, { eval: true,
        workerData: { filePath, decoder, moduleUrl: import.meta.url } });
    } catch { reject(new Error('Compressed Codex support requires the optional zstd-napi decoder. Reinstall line-of-sight with optional dependencies.')); return; }
    let done = false;
    const fail = (e: Error) => { done = true; void worker.terminate(); reject(e); };
    worker.on('error', fail);
    worker.on('exit', code => { if (!done) fail(new Error(`Compressed decoder exited before completion (${code})`)); });
    worker.on('message', async (message: { kind: string; lines: RolloutLine[]; fingerprint: string; consumed: number; error: string }) => {
      if (done) return;
      if (message.kind === 'batch') {
        try { await onBatch(message.lines); worker.postMessage('ack'); }
        catch (e) { fail(e instanceof Error ? e : new Error('Compressed ingestion failed')); }
      } else if (message.kind === 'done') {
        done = true;
        resolve({ fingerprint: message.fingerprint, consumed: message.consumed });
      } else if (message.kind === 'error') fail(new Error(message.error));
    });
  });
}
