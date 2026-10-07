// Enrichment (treg.to) constants, split out of constants.ts (200-line guardrail).
// Import via './constants', which re-exports this module.
import { envInt } from './env-int';

// treg's API. An operator may point Cubex at a self-hosted treg, and the e2e
// harness at a mock; it never comes from user input, so (like OpenRouter's
// fixed host) the SSRF guard isn't involved.
export const TREG_BASE_URL = (process.env.TREG_BASE_URL || 'https://treg.to').replace(/\/+$/, '');
// Sent as X-Treg-Client on every call: attribution only (treg's client_identity.py).
export const TREG_CLIENT_SLUG = 'cubex';
export const TREG_APP_URL = 'https://treg.to/app';
// A catalog tool id (treg.people.email.find, leadmagic.x.personal-email-finder):
// no "/" or ":", so a tool id can never become treg's URL-prefix form.
export const TREG_TOOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

// Catalog and account reads: tool search and details, key test, balance.
export const TREG_META_TIMEOUT_MS = 10_000;
export const TREG_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
export const TREG_CATALOG_CACHE_MAX_ENTRIES = 200;
export const TREG_SEARCH_LIMIT = 100;     // treg's own maximum; hidden kinds are filtered after
export const ENRICH_SEARCH_RESULTS = 25;  // what the drawer and search_enrichments show

// Tool calls. A waterfall runs providers one after another (treg allows each
// upstream phase 180 s idle) plus up to 60 s waiting on a provider that answers
// later, so it gets a longer clock than a single tool.
export const TREG_CALL_TIMEOUT_MS = 120_000;
export const TREG_ROUTED_CALL_TIMEOUT_MS = 600_000;
// treg refuses metered answers above this with 502 response_buffer_limit (unbilled).
export const TREG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Spend. The daily default matches migration 010's column default.
export const ENRICH_DEFAULT_DAILY_LIMIT_MICRO = 10_000_000;
// A computed default per-row cap never exceeds treg's own $1 waterfall default.
export const ENRICH_MAX_DEFAULT_ROW_CAP_USD = 1;

// Runs.
export const ENRICH_DEFAULT_CONCURRENCY = envInt('ENRICH_DEFAULT_CONCURRENCY', 5);
export const ENRICH_TEST_ROWS = 5;
export const ENRICH_VERIFY_MAX_FINDS = 3;
export const ENRICH_DUPLICATE_THRESHOLD = 2;
export const ENRICH_UNREACHABLE_PAUSE_AFTER = 5;
export const ENRICH_SATURATION_RETRIES = 3;
// treg answers 409 while the first call with a key is still running, and turns a
// silent one into a stored 410 after 15 minutes (idempotency.py stale lease).
export const ENRICH_IDEMPOTENCY_WAIT_MS = 15 * 60 * 1000;
export const ENRICH_STORED_RAW_MAX_BYTES = envInt('ENRICH_STORED_RAW_MAX_BYTES', 16 * 1024);
export const ENRICH_LIST_MAX_ITEMS = 100;
// Waits before retrying a call with the same key: treg busy or a key still in
// flight, treg unreachable, a provider's own rate limit.
export const ENRICH_RETRY_MS = 5_000;
export const ENRICH_UNREACHABLE_RETRY_MS = 10_000;
export const ENRICH_PROVIDER_RATE_RETRY_MS = 15_000;

// Settings bounds for the key and the daily limit.
export const TREG_KEY_MAX_CHARS = 512;
export const ENRICH_DAILY_LIMIT_MIN_MICRO = 10_000;        // $0.01
export const ENRICH_DAILY_LIMIT_MAX_USD = 100_000;

// Background loops in the API process.
export const AUTORUN_SWEEP_MS = 15_000;
export const AUTORUN_MAX_ROWS = 500;
export const AUTORUN_HTTP_DEFAULT_DAILY_ROWS = 500;
export const AUTORUN_USER_YIELD_MS = 2 * 60 * 1000;
export const LIST_DRAIN_MS = 5_000;

// The drawer's "Popular" jobs. Ids the live catalog no longer has are hidden.
export interface FeaturedJob { id: string; title: string; blurb: string; preset?: 'verified_email' }
export const ENRICH_FEATURED: FeaturedJob[] = [
  { id: 'treg.people.email.find', title: 'Verified work email', preset: 'verified_email',
    blurb: 'Finds an email, checks it, and tries other providers until one passes.' },
  { id: 'treg.people.phone.find', title: 'Find phone number', blurb: 'Finds a phone number from a name and company, or a LinkedIn URL.' },
  { id: 'treg.people.email.verify', title: 'Verify email', blurb: 'Checks whether a mailbox accepts mail before you send.' },
  { id: 'treg.people.enrich', title: 'Person from LinkedIn or email', blurb: 'Fills in name, title and company for a person.' },
  { id: 'treg.companies.enrich', title: 'Company from domain', blurb: 'Fills in size, industry and location for a company.' },
  { id: 'treg.people.search', title: 'People at a company', blurb: 'Adds the people it finds as rows in another sheet.' },
  { id: 'treg.companies.search', title: 'Find companies', blurb: 'Adds the companies it finds as rows in another sheet.' },
  { id: 'treg.google.serp.organic', title: 'Google search results', blurb: 'Top Google results for a search, per row.' },
];
