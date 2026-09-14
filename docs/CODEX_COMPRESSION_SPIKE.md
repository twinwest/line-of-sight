# Codex compressed rollouts: #29 investigation

Decision date: 2026-09-13. Archive lifecycle #28 is on `main` at
`019ee2b`. This spike adds no compressed ingestion or responder behavior.

## Outcome

Use `zstd-napi@0.0.12`'s low-level streaming decoder for the Node >=20
baseline if compressed support proceeds. A native prebuild installed and
ran on this machine with Node 20.20.2 / macOS arm64. No system `zstd`
executable is needed. Keep it isolated from daemon startup so missing native
bindings cannot break plain ingestion or the fail-open wrapper.

**#30 remains blocked on Claude Ask grounding.** With the existing
Read/Grep/Glob cage, the actual Claude responder could not read evidence in
a valid `.jsonl.zst` outside its anchor excerpt. Codex's read-only responder
could, including through the Node 20 decoder helper. The daemon decoding a
file is insufficient to give Claude's tools access to its full contents.
An excerpt-only answer does not meet #30.

This is a concrete limit of the current design, not a claim that compressed
Ask can never be built. Resolving it requires an explicit scope/design
decision; the experiment did not change product behavior or permissions.

## Reproduction and source distinctions

The fixture under `test/fixtures/codex/compression/` is synthetic:
83 JSONL records, 37,708 decoded bytes, 690 compressed bytes. It contains no
real session data. The answer `violet-otter-742` is in record 83, eighty
progress messages beyond the anchor in record 2. The prompt contains only
the anchor, not the answer. Decoded SHA-256:
`9f1ea3986d9d474f1a0496c5568e23a63c1e142966e98b02b6052a0957beebb4`.

The fixture has standard zstd magic `28 b5 2f fd`, no advertised content
size or checksum, and a 2 MiB window. It was generated using Node 24.17.0
streaming zstd at level 3. Separate generated inputs exercise checksum
validation. This verifies readers against the format; it is not evidence
that codex-cli 0.153.4 currently produces compressed files. The earlier
read-only local discovery found an archive and no `.zst`.

