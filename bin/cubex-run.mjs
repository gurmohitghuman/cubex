// Keeps the Cubex server running on Windows. bin/cubex-service.ps1 starts it with the private Node (from the logon
// task, or as a hidden background process): <home>\node\node.exe <home>\app\bin\cubex-run.mjs. It reads config.env
// (KEY=value, parsed like cubex.ps1 does, never executed), runs server\dist\index.js with its output appended to
// logs\cubex.log (moved to cubex.log.1 past 10 MB), and starts the server again after a crash, waiting 5 s, then
// longer each time up to a minute. Only Node stays running in the background, no PowerShell.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.dirname(app);
const config = path.join(home, 'config.env');
const logFile = path.join(home, 'logs', 'cubex.log');
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
const STEADY_MS = 120_000; // a server that ran this long was fine: the next crash waits FIRST_DELAY_MS again

let fd = -1;
let size = 0;
let nextRotate = LOG_MAX_BYTES;
function openLog() {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fd = fs.openSync(logFile, 'a');
  size = fs.fstatSync(fd).size;
  nextRotate = Math.max(LOG_MAX_BYTES, size + 1);
}
function rotateLog() {
  fs.closeSync(fd);
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // Open elsewhere (`cubex logs` reading it, say): keep writing, try again after another megabyte.
  }
  openLog();
  if (size >= LOG_MAX_BYTES) nextRotate = size + 1024 * 1024;
}
function log(chunk) {
  try {
    if (size >= nextRotate) rotateLog();
    fs.writeSync(fd, chunk);
    size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  } catch {
    // A full disk or a locked file must not stop the server it watches.
  }
}
const say = (text) => log(`${text}\r\n`);

// config.env into this process's environment (case-insensitive on Windows, as cubex.ps1's is).
function importConfig() {
  let text = '';
  try {
    text = fs.readFileSync(config, 'utf8');
  } catch {
    // No config.env: the defaults below.
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    const eq = line.indexOf('=');
    if (line === '' || line.startsWith('#') || eq < 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  if (!process.env.PORT) process.env.PORT = '3002';
  if (!process.env.HOST) process.env.HOST = '127.0.0.1';
  const port = Number(process.env.PORT);
  if (!/^[0-9]+$/.test(process.env.PORT) || port < 1 || port > 65535) {
    say(`Error: PORT in ${config} must be a number from 1 to 65535.`);
    process.exit(1);
  }
  // A relative DB_PATH means inside the Cubex folder, never inside the app folder an update replaces.
  const db = process.env.DB_PATH;
  process.env.DB_PATH = !db ? path.join(home, 'data', 'cubex.db') : path.isAbsolute(db) ? db : path.join(home, db);
  process.env.NODE_ENV = 'production';
}

let server = null;
let stopping = false;
let quickFailures = 0;

function startServer() {
  const startedAt = Date.now();
  let done = false;
  server = spawn(process.execPath, ['server\\dist\\index.js'], {
    cwd: app, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout?.on('data', log);
  server.stderr?.on('data', log);
  const ended = (code, why) => {
    if (done) return;
    done = true;
    server = null;
    if (stopping) process.exit(0);
    if (code === 0) process.exit(0); // the server shut itself down on purpose
    quickFailures = Date.now() - startedAt >= STEADY_MS ? 0 : quickFailures + 1;
    const wait = Math.min(FIRST_DELAY_MS * 2 ** Math.max(0, quickFailures - 1), MAX_DELAY_MS);
    say(`Cubex stopped (${why}); starting it again in ${Math.round(wait / 1000)} seconds.`);
    setTimeout(startServer, wait);
  };
  server.on('error', (err) => ended(1, `couldn't start: ${err.message}`));
  server.on('close', (code, signal) => ended(code, signal ? `ended by ${signal}` : `exit code ${code}`));
}

function stop() {
  stopping = true;
  if (server) server.kill();
  else process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, stop);

openLog();
importConfig();
startServer();
