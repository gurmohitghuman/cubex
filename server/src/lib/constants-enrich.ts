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
// A tool's /access for the team (Set up's provider badges): read on each drawer
// open, plus one read per waterfall provider treg's plan leaves out.
export const TREG_ACCESS_CACHE_MS = 5 * 60 * 1000;
export const TREG_ACCESS_CACHE_MAX_ENTRIES = 100;

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
// Rows at once when a run doesn't say: treg itself has no concurrency limit
// (providers' own limits come back as 429s the waterfall moves past).
export const ENRICH_DEFAULT_CONCURRENCY = envInt('ENRICH_DEFAULT_CONCURRENCY', 20);
export const ENRICH_TEST_ROWS = 5;
// The newest rows the drawer's run screens show (lean status), and the spend
// card's choice of windows in days.
export const ENRICH_STATUS_LATEST = 5;
export const ENRICH_SPEND_WINDOWS = [7, 30, 90] as const;
export const ENRICH_SPEND_TOP_COLUMNS = 20;
export const ENRICH_VERIFY_MAX_FINDS = 3;
export const ENRICH_DUPLICATE_THRESHOLD = 2;
export const ENRICH_UNREACHABLE_PAUSE_AFTER = 5;
export const ENRICH_SATURATION_RETRIES = 3;
// treg's "too busy" Retry-After is waited out, but never longer than this.
export const ENRICH_SATURATION_MAX_MS = 120_000;
// treg answers 409 while the first call with a key is still running, and turns a
// silent one into a stored 410 after 15 minutes (idempotency.py stale lease).
export const ENRICH_IDEMPOTENCY_WAIT_MS = 15 * 60 * 1000;
// How long a batch's hold on the daily limit still counts after its run left
// that worker (paused, cancelled, resumed): the calls it had out still finish
// and bill, and none outlasts the longest call clock (services/enrich-holds.ts).
export const ENRICH_HOLD_GRACE_SEC = TREG_ROUTED_CALL_TIMEOUT_MS / 1000 + 60;
export const ENRICH_STORED_RAW_MAX_BYTES = envInt('ENRICH_STORED_RAW_MAX_BYTES', 16 * 1024);
// List results into rows: results kept per source row (treg's own cap on a
// list page), the default ("results per row", the price dial), and how many
// fields of a result Set up offers.
export const ENRICH_LIST_MAX_ITEMS = 100;
export const ENRICH_LIST_DEFAULT_ITEMS = 10;
export const ENRICH_LIST_MAX_FIELDS = 100;
export const ENRICH_LIST_MAX_COPY = 20;
// The stored answers read to offer fields (the newest results of the column).
export const ENRICH_LIST_FIELD_SAMPLE = 20;
// Failed attempts to add a journal row's results before it's marked failed.
export const ENRICH_LIST_DRAIN_ATTEMPTS = 5;
// Waits before retrying a call with the same key: treg busy or a key still in
// flight, treg unreachable, a provider's own rate limit.
export const ENRICH_RETRY_MS = envInt('ENRICH_RETRY_MS', 5_000);
export const ENRICH_UNREACHABLE_RETRY_MS = 10_000;
// The first "no answer" of a call (often a reused connection the far end had
// just closed) is retried sooner.
export const ENRICH_FIRST_RETRY_MS = 1_000;
// A provider's 429 (alone, or every provider of a waterfall) costs nothing and
// frees the key at treg, so the row asks again: the wait doubles from the first
// (or the provider's Retry-After) up to the most, half of it random so the
// run's rows don't all ask at once. A free provider on treg's own key can be
// shared by all of treg (ContactOut's verify: about 20 calls a minute).
export const ENRICH_PROVIDER_RATE_RETRY_MS = envInt('ENRICH_PROVIDER_RATE_RETRY_MS', 15_000);
export const ENRICH_PROVIDER_RATE_RETRY_MAX_MS = envInt('ENRICH_PROVIDER_RATE_RETRY_MAX_MS', 120_000);
export const ENRICH_PROVIDER_RATE_RETRIES = 5;
// A provider's 5xx (or no answer from it) is asked again this many times.
export const ENRICH_PROVIDER_RETRIES = 2;

// Settings bounds for the key and the daily limit.
export const TREG_KEY_MAX_CHARS = 512;
export const ENRICH_DAILY_LIMIT_MIN_MICRO = 10_000;        // $0.01
export const ENRICH_DAILY_LIMIT_MAX_USD = 100_000;

