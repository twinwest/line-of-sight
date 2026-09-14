// Investigation only (#29), not imported by the daemon. All inputs are synthetic.
// See docs/CODEX_COMPRESSION_SPIKE.md for commands and limitations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'test/fixtures/codex/compression/rollout-2026-09-13T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst');
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const line = (n, text) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 13, 0, n)).toISOString(),
  type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage',
    content: [{ type: 'text', text }] } } }) + '\n';
// The answer is never supplied in the question or the anchor excerpt.
const lines = [JSON.stringify({ type: 'session_meta', payload: { id: uuid } }) + '\n',
  line(0, 'Review the release decision.'),
  ...Array.from({ length: 80 }, (_, n) => line(n + 1, `Progress ${n}: ${'ordinary synthetic work '.repeat(12)}`)),
  line(82, 'The final release password is violet-otter-742. This supersedes the earlier draft.'),
];
const raw = Buffer.from(lines.join(''));
const sha = b => createHash('sha256').update(b).digest('hex');

if (process.argv[2] === 'generate') {
  assert.equal(typeof zlib.createZstdCompress, 'function', 'fixture generation needs Node >=22.15');
  const chunks = [];
  const compressor = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
  await pipeline(Readable.from([raw]), compressor, new Writable({ write(b, _, done) { chunks.push(b); done(); } }));
  fs.writeFileSync(fixture, Buffer.concat(chunks)); // Only the sanitized compressed fixture.
  console.log(JSON.stringify({ decodedBytes: raw.length, decodedSha256: sha(raw), compressedBytes: fs.statSync(fixture).size }));
  process.exit(0);
}

const compressed = fs.readFileSync(fixture);
const fzstdPath = process.env.SIGHT_SPIKE_FZSTD;
const napiPath = process.env.SIGHT_SPIKE_ZSTD_NAPI;
assert.ok(fzstdPath || napiPath, 'Set SIGHT_SPIKE_FZSTD or SIGHT_SPIKE_ZSTD_NAPI to a temporary installation');
const require = createRequire(import.meta.url);
const napi = napiPath ? require(napiPath) : null;
const binding = napiPath ? require(path.join(napiPath, 'binding.js')) : null;
const Decompress = fzstdPath ? require(fzstdPath).Decompress : null;
function decode(input, retain = false, onChunk = () => {}) {
  let bytes = 0, maxChunk = 0;
  const hash = createHash('sha256'), chunks = [];
  const consume = chunk => {
    bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length); hash.update(chunk);
    if (retain) chunks.push(Buffer.from(chunk));
    onChunk(chunk);
  };
  if (binding) {
    const ctx = new binding.DCtx();
    ctx.setParameter(binding.DParameter.windowLogMax, 23); // 8 MiB window cap, not whole output size.
    let lastRet = 1;
    for (let offset = 0; offset < input.length; offset += 4096) {
      let src = input.subarray(offset, offset + 4096);
      for (;;) {
        const out = Buffer.allocUnsafe(131072);
        const [ret, produced, consumed] = ctx.decompressStream(out, src);
        lastRet = ret;
        consume(out.subarray(0, produced));
        src = src.subarray(consumed);
        if (!src.length && (produced < out.length || ret === 0)) break;
      }
    }
    if (lastRet !== 0) throw new Error('Incomplete compressed frame');
  } else {
    const decoder = new Decompress(consume);
    for (let offset = 0; offset < input.length; offset += 4096) decoder.push(input.subarray(offset, offset + 4096));
    decoder.push(new Uint8Array(), true);
  }
  return { bytes, maxChunk, sha256: hash.digest('hex'), ...(retain ? { data: Buffer.concat(chunks) } : {}) };
}

