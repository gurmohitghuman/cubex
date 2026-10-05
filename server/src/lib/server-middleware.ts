import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

// No CORS middleware: the browser only ever talks to its own origin. In
// production the server serves the built client on the same port, and in dev
// Vite proxies /api and /mcp (client/vite.config.ts). Without CORS headers,
// browsers refuse cross-origin reads, which is the safe default.
export const applyServerMiddleware = (app: express.Express, opts: { isProduction: boolean }) => {
  // Helmet: sane defaults (HSTS, X-Frame-Options, etc.). The CSP is production
  // only because Vite's dev server injects inline scripts.
  //
  // script-src is 'self' only: no third-party scripts and no 'unsafe-inline'.
  // style-src keeps 'unsafe-inline' for the inline styles React and AG Grid set.
  // Google Fonts: the stylesheet is on fonts.googleapis.com and the .woff2 files
  // it references are on fonts.gstatic.com; without both, text silently falls
  // back to system fonts.
  const GFONTS_CSS = 'https://fonts.googleapis.com';
  const GFONTS_FILES = 'https://fonts.gstatic.com';
  app.use(helmet({
    contentSecurityPolicy: opts.isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'", GFONTS_CSS],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameSrc: ["'self'"],
            fontSrc: ["'self'", 'data:', GFONTS_FILES],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            // Helmet's default adds upgrade-insecure-requests, which would make a
            // plain-HTTP install (http://192.168.1.10:3002) request its own
            // scripts over https:// and render a blank page.
            upgradeInsecureRequests: null,
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    // HSTS for this host only. Helmet's default adds includeSubDomains, which
    // would pin every subdomain to HTTPS for a year if Cubex is served from an
    // apex domain. Browsers ignore the header over plain HTTP.
    strictTransportSecurity: { maxAge: 15_552_000, includeSubDomains: false },
  }));

  app.use(cookieParser());

  // Surfaces that own their body parsing: the public webhook endpoint (512 KB
  // cap, rejects cheaply BEFORE parsing), the token-authed /api/v1 + /mcp
  // (authenticate the Bearer token first, then a tighter route-level parser),
  // and /api/auth (JSON only, 4 KB — see routes/auth.ts).
  // A route-level express.json does NOT govern if a global parser runs first —
  // the global one consumes the body at 32 MB — so these prefixes skip every
  // global parser. Compare LOWERCASED: Express routing is case-insensitive, so
  // /API/webhooks/... still reaches the webhook router.
  const ownsBodyParsing = (rawPath: string) => {
    const p = rawPath.toLowerCase();
    return p === '/api/webhooks' || p.startsWith('/api/webhooks/')
      || p === '/api/v1' || p.startsWith('/api/v1/')
      || p === '/mcp' || p.startsWith('/mcp/')
      || p === '/api/auth' || p.startsWith('/api/auth/');
  };

  // 32 MB end-to-end JSON limit for everything else (autosave batches, bulk
  // edits). CSV uploads are multipart and go through multer's own size cap.
  const globalJson = express.json({ limit: '32mb' });
  const globalUrlencoded = express.urlencoded({ extended: true, limit: '32mb' });
  app.use((req, res, next) => (ownsBodyParsing(req.path) ? next() : globalJson(req, res, next)));
  app.use((req, res, next) => (ownsBodyParsing(req.path) ? next() : globalUrlencoded(req, res, next)));
};