// Background loops in the API process. Auto-run looks for rows to fill every
// AUTORUN_SWEEP_MS (tests shorten it) and takes at most AUTORUN_MAX_ROWS a run.
export const AUTORUN_SWEEP_MS = envInt('AUTORUN_SWEEP_MS', 15_000);
export const AUTORUN_MAX_ROWS = 500;
export const AUTORUN_HTTP_DEFAULT_DAILY_ROWS = 500;
export const AUTORUN_HTTP_MAX_DAILY_ROWS = 1_000_000;
export const AUTORUN_DEFAULT_DAILY_CAP_USD = 5;
// An agent's append answers with the auto-runs it sets off (auto_run); pricing
// them reads treg's catalog, which waits at most this long (then no estimate).
export const AUTORUN_NOTICE_PRICE_MS = 3_000;
// A stored answer an agent reads (get_run_results include_answers) is cut to
// this many characters of JSON, largest parts first, so a page stays readable
// in its context (agents' context is counted in characters, not bytes).
export const AGENT_ANSWER_MAX_CHARS = 32 * 1024;
// A sort, row delete or column change refused because auto-run was busy holds
// new auto-runs on that sheet this long, so the user's retry goes through.
export const AUTORUN_USER_YIELD_MS = envInt('AUTORUN_USER_YIELD_MS', 2 * 60 * 1000);
// Stops treg may clear on its own (unreachable, balance, its own caps) are retried this long after.
export const AUTORUN_RETRY_MS = envInt('AUTORUN_RETRY_MS', 5 * 60 * 1000);
// Rows read per page while looking for rows to fill.
export const AUTORUN_SCAN_PAGE = 2_000;
// List results waiting in the journal are added as rows this often.
export const ENRICH_LIST_DRAIN_MS = envInt('ENRICH_LIST_DRAIN_MS', 5_000);
// Journal rows read per destination per drain round (each is added in its own transaction).
export const ENRICH_LIST_DRAIN_BATCH = 200;
// A drain round counts a destination's rows once and carries the number on;
// this close to the row limit it counts again (rows appended meanwhile count).
export const ENRICH_LIST_RECOUNT_SLACK = 10_000;

// Stored answers (services/answer-prune.ts): ended runs that enriched rows
// again are looked for this often; results are read and pruned this many at a time.
export const ANSWER_PRUNE_SWEEP_MS = envInt('ANSWER_PRUNE_SWEEP_MS', 30_000);
export const ANSWER_PRUNE_SLICE = 500;
// Settings' "Prune details older than 90 days", and how old the stored
// answers' size may get before opening Settings counts it again.
export const STORED_ANSWERS_PRUNE_DAYS = 90;
export const STORED_ANSWERS_RECOUNT_MS = 60 * 60 * 1000;
// Found answers reused across runs (services/enrich-reuse.ts): days by default
// and at most (0 turns it off), and how long an estimate looks for rows that
// would reuse one before it answers with what it counted so far.
export const ENRICH_REUSE_DAYS_DEFAULT = 30;
export const ENRICH_REUSE_DAYS_MAX = 365;
export const ENRICH_REUSE_COUNT_MS = envInt('ENRICH_REUSE_COUNT_MS', 1_500);

// The checker the "Verified work email" preset runs on each found address.
export const ENRICH_VERIFY_TOOL_ID = 'treg.people.email.verify';
// Bounds for a setup estimate request (a pure read; it sizes nothing), and
// the highest per-row limit a user can set (mirrored in the client).
export const ENRICH_ESTIMATE_MAX_ROWS = 10_000_000;
export const ENRICH_ESTIMATE_MAX_LIST = 200;
export const ENRICH_MAX_ROW_CAP_USD = 1000;

// The drawer's "Popular" jobs. Ids the live catalog no longer has are hidden.
export interface FeaturedJob { id: string; title: string; blurb: string; preset?: 'verified_email' }
export const ENRICH_FEATURED: FeaturedJob[] = [
  { id: 'treg.people.email.find', title: 'Verified work email', preset: 'verified_email',
    blurb: 'Finds an email, checks it, and tries other providers until one passes.' },
  { id: 'treg.people.phone.find', title: 'Find phone number',
    blurb: 'Finds a phone number from a name and company, or a LinkedIn URL.' },
  { id: 'treg.people.email.verify', title: 'Verify email',
    blurb: 'Checks whether a mailbox accepts mail before you send.' },
  { id: 'treg.people.enrich', title: 'Person from LinkedIn or email',
    blurb: 'Fills in name, title and company for a person.' },
  { id: 'treg.companies.enrich', title: 'Company from domain',
    blurb: 'Fills in size, industry and location for a company.' },
  { id: 'treg.people.search', title: 'People at a company',
    blurb: 'Adds the people it finds as rows in another sheet.' },
  { id: 'treg.companies.search', title: 'Find companies',
    blurb: 'Adds the companies it finds as rows in another sheet.' },
  { id: 'treg.google.serp.organic', title: 'Google search results',
    blurb: "Adds the top Google results for each row's search as rows in another sheet." },
];

// A provider that answers 429 this many times in a row within a run is left
// out of that run's waterfalls for the cool-down, then asked again
// (services/enrich-providers.ts). Its rows go to the next provider meanwhile.
export const ENRICH_COOLDOWN_AFTER_429S = envInt('ENRICH_COOLDOWN_AFTER_429S', 3);
export const ENRICH_PROVIDER_COOLDOWN_MS = envInt('ENRICH_PROVIDER_COOLDOWN_MS', 5 * 60 * 1000);
// treg's own "shared key busy" 429 (share_busy) says when to retry: never sooner
// than this, never later than the other.
export const ENRICH_SHARE_BUSY_MIN_MS = 1_000;
export const ENRICH_SHARE_BUSY_MAX_MS = 60_000;