Upstream observations are pinned to the compression source's last change
commit [73a1148](https://github.com/openai/codex/blob/73a1148c9c775c2a4616ce5096291740a00ed68a/codex-rs/rollout/src/compression.rs):
both active and archived roots are scanned; cold rollouts are selected by
mtime with a seven-day threshold; compression publishes a sibling before
removing plain data; plain is preferred during overlap and restored before
append. This does not establish release activation on the owner's CLI.
Archive/unarchive are separate moves, already handled by #28.

Run from the project root. Dependencies belong to a temporary directory;
the project dependency list and lockfile are unchanged:

```sh
npm install --prefix /private/tmp/sight-compression-spike --no-audit --no-fund --ignore-scripts fzstd@0.1.1 zstd-napi@0.0.12
npm rebuild --prefix /private/tmp/sight-compression-spike zstd-napi
export SIGHT_SPIKE_ZSTD_NAPI=/private/tmp/sight-compression-spike/node_modules/zstd-napi
npx --yes --package=node@20 node scripts/spikes/codex-compression.mjs decode
npx --yes --package=node@20 node scripts/spikes/codex-compression.mjs benchmark
```

For the actual responder experiments, `npm run build` first, then:

```sh
npx --yes --package=node@20 node scripts/spikes/codex-compression.mjs ask claude
npx --yes --package=node@20 node scripts/spikes/codex-compression.mjs ask codex helper
```

These invoke the user's authenticated CLIs with Sight's actual argument
builders and prompt. They use normal responder billing. Inputs are a
temporary directory containing only the compressed synthetic fixture;
there is no raw JSONL file, project content, or answer-bearing excerpt.
The directory is removed when the experiment ends. No archive, restore,
resume, config-edit, or agent-state operation is performed. Existing
read-only / ephemeral / no-session-persistence flags are retained.

To compare the pure JS decoder, unset `SIGHT_SPIKE_ZSTD_NAPI`, set
`SIGHT_SPIKE_FZSTD=/private/tmp/sight-compression-spike/node_modules/fzstd`,
and run `decode` on Node 20. Run it on Node >=22.15 to also generate the
checksum-corruption control, and `benchmark` to generate a large input.
`generate` on Node >=22.15 rebuilds only the checked-in synthetic compressed
fixture; no full raw transcript is saved. The `read` helper is an experiment,
not a shipped command.

## Reader choice and bounds

| Candidate | Verified result | Decision |
|---|---|---|
| Node `node:zlib` zstd | Native streaming, checksum error detected | Not available on Node 20; [added in 22.15 / 23.8](https://nodejs.org/download/release/v22.18.0/docs/api/zlib.html) |
| `fzstd@0.1.1` | Node 20 decodes fixture; invalid magic/truncation rejected; corrupted checksum accepted | Do not ship unchanged |
| `zstd-napi@0.0.12` low-level binding | Node 20 decodes fixture and concatenated frames; invalid magic, truncation, checksum corruption, and excessive window rejected | Selected reader |
| `zstddec@0.2.0` | Source inspection of streaming wrapper found no zstd error check inside decode loop | Not selected; malformed-input safety not established |

The [fzstd source](https://github.com/101arrowz/fzstd/blob/master/src/index.ts)
uses frame-declared window allocations and skips checksum bytes. Its API
alone does not establish a safe small memory bound for untrusted headers.
The corruption experiment independently confirmed the checksum gap.
The [zstddec streaming source](https://github.com/donmccurdy/zstddec-wasm/blob/main/src/zstddec-stream.ts)
checks the final return value but does not check each call for an error.
No malformed-stream experiment was run against that candidate.

The selected binding exposes `DCtx.decompressStream` and
[`windowLogMax`](https://drakedevel.github.io/zstd-napi/interfaces/index.DecompressParameters.html).
The spike caps the decoding window at 8 MiB, consumes 4 KiB input slices,
and allocates at most 128 KiB output per call. A mutated fixture
declaring a 512 MiB window fails before that allocation. Invalid magic gives
`Unknown frame descriptor`, missing frame tail gives `Incomplete compressed
frame`, and a corrupted checksum gives `Data corruption detected`.
Frames requiring a dictionary or a larger window must produce an explicit
unsupported-input diagnostic rather than be guessed or silently truncated.

Measured once on this machine, with hash consumption and no full decoded
output retained:

| Reader / runtime | Decoded input | Decode wall time | Process peak RSS | Largest output chunk |
|---|---:|---:|---:|---:|
| fzstd / Node 24.17.0 | 73.65 MiB | 201 ms | 130.4 MiB | 128 KiB |
| zstd-napi low-level / Node 20.20.2 | 73.65 MiB | 44 ms | 97.0 MiB | 128 KiB |

RSS includes the runtime and input generation, not just decoder memory.
This is highly repetitive synthetic data, not a representative throughput
benchmark or a total-memory guarantee. Both calls are synchronous and can
block the calling thread.

For production, decode in a worker, stream file input, acknowledge bounded
output batches, and yield ingestion batches to the daemon. Do not simply
pipe the library's `DecompressStream` into a slow destination: source
inspection shows its inner loop ignores `push()` backpressure; a small
compressed chunk can queue much larger output. Low-level calls let Sight
bound pending output explicitly. Also cap pending JSONL line and event-batch
sizes; a small zstd window does not bound a gigantic JSON record. The
experimental helper reads the compressed input into memory and is not the
production streaming file reader.

The [package's installation policy](https://github.com/drakedevel/zstd-napi#support-policy)
provides platform prebuilds, with a compiler fallback. Only macOS arm64 was
actually installed here; platform CI remains necessary. Dependency download
is an installation concern, not a daemon network call. Load failure must
affect only compressed support and produce a bounded diagnostic. No mandatory
external zstd executable, runtime download, or Node baseline increase is needed.

## Identity, checkpoints, and lifecycle decision

Use the rollout UUID as session identity, stripping both `.jsonl` and
`.jsonl.zst`. Message IDs remain transcript IDs where present, otherwise
`sessionUuid:decodedByteOffset`. Offsets count UTF-8 bytes, including
non-rendering carrier records, not string characters or compressed bytes.
The experiment verifies decoded byte equality and fallback coordinates
before/after compression and a subsequent append. This is a model test;
the shipped adapter has not yet acquired `.zst` support.

Keep physical source identity separate from the decoded checkpoint:

- Persist representation and device/inode with the Codex source binding.
  Archive rename preserves a plain checkpoint as in #28.
- `byte_offset` is the decoded position after the last complete JSONL
  newline. Do not compare it to compressed `stat.size`, seek to it in the
  compressed file, or use compressed size to infer transcript truncation.
- A changed representation/inode triggers a replay from frame start,
  rebuilding derived messages while retaining side chats, titles, and frozen
  `excerpt_json`. Identical decoded records recreate identical IDs/anchors.
  Do not artificially bump activity timestamps; use transcript timestamps.
- For an unchanged verified immutable compressed source, skip unnecessary
  decoding. Its stored fingerprint comprises representation, device/inode,
  physical size, `mtimeNs`, and `ctimeNs` from bigint file stats. A changed
  fingerprint triggers replay. Re-stat the open source and resolve its path
  before committing the checkpoint; if the source changed during decoding,
  discard staging and retry instead of publishing a mixed snapshot. Plain
  appends still use #28's inode binding and normal tail checkpoint rather
  than treating every mtime change as a replacement. Compressed decoding
  cannot restart at an arbitrary byte without an explicit seekable index;
  do not introduce one for this feature.
- Resolve a plain sibling before its compressed sibling, including when a
  compressed binding gains its restored plain sibling. Keep #28's bound-source
  policy for unrelated duplicate UUID paths. Scan active and archived
  representations before prune, and use the same resolver for both watcher
  event orders and offline transitions.
- All representations gone means session deletion, including source facts
  and FTS. Honor the newly merged `keepSideChats` opt-in for user-owned side
  chats/snapshots; the default still deletes them. Claude uses its existing
  deletion path and never enters Codex reconciliation.

Validate compressed frame completion before publishing a replacement as a
complete session or advancing its durable checkpoint. Worker batches can
feed temporary derived database staging, then atomically replace on success;
do not retain a raw transcript copy. On corruption, preserve a previously
valid derived view with an explicit diagnostic, or expose a bounded error
for a newly discovered source. Do not crash daemon startup, repeatedly log
the same error, delete side chats, or represent partial data as complete.
The precise staging implementation belongs in #30, after grounding is decided.

## Outside-excerpt Ask experiment and blocker

Both runs used the shipped prompt, which requires reading the full source
for evidence outside the excerpt. CLI versions: Claude Code 2.1.270 and
codex-cli 0.153.4. The fixture was validated against both decoders before
the recorded runs. The runner verifies its decoded hash before invoking a CLI.

| Engine / route | Tool evidence | Answer |
|---|---|---|
| Claude, existing cage | Grep found no password, Glob found only `.zst`, Read returned binary data | Explicitly could not establish the password; no guess |
| Codex, current prompt on this machine | Executed `zstdcat` and located record 83 | Correct password; depends on installed executable |
| Codex, Node 20 helper instruction | Executed the spike's native Node decoder piped to `rg`; no decompressed file | Correct password with timestamp 01:22 UTC |

The helper route keeps Codex's existing read-only sandbox and can be
packaged for Codex Ask. It does not solve Claude: Read/Grep/Glob neither
execute this decoder nor consume its stdout. No Bash/MCP/network tool was
added to Claude, and no restored agent transcript was materialized.

Options requiring an explicit decision before #30:

1. Keep the complete current requirement: block #30 until a full source
   access route for Claude is accepted and validated. This is the current
   result of the spike.
2. Narrow compressed Ask to Codex CLI, with an explicit unavailable response
   when Claude is pinned for a compressed Codex session. No silent fallback
   and no change to Claude Code sessions. This changes #30's promise that
   every offered responder can ground compressed sessions.
3. Design a temporary full-session **derived text projection** under Sight's
   own temporary storage, readable by Claude's existing tools. This changes
   ARCHITECTURE §6's direct raw-JSONL pointer decision. A normalized projection
   must prove it preserves all answer-relevant source evidence, handles raw
   fallback/carriers, bounds resource use, and is destroyed on source removal,
   cancellation, completion, and startup cleanup. The stored anchor snapshot
   alone is insufficient. This route has not been validated and is not
   approved implicitly by this spike; retaining a full raw JSONL copy remains
   prohibited by #29/#30.

Inlining the entire transcript would change the same pointer decision and
still fails to establish support for arbitrarily large sessions. Running
`codex resume` to restore it would mutate agent state. Adding Bash or a new
MCP tool to Claude would widen the cage. Those are not compliant shortcuts.

The #28 regression suite, including mixed Claude/Codex deletion and the
new `keepSideChats` exception, passed all 202 tests after integration. This
spike changes no shared runtime code, responder flags, or Claude ingestion.
