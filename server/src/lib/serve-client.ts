import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

// Serve client static files in production (single-port deployment).
// Extracted from index.ts verbatim — cache-header strategy is load-bearing:
//   1. Content-hashed assets under /assets/ (e.g. index-Lda387IL.js) —
//      the filename changes when content changes, so it's SAFE to cache
//      these for a year with immutable. Repeat visits skip the network
//      entirely; new deploys produce new filenames and get freshly fetched.
//   2. index.html (the SPA shell) — filename never changes but its
//      content references the latest hashed bundle names. MUST always
//      revalidate so a new deploy reaches users immediately instead of
//      being held in browser/edge cache for hours pointing at hashed
//      bundle names that no longer exist on the server (chunk-load errors).
//   3. /cubex.svg, /favicon.* and other top-level public/ files — neither
//      hashed nor critical-to-update. 1 hour public cache is a good middle
//      ground: edges hold them, but a logo swap reaches users same day.
//
// dotfiles: 'deny' rejects any /.env or other hidden-file probes with 403
// instead of serving them. The build doesn't produce dotfiles, but a
// misplaced file in client/dist shouldn't become an exfil channel.
export function serveClientInProduction(app: express.Express) {
  // After build this file is at server/dist/lib/serve-client.js, so the
  // client build sits at ../../../client/dist (one level deeper than the
  // old inline code in dist/index.js — don't copy that path back).
  const clientDist = path.resolve(__dirname, '../../../client/dist');
  if (!fs.existsSync(clientDist)) {
    console.warn(`⚠️  Client dist not found at ${clientDist} — run "npm run build" first`);
    return;
  }

  app.use(express.static(clientDist, {
    dotfiles: 'deny',
    index: false, // we serve index.html ourselves below so we can control its headers
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Vite hashed assets — safe to cache forever.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // Top-level files (cubex.svg, openrouter.png, etc.). Public 1 hour
        // edge + 5 min browser; lets ops swap them mid-day if needed.
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
      }
    },
  }));

  // index.html (and the SPA fallback for client-side routes) must not be
  // cached. Setting no-cache (rather than no-store) lets the browser keep
  // it but ALWAYS revalidate first — fast 304 path on no-deploy, fresh
  // pull immediately after deploy.
  const sendIndex = (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(clientDist, 'index.html'));
  };
  app.get('/', sendIndex);
  app.get('*', (req, res, next) => {
    // Case-insensitive like Express's routing: /API/v1/x is an API path too.
    if (/^\/(api|mcp)(\/|$)/i.test(req.path)) return next();
    sendIndex(req, res);
  });
  console.log(`📦 Serving client from ${clientDist}`);
}