if (process.argv[2] === 'decode') {
  const start = performance.now();
  const decoded = decode(compressed, true);
  assert.equal(decoded.sha256, sha(raw));
  const offsets = b => { let p = 0; return b.toString().split('\n').filter(Boolean).map(s => {
    const id = `${uuid}:${p}`; p += Buffer.byteLength(s) + 1; return id;
  }); };
  assert.deepEqual(offsets(raw), offsets(decoded.data));
  assert.deepEqual(offsets(Buffer.concat([decoded.data, Buffer.from(line(83, 'Appended after restore.'))])).slice(0, lines.length), offsets(raw));
  const damaged = {};
  const oversizedWindow = Buffer.from(compressed);
  oversizedWindow[5] = 0x98; // Declares a 512 MiB window; rejected before allocation by the native cap.
  for (const [name, data] of Object.entries({ badMagic: Buffer.from('invalid zstd'), truncated: compressed.subarray(0, compressed.length - 8),
    ...(binding ? { oversizedWindow } : {}) })) {
    try { decode(data); damaged[name] = 'accepted'; } catch (e) { damaged[name] = e.message; }
  }
  if (binding) for (const verdict of Object.values(damaged)) assert.notEqual(verdict, 'accepted');
  const concatenated = decode(Buffer.concat([compressed, compressed]));
  assert.equal(concatenated.bytes, raw.length * 2);
  // Read-only in-memory publication model. Plain wins sibling overlap;
  // decoded identity, not compressed size, is the checkpoint coordinate.
  const choose = representations => representations.has('plain') ? 'plain' : representations.has('zst') ? 'zst' : null;
  assert.deepEqual([new Set(['plain']), new Set(['plain', 'zst']), new Set(['zst']), new Set(['plain', 'zst']), new Set(['plain']), new Set()].map(choose),
    ['plain', 'plain', 'zst', 'plain', 'plain', null]);
  const result = { node: process.version, decoder: napi ? 'zstd-napi low-level' : 'fzstd', compressedBytes: compressed.length, decodedBytes: decoded.bytes,
    maxOutputChunk: decoded.maxChunk, ms: performance.now() - start, decodedSha256: decoded.sha256, damaged,
    concatenatedBytes: concatenated.bytes, stableDecodedIds: true, siblingModel: 'plain wins' };
  if (napi || typeof zlib.zstdCompressSync === 'function') {
    const checked = napi ? new napi.Compressor({ checksumFlag: true }).compress(raw)
      : zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    checked[checked.length - 1] ^= 1;
    try { result.corruptChecksum = decode(checked).sha256 === sha(raw) ? 'accepted' : 'changed'; }
    catch (e) { result.corruptChecksum = e.message; }
    if (binding) assert.notEqual(result.corruptChecksum, 'accepted');
    if (typeof zlib.zstdDecompressSync === 'function') {
      try { zlib.zstdDecompressSync(checked); result.nodeChecksum = 'accepted'; } catch (e) { result.nodeChecksum = e.code; }
    }
  }
  console.log(JSON.stringify(result, null, 2));
} else if (process.argv[2] === 'benchmark') {
  assert.ok(napi || zlib.createZstdCompress, 'benchmark generation needs zstd-napi or Node >=22.15');
  const chunks = [];
  const count = 2048;
  await pipeline(Readable.from((function* () { for (let i = 0; i < count; i++) yield raw; })()),
    napi ? new napi.CompressStream({ compressionLevel: 3 }) : zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }),
    new Writable({ write(b, _, done) { chunks.push(b); done(); } }));
  const input = Buffer.concat(chunks);
  const start = performance.now(), cpu = process.cpuUsage();
  const result = decode(input);
  assert.equal(result.bytes, raw.length * count);
  console.log(JSON.stringify({ node: process.version, decoder: napi ? 'zstd-napi low-level' : 'fzstd', decodedMiB: result.bytes / 2 ** 20,
    compressedBytes: input.length, maxOutputChunk: result.maxChunk,
    ms: performance.now() - start, cpuMicros: process.cpuUsage(cpu), peakRssKiB: process.resourceUsage().maxRSS,
    note: 'Synchronous decode blocks this thread; use a worker for production. No full decoded buffer retained.' }, null, 2));
} else if (process.argv[2] === 'read') {
  assert.ok(napi, 'read helper requires SIGHT_SPIKE_ZSTD_NAPI');
  decode(fs.readFileSync(process.argv[3]), false, chunk => process.stdout.write(chunk));
} else if (process.argv[2] === 'ask') {
  assert.equal(decode(compressed).sha256, sha(raw), 'validate the fixture before invoking either CLI');
  const { CLAUDE_ARGS } = await import('../../dist/responders/claudeCli.js');
  const { CODEX_ARGS } = await import('../../dist/responders/codexCli.js');
  const { composePrompt } = await import('../../dist/responders/prompt.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-compressed-ask-'));
  try {
    const source = path.join(dir, path.basename(fixture));
    fs.copyFileSync(fixture, source); // No decoded/raw transcript file is materialized.
    let prompt = composePrompt({ chatId: 'synthetic-spike', sessionFilePath: source, projectDir: dir,
      anchorText: 'Review the release decision.', excerpt: 'USER 2026-09-13T00:00:00Z: Review the release decision.',
      question: 'What is the final release password? Check the full session; do not guess.', priorTurns: [] });
    const engine = process.argv[3];
    assert.ok(['claude', 'codex'].includes(engine), 'ask requires claude or codex');
    if (process.argv[4] === 'helper') {
      assert.ok(napi, 'helper experiment requires zstd-napi');
      prompt += `\nThis source is zstd compressed. Use the bundled read-only decoder instead of a system zstd executable: ` +
        `${process.execPath} ${fileURLToPath(import.meta.url)} read ${source}. Pipe its stdout into rg to find evidence. ` +
        `Do not materialize a decompressed file.`;
    }
    const args = engine === 'claude' ? CLAUDE_ARGS(prompt) : CODEX_ARGS(prompt);
    const child = spawn(engine, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 90_000);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    // Only synthetic responder output; never credentials or real transcripts.
    console.log(JSON.stringify({ engine, code, stdout, stderr: stderr.slice(-2000) }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else { throw new Error('Expected generate, decode, benchmark, or ask'); }
