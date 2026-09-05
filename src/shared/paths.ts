import os from 'node:os';
import path from 'node:path';

export const SIGHT_DIR = path.join(os.homedir(), '.sight');
export const PID_FILE = path.join(SIGHT_DIR, 'daemon.pid');
export const DB_FILE = path.join(SIGHT_DIR, 'sight.db');
export const LOG_FILE = path.join(SIGHT_DIR, 'daemon.log');
export const PORT = Number(process.env.SIGHT_PORT) || 2020;
