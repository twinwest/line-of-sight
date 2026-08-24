import fs from 'node:fs';
import { claudeCodeAdapter } from '../adapters/claudeCode.js';
import { SIGHT_DIR, PID_FILE, DB_FILE, LOG_FILE, PORT } from '../shared/paths.js';
import { Store } from '../store/store.js';
import { Ingester } from './ingest.js';
import { buildServer, SseHub } from './server.js';

fs.mkdirSync(SIGHT_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const log = (msg: string) => logStream.write(`${new Date().toISOString()} ${msg}\n`);

const store = new Store(DB_FILE);
const ingester = new Ingester(store, [claudeCodeAdapter()], log);
const hub = new SseHub();
ingester.onEvents((sessionId, events) => hub.broadcast(sessionId, events));
const app = buildServer(store, hub);

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`daemon started on 127.0.0.1:${PORT} (pid ${process.pid})`);
  ingester.start();
} catch (e) {
  log(`daemon failed to start: ${String(e)}`);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  log('daemon stopping');
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
  await ingester.stop().catch(() => {});
  await app.close().catch(() => {});
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${String(e)}`));
