import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { Ingester } from '../src/daemon/ingest.js';
import { Store } from '../src/store/store.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function line(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user', uuid, timestamp: '2026-08-24T00:00:00.000Z',
    cwd: '/tmp/proj', message: { role: 'user', content: text },
  }) + '\n';
}

describe('incremental ingest', () => {
  let root: string;
  let file: string;
  let store: Store;
  let ingester: Ingester;
  const adapter = () => claudeCodeAdapter(root);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-test-'));
    fs.mkdirSync(path.join(root, '-tmp-proj'));
    file = path.join(root, '-tmp-proj', `${SESSION}.jsonl`);
    store = new Store(':memory:');
    ingester = new Ingester(store, [adapter()]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appended lines produce new events and advance the offset', () => {
    fs.writeFileSync(file, line('u1', 'first prompt'));
    ingester.ingestFile(adapter(), file);
    expect(store.getEvents(SESSION)).toHaveLength(1);
    const offset1 = store.getSessionByPath(file)!.byteOffset;
    expect(offset1).toBe(fs.statSync(file).size);

    fs.appendFileSync(file, line('u2', 'second prompt'));
    ingester.ingestFile(adapter(), file);
    const events = store.getEvents(SESSION);
    expect(events).toHaveLength(2);
    expect(events[1]!.id).toBe('u2');
    expect(store.getSessionByPath(file)!.byteOffset).toBe(fs.statSync(file).size);
    expect(store.getSession(SESSION)).toMatchObject({
      title: 'first prompt', projectDir: '/tmp/proj', messageCount: 2,
    });
  });

  it('a partial last line is not consumed until the newline arrives', () => {
    fs.writeFileSync(file, line('u1', 'hello') + '{"type":"user","uuid":"u2"');
    ingester.ingestFile(adapter(), file);
    expect(store.getEvents(SESSION)).toHaveLength(1);
    const offset = store.getSessionByPath(file)!.byteOffset;
    expect(offset).toBeLessThan(fs.statSync(file).size);

    fs.appendFileSync(file, ',"message":{"role":"user","content":"done"},"timestamp":"2026-08-24T00:00:01.000Z"}\n');
    ingester.ingestFile(adapter(), file);
    const events = store.getEvents(SESSION);
    expect(events).toHaveLength(2);
    expect(events[1]!.id).toBe('u2');
  });

  it('a truncated file triggers a clean re-parse from zero', () => {
    fs.writeFileSync(file, line('u1', 'one') + line('u2', 'two'));
    ingester.ingestFile(adapter(), file);
    expect(store.getEvents(SESSION)).toHaveLength(2);

    fs.writeFileSync(file, line('u3', 'rewritten'));
    ingester.ingestFile(adapter(), file);
    const events = store.getEvents(SESSION);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('u3');
    expect(store.getSession(SESSION)!.title).toBe('rewritten');
  });

  it('start() scans existing files and skips subagent/memory files', () => {
    fs.writeFileSync(file, line('u1', 'scanned'));
    const subDir = path.join(root, '-tmp-proj', SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), line('sub1', 'subagent'));
    ingester.start();
    expect(store.getEvents(SESSION)).toHaveLength(1);
    expect(store.listSessions()).toHaveLength(1);
    return ingester.stop();
  });
});
