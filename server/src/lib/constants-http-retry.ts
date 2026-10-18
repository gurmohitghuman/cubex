import { envInt } from './env-int';

// HTTP API columns: automatic retries (lib/http-retry.ts) and the response code
// column (lib/http-extract-fields.ts).
export const HTTP_RETRY_DEFAULT = 3;
export const HTTP_RETRY_MAX = 5;
// The first wait; each later one doubles (half of it random), up to the cap.
export const HTTP_RETRY_BASE_MS = envInt('HTTP_RETRY_BASE_MS', 1000);
// No wait is longer than this, whatever the API's Retry-After says.
export const HTTP_RETRY_MAX_WAIT_MS = 60_000;
// While waiting, a row checks this often whether its run was paused or stopped.
export const HTTP_RETRY_STOP_POLL_MS = 1000;
// The path a response mapping uses for "the HTTP status code" instead of a
// JSONPath into the body.
export const HTTP_STATUS_PATH = '@status';
