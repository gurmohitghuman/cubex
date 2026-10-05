import express from 'express';
import Database from 'better-sqlite3';
import { db } from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';
import { redactSecrets } from '../lib/http-request';
import { JOBS_DB_PATH } from '../queue';

// Liveness/readiness probe. Mounted at /api/health in index.ts.
const router = express.Router();

// Liveness/readiness probe (the Docker HEALTHCHECK polls it). Returning ok for
// a corrupted DB or a broken encryption key would mask outages. We probe what would actually
// break the app: DB reachable, encryption keys still working.
router.get('/', (_req, res) => {
  const checks: { db: 'ok' | 'fail'; jobsDb: 'ok' | 'fail'; crypto: 'ok' | 'fail' } = {
    db: 'fail', jobsDb: 'fail', crypto: 'fail',
  };
  try {
    db.prepare('SELECT 1').get();
    checks.db = 'ok';
  } catch (err) {
    console.error('Health check: DB probe failed:', redactSecrets(String(err)));
  }
  // jobs.db probe: open a SEPARATE read-only handle, run SELECT 1, close.
  // Open-per-probe (not a long-lived connection) so we don't add a writer to
  // a database Sidequest worker threads own. If jobs.db is corrupted or
  // missing, every background enqueue silently fails — we'd rather flag the
  // outage at the health endpoint than mask it.
  let jobsProbe: import('better-sqlite3').Database | null = null;
  try {
    jobsProbe = new Database(JOBS_DB_PATH, { readonly: true, fileMustExist: true });
    jobsProbe.prepare('SELECT 1').get();
    checks.jobsDb = 'ok';
  } catch (err) {
    console.error('Health check: jobs.db probe failed:', redactSecrets(String(err)));
  } finally {
    try { jobsProbe?.close(); } catch { /* best-effort */ }
  }
  try {
    // Round-trip a sentinel through encrypt/decrypt — catches missing/wrong
    // APP_ENCRYPTION_KEY without depending on stored DB values.
    if (decrypt(encrypt('health')) === 'health') checks.crypto = 'ok';
  } catch (err) {
    console.error('Health check: crypto probe failed:', redactSecrets(String(err)));
  }
  const ok = checks.db === 'ok' && checks.jobsDb === 'ok' && checks.crypto === 'ok';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

export default router;
