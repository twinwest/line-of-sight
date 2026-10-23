import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `sight claude` must survive its best-effort helpers failing (fail-open,
// AGENTS.md). spawn() is faked: a helper that cannot start emits 'error'
// asynchronously, which kills the wrapper — orphaning the agent on the TTY —
// unless something listens for it.
class FakeChild extends EventEmitter {
  unref(): void {}
  kill(): boolean { return true; }
}
const spawned: { cmd: string; child: FakeChild }[] = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string) => {
    const child = new FakeChild();
    spawned.push({ cmd, child });
    return child;
  },
}));

const argv = process.argv;
let server: http.Server | undefined;
afterEach(() => {
  process.argv = argv;
  server?.close();
  server = undefined;
  spawned.length = 0;
  vi.resetModules();
});

/** Run `sight claude` against the given port until the agent is spawned. */
async function wrapOn(port: number): Promise<void> {
  vi.stubEnv('SIGHT_PORT', String(port));
  process.argv = [argv[0]!, 'sight', 'claude'];
  await import('../src/cli/index.js');
  await vi.waitFor(() => expect(spawned.some((s) => s.cmd === 'claude')).toBe(true), { timeout: 3000 });
}

const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

describe('sight claude wrapper (fail-open)', () => {
  it('survives a missing browser opener (no open/xdg-open)', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, pid: 1, startedAt: Date.now(), viewers: 0, viewerSeen: 0 }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    await wrapOn((server.address() as AddressInfo).port);
    const opener = spawned.find((s) => s.cmd === 'open' || s.cmd === 'xdg-open');
    expect(opener).toBeDefined();
    expect(() => opener!.child.emit('error', enoent)).not.toThrow();
  });

  it('survives the daemon failing to spawn', async () => {
    // a port nothing listens on: the wrapper tries to start the daemon
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    await wrapOn(port);
    const daemon = spawned.find((s) => s.cmd === process.execPath);
    expect(daemon).toBeDefined();
    expect(() => daemon!.child.emit('error', enoent)).not.toThrow();
  });
});
