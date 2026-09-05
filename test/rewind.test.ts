import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { claudeCodeDialect } from '../src/shared/dialects/index.js';
import { Ingester } from '../src/daemon/ingest.js';
import { Store } from '../src/store/store.js';
import { buildTurns } from '../web/src/turns.js';
import type { StoredEvent } from '../src/shared/types.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'claude-code', 'rewind-branch.jsonl');

/** `<parentUuid>` → a line, so a test can describe a shape in a few calls. */
function line(uuid: string, parentUuid: string | null, content: unknown,
    role: 'user' | 'assistant' = 'user'): string {
  return JSON.stringify({
    type: role, uuid, parentUuid, timestamp: '2026-08-31T00:00:00.000Z',
    cwd: '/tmp/proj', message: { role, content },
  }) + '\n';
}
const result = (id: string) => [{ type: 'tool_result', tool_use_id: id, content: 'out' }];
const abandonedIn = (evs: StoredEvent[]) => evs.filter((e) => e.abandoned).map((e) => e.id);

describe('rewind branches (SPIKE_NOTES 2026-08-31)', () => {
  let root: string;
  let file: string;
  let store: Store;
  let ingester: Ingester;
  const adapter = () => claudeCodeAdapter(root);
  const ingest = (text: string) => {
    fs.writeFileSync(file, text);
    ingester.ingestFile(adapter(), file);
    return store.getEvents(SESSION);
  };
  const abandoned = (evs: StoredEvent[]) => abandonedIn(evs);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-rewind-'));
    fs.mkdirSync(path.join(root, '-tmp-proj'));
    file = path.join(root, '-tmp-proj', `${SESSION}.jsonl`);
    store = new Store(':memory:');
    ingester = new Ingester(store, [adapter()]);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('marks the rewound-away branch, keeps the live path (fixture)', () => {
    const events = ingest(fs.readFileSync(FIXTURE, 'utf8'));
    // uuids ...0001-3 are the shared head and the live branch; the abandoned
    // run is the first follow-up wording and everything under it, including a
    // fork nested inside it
    expect(abandoned(events)).toEqual([
      '11111111-0000-0000-0000-000000000002',
      '22222222-0000-0000-0000-000000000002',
      '11111111-0000-0000-0000-000000000003',
      '11111111-0000-0000-0000-000000000004',
      '22222222-0000-0000-0000-000000000003',
    ]);
    // the live path survives whole: shared head + the late-appended branch
    expect(events.filter((e) => !e.abandoned).map((e) => e.id)).toEqual([
      '11111111-0000-0000-0000-000000000001',
      '22222222-0000-0000-0000-000000000001',
      '11111111-0000-0000-0000-000000000005',
      '22222222-0000-0000-0000-000000000004',
    ]);
  });

  it('a session with no rewind has nothing abandoned', () => {
    const events = ingest(
      line('u1', null, 'first') + line('a1', 'u1', 'answer', 'assistant')
      + line('u2', 'a1', 'second') + line('a2', 'u2', 'answer', 'assistant'),
    );
    expect(abandoned(events)).toEqual([]);
  });

  it('parallel tool calls are not a fork: their results share one parent', () => {
    // one assistant message fans out two tool calls; each result parents onto
    // its own call, so the last call's node has two children — a shape that
    // looks exactly like a rewind until tool_results are excluded
    const events = ingest(
      line('u1', null, 'go')
      + line('a1', 'u1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], 'assistant')
      + line('a2', 'a1', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], 'assistant')
      + line('r1', 'a1', result('t1'))
      + line('r2', 'a2', result('t2'))
      + line('a3', 'r2', 'done', 'assistant'),
    );
    expect(abandoned(events)).toEqual([]);
  });

  it('a branch abandoned by a later append is re-marked on the next read', () => {
    const head = line('u1', null, 'first') + line('a1', 'u1', 'answer', 'assistant');
    expect(abandoned(ingest(head + line('u2', 'a1', 'follow-up')))).toEqual([]);
    // the user rewinds and re-asks: the earlier follow-up is dead now, even
    // though it was live when it was stored
    const events = ingest(head + line('u2', 'a1', 'follow-up') + line('u3', 'a1', 'follow-up, edited'));
    expect(abandoned(events)).toEqual(['u2']);
  });

  it('askContext branches: null without forks, else which side the anchor is on', () => {
    const head = line('u1', null, 'first') + line('a1', 'u1', 'answer', 'assistant');
    ingest(head + line('u2', 'a1', 'follow-up'));
    expect(store.askContext(SESSION, 'u2').branches).toBeNull();
    ingest(head + line('u2', 'a1', 'follow-up') + line('u3', 'a1', 'follow-up, edited'));
    expect(store.askContext(SESSION, 'u2').branches).toEqual({ anchorAbandoned: true });
    expect(store.askContext(SESSION, 'u3').branches).toEqual({ anchorAbandoned: false });
    // unknown anchor: branches exist but the anchor can't be placed on one
    const unknown = store.askContext(SESSION, 'nope');
    expect(unknown.branches).toEqual({ anchorAbandoned: false });
    expect(unknown.excerpt).toBe('');
  });

  it('askContext excerpt: role labels, anchor and abandoned marks, distance budget', () => {
    const head = line('u1', null, 'first question') + line('a1', 'u1', 'first answer', 'assistant');
    ingest(head + line('u2', 'a1', 'dead wording') + line('u3', 'a1', 'live wording'));
    const { excerpt } = store.askContext(SESSION, 'u3');
    expect(excerpt).toContain('[user]\nfirst question');
    expect(excerpt).toContain('[assistant]\nfirst answer');
    expect(excerpt).toContain('[user, abandoned branch]\ndead wording');
    expect(excerpt).toContain('[user, contains the ANCHOR]\nlive wording');
    // reading order preserved
    expect(excerpt.indexOf('first question')).toBeLessThan(excerpt.indexOf('dead wording'));

  });

  it('askContext excerpt: per-message truncation; a fat message cannot squeeze the anchor out', () => {
    const head = line('u1', null, 'first question') + line('a1', 'u1', 'first answer', 'assistant');
    ingest(head + line('u2', 'a1', 'y'.repeat(3000)));
    expect(store.askContext(SESSION, 'u2').excerpt).toContain('…[truncated]');
    // smaller rewrite → shrink guard reparses from 0 (rewrite is not append-shaped)
    const fat = 'x'.repeat(1900);
    ingest(head + line('u2', 'a1', fat) + line('u3', 'u2', 'the anchor row'));
    const tight = store.askContext(SESSION, 'u3', 20, 100);
    expect(tight.excerpt).toContain('the anchor row');
    expect(tight.excerpt).not.toContain(fat);
  });

  it('folds each abandoned run whole, ahead of step folding', () => {
    const events = ingest(fs.readFileSync(FIXTURE, 'utf8'));
    const items = buildTurns(events, claudeCodeDialect);
    const kinds = items.map((i) => (i.type === 'event' ? i.event.id : `${i.type}(${i.events.length})`));
    expect(kinds).toEqual([
      '11111111-0000-0000-0000-000000000001',
      '22222222-0000-0000-0000-000000000001',
      'abandoned(5)',
      '11111111-0000-0000-0000-000000000005',
      '22222222-0000-0000-0000-000000000004',
    ]);
  });
});
