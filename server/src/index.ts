import dotenv from 'dotenv';
import path from 'node:path';
// Tighten the process umask BEFORE any file gets created. 0o077 means files
// land at 0o600 by default and directories at 0o700, so:
//   - cubex.db, cubex.db-wal, cubex.db-shm  (created by SQLite later) → 0o600
//   - server/data/ subdirs (if any get created at runtime) → 0o700
//   - .jwt-secret, .encryption-key (lib/instance-secret.ts) → 0o600
// Without this, sibling files created after the explicit chmod in lib/db.ts
// (like the -wal file that SQLite makes on first write) inherit umask 0o022
// and land world-readable, leaking the contents the explicit chmod was meant
// to protect.
process.umask(0o077);

// Load env from server/.env regardless of where the process was launched from.
// `npm run dev` runs from the project root, so a bare `dotenv/config` would miss this file.
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

import express from 'express';
import { runMigrations } from './db/migrate';
import { assertEncryptionConfigured } from './lib/crypto';
import { applyServerMiddleware } from './lib/server-middleware';
import { serveClientInProduction } from './lib/serve-client';
import { startBackground, installShutdownHandlers } from './lib/server-lifecycle';
import { resetOrphanedRuns } from './lib/orphan-runs';
import { redactSecrets } from './lib/http-request';
import { createAccountFromEnv } from './services/account';
import { resumeColumnPurges } from './lib/column-purge';
import { resumeRunCleanups } from './lib/run-placeholders';
import { resumeSorts } from './services/sheet-sort';
import { resumeImports } from './lib/import-undo';
import authRoutes from './routes/auth';
import tablesRoutes from './routes/tables';
import tableSheetsRoutes from './routes/tables-sheets';
import sheetsRoutes from './routes/sheets';
import aiRoutes from './routes/ai';
import httpRoutes from './routes/http';
import settingsRoutes from './routes/settings';
import webhooksPublicRoutes from './routes/webhooks-public';
import fileLinkRoutes from './routes/file-links';
import apiV1Routes from './routes/api-v1';
import mcpRoutes from './routes/mcp';
import healthRoutes from './routes/health';
import { RUN_CLEANUP_STALE_MINUTES, RUN_CLEANUP_SWEEP_MS } from './lib/constants';
import { prepareUploadDir } from './lib/uploads';

// Run database migrations on boot before anything else.
runMigrations();

// Load (or, on first boot, generate) the encryption key now: a malformed
// APP_ENCRYPTION_KEY fails here instead of on the first saved API key, and the
// key file exists before any worker thread could race to create it.
try {
  assertEncryptionConfigured();
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
}

// Recover runs that were mid-flight when the previous process died (crash /
// SIGKILL / redeploy). resetOrphanedRuns flips them 'pending' + preserves their
// ⏳ placeholders (DB-only — the queue isn't up yet); startBackground re-enqueues
// the returned runs once Sidequest has started, so they RESUME instead of being
// lost. Must run AFTER migrations (worker_generation column) and BEFORE
// startBackground.
const recoveredRuns = resetOrphanedRuns();
// Uploads a restart cut short are useless now (lib/uploads.ts).
prepareUploadDir();

const app = express();
const PORT = Number(process.env.PORT) || 3002;
// Listen address. Unset = every interface, which Docker and Coolify need; the
// one-command installer sets 127.0.0.1 so only the same computer can open Cubex.
const HOST = process.env.HOST || undefined;
const isProduction = process.env.NODE_ENV === 'production';
if (!HOST && !isProduction) {
  console.warn('⚠️  HOST is not set, so Cubex listens on every network interface. Set HOST=127.0.0.1 to keep it on this computer.');
}

applyServerMiddleware(app, { isProduction });

// Cache-Control: private, no-store on every API response.
//   - private: no shared cache (CDNs, corp proxies) should store it
//   - no-store: don't put it in the browser BFCache either — closes the
//     "back button shows stale dashboard after logout" class of bug at the
//     transport layer (we already patched the visible-state half of it in
//     PrivateRoute via the pageshow event)
// SSE streams set their own Cache-Control: no-cache further down the
// chain in lib/sse.ts; that 'no-cache' wins over our 'no-store' because
// it's set later in the response lifecycle. Both are correct for SSE.
const noStore = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};
app.use('/api', noStore);
app.use('/mcp', noStore); // MCP tool results carry sheet data too

