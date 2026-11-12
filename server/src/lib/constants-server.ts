// The HTTP server keeps an idle connection open this long (lib/server-timeouts.ts), past a proxy's 60 s.
// No imports here: the unit tests' servers import this before they set the environment the other
// constants files read.
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;
