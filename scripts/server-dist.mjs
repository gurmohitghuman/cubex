// Finishes the server build after tsc: copies the SQL migrations next to the compiled code and marks
// server/dist as CommonJS (the root package.json says "type": "module", tsc emits require()).
// Plain Node, so it runs the same from cmd.exe, PowerShell and sh.
// Usage: node scripts/server-dist.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'server', 'dist');
const from = path.join(root, 'server', 'src', 'db', 'migrations');
const to = path.join(dist, 'db', 'migrations');

// Start empty, so a migration renamed or removed in src never lingers in dist.
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(from)) {
  if (name.endsWith('.sql')) fs.copyFileSync(path.join(from, name), path.join(to, name));
}
fs.writeFileSync(path.join(dist, 'package.json'), '{"type":"commonjs"}\n');