// PUBLIC webhook ingestion — mounted BEFORE the authenticated routes and with NO
// authenticateToken. The token in the path is the capability. The global JSON
// parser is skipped for this prefix (see applyServerMiddleware) so the router's
// own 512KB cap governs. Cache-Control: private, no-store from the /api handler
// above still applies.
app.use('/api/webhooks', webhooksPublicRoutes);
// PUBLIC one-time file links an MCP agent gets for moving a CSV in or out
// (routes/file-links.ts): likewise no auth, the token in the path is the
// capability, and the global parsers skip the prefix so uploads stream to disk.
app.use('/api/files', fileLinkRoutes);

// Programmatic surfaces — personal-access-token auth ONLY (no session cookies).
// The global JSON parsers are skipped for both prefixes (see
// applyServerMiddleware) so Bearer auth runs before any body parse.
app.use('/api/v1', apiV1Routes);
app.use('/mcp', mcpRoutes);

// API routes (authenticated inside each sub-router)
app.use('/api/auth', authRoutes);
app.use('/api/tables/:tableId/sheets', tableSheetsRoutes);
app.use('/api/tables', tablesRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/http', httpRoutes);
app.use('/api/settings', settingsRoutes);

// Liveness/readiness probe (see routes/health.ts).
app.use('/api/health', healthRoutes);

// Serve client static files in production (single-port deployment).
// Cache-header strategy + dotfile denial live in lib/serve-client.ts.
if (isProduction) serveClientInProduction(app);

// An unknown API path answers JSON like every other API error, not Express's
// HTML "Cannot GET" page (the client fallback above skips these prefixes).
app.use(['/api', '/mcp'], (_req, res) => { res.status(404).json({ error: 'Not found' }); });

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Redact tokens/keys before logging — a bubbled error.message could
  // include the upstream request's Bearer header or sk-... key verbatim
  // (especially from the AI/HTTP runners' fetch failures).
  console.error('Error:', redactSecrets(err.stack || err.message || String(err)));
  // Never leak stack/message to the client, even in dev. The dev branch used to
  // return err.stack + err.message in the response, which (a) leaked internal
  // paths + library versions, and (b) made a Docker image launched without
  // NODE_ENV=production into a live information-disclosure target.
  res.status(500).json({ error: 'Something went wrong!' });
});

function startServer(): void {
  const onListening = () => {
    console.log(`🚀 Cubex server running on http://localhost:${PORT}${HOST ? ` (listening on ${HOST})` : ''}`);
    startBackground(recoveredRuns);
  };
  const server = HOST ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);

  // Reverse proxies and CDNs keep idle upstream sockets open for a while (60s
  // on many); Node's default keepAliveTimeout is 5s. When a proxy reuses a socket
  // Node just closed, the user sees a random 502, so outlast the proxy.
  // headersTimeout MUST exceed keepAliveTimeout or Node treats it as a
  // misconfiguration. requestTimeout=0 is intentional — SSE streams
  // (ai/http run progress) are long-lived by design and must not be killed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;

  installShutdownHandlers(server);
}

// INITIAL_PASSWORD (optional) creates the account BEFORE the server listens, so
// an install that is public from its first second (Coolify, any hosting panel)
// is never open to first-run setup. See services/account.ts.
createAccountFromEnv().then((result) => {
  // Needed only here: keep it out of the environment the job workers inherit.
  delete process.env.INITIAL_PASSWORD;
  if (result === 'created') console.log('🔐 Account created from INITIAL_PASSWORD');
  if (result === 'exists') console.log('ℹ️  INITIAL_PASSWORD ignored: the account already exists (it only applies on first boot)');
  startServer();
  // Heavy jobs a restart interrupted finish in the background (migrations 003,
  // 004). Each marks its sheet busy synchronously, before the first request.
  resumeSorts();
  resumeImports();
  resumeColumnPurges();
  resumeRunCleanups();
  setInterval(() => resumeRunCleanups(RUN_CLEANUP_STALE_MINUTES), RUN_CLEANUP_SWEEP_MS).unref();
}, (err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
