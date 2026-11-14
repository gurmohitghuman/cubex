// The HTTP server keeps an idle connection open this long (lib/server-timeouts.ts), past a proxy's 60 s.
// No imports here: the unit tests' servers import this before they set the environment the other
// constants files read.
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;
// A test server's deadline on receiving a request (lib/server-timeouts.ts). The real server's comes from the
// settings (lib/request-deadline.ts receiveBackstopMs); with the defaults it is about 71 minutes.
export const HTTP_REQUEST_TIMEOUT_MS = 75 * 60_000;
