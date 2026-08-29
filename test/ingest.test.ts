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

  it('meta events keep their label; meta writes do not bump activity', () => {
    fs.writeFileSync(file,
      line('u1', 'hi')
      + JSON.stringify({ type: 'system', subtype: 'away_summary', uuid: 'sys1',
          content: 'recap', timestamp: '2026-08-24T01:00:00.000Z' }) + '\n');
    ingester.ingestFile(adapter(), file);
    const meta = store.getEvents(SESSION).find((e) => e.kind === 'meta')!;
    expect((meta.body as { label: string }).label).toBe('system: away_summary');
    // updated_at reflects the message (00:00), not the later meta write (01:00)
    expect(store.getSession(SESSION)!.updatedAt)
      .toBe(Date.parse('2026-08-24T00:00:00.000Z'));
  });

  it('start() scans existing files, ingesting subagents as child sessions', () => {
    fs.writeFileSync(file, line('u1', 'scanned'));
    const subDir = path.join(root, '-tmp-proj', SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), line('sub1', 'subagent'));
    fs.writeFileSync(path.join(subDir, 'agent-x.meta.json'), JSON.stringify({
      agentType: 'Explore', description: 'find the thing', toolUseId: 'toolu_1',
    }));
    ingester.start();
    expect(store.getEvents(SESSION)).toHaveLength(1);
    // the list stays top-level only; the child hangs off its parent
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listChildren(SESSION)).toMatchObject([
      { id: 'agent-x', title: 'Explore · find the thing', toolUseId: 'toolu_1' },
    ]);
    expect(store.getEvents('agent-x')).toHaveLength(1);
    return ingester.stop();
  });

  it('a subagent with no meta.json still lands under its parent', () => {
    const subDir = path.join(root, '-tmp-proj', SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const sub = path.join(subDir, 'agent-y.jsonl');
    fs.writeFileSync(sub, line('sub1', 'orphan run'));
    ingester.ingestFile(adapter(), sub);
    // parent comes from the path, so only the Task-row link is lost
    expect(store.listChildren(SESSION)).toMatchObject([
      { id: 'agent-y', parentId: SESSION, toolUseId: null, title: 'orphan run' },
    ]);
  });

  it('workflow subagents land under the session, tagged with their run id', () => {
    const wfDir = path.join(root, '-tmp-proj', SESSION, 'subagents', 'workflows', 'wf_abc');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'agent-w.jsonl'), line('w1', 'search angle'));
    fs.writeFileSync(path.join(wfDir, 'agent-w.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
    fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), '{"type":"started","agentId":"w"}\n');
    ingester.start();
    expect(store.listChildren(SESSION)).toMatchObject([
      { id: 'agent-w', parentId: SESSION, toolUseId: null, workflowId: 'wf_abc', title: 'search angle' },
    ]);
    expect(store.getSession('journal')).toBeNull();
    return ingester.stop();
  });

  it('a task-notification in the parent ends the child, in either scan order', () => {
    const subDir = path.join(root, '-tmp-proj', SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), line('sub1', 'child work'));
    fs.writeFileSync(path.join(subDir, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }));
    fs.writeFileSync(file, line('u1', 'go')
      + line('u2', '<task-notification><tool-use-id>toolu_1</tool-use-id><status>completed</status></task-notification>'));
    // parent first
    ingester.ingestFile(adapter(), file);
    ingester.ingestFile(adapter(), path.join(subDir, 'agent-x.jsonl'));
    expect(store.listChildren(SESSION)[0]!.endedAt).toBe(Date.parse('2026-08-24T00:00:00.000Z'));
    // child first
    const s2 = new Store(':memory:');
    const i2 = new Ingester(s2, [adapter()]);
    i2.ingestFile(adapter(), path.join(subDir, 'agent-x.jsonl'));
    expect(s2.listChildren(SESSION)[0]!.endedAt).toBeNull();
    i2.ingestFile(adapter(), file);
    expect(s2.listChildren(SESSION)[0]!.endedAt).toBe(Date.parse('2026-08-24T00:00:00.000Z'));
  });

  it('a Workflow run\'s notification ends every child under its run id', () => {
    const wfDir = path.join(root, '-tmp-proj', SESSION, 'subagents', 'workflows', 'wf_9');
    fs.mkdirSync(wfDir, { recursive: true });
    for (const id of ['a', 'b']) fs.writeFileSync(path.join(wfDir, `agent-${id}.jsonl`), line(id, 'angle'));
    const ack = JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-08-24T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'launched' }] },
      toolUseResult: { status: 'async_launched', taskType: 'local_workflow', runId: 'wf_9' } }) + '\n';
    fs.writeFileSync(file, line('u1', 'go') + ack
      + line('u3', '<task-notification><tool-use-id>toolu_w</tool-use-id><status>completed</status></task-notification>'));
    ingester.start();
    expect(store.listChildren(SESSION).map((c) => c.endedAt)).toEqual([1787529600000, 1787529600000]);
    return ingester.stop();
  });

  it('sibling files that are not transcripts stay out', () => {
    const a = adapter();
    const dir = path.join(root, '-tmp-proj', SESSION, 'subagents');
    expect(a.matches(path.join(dir, 'agent-x.meta.json'))).toBe(false);
    expect(a.matches(path.join(root, '-tmp-proj', SESSION, 'memory', 'notes.md'))).toBe(false);
    // right filename, wrong depth
    expect(a.matches(path.join(root, '-tmp-proj', 'subagents', 'agent-x.jsonl'))).toBe(false);
  });
});
