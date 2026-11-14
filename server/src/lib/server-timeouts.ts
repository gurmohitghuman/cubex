import type { Server } from 'node:http';
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from './constants-server';

// The HTTP server's timeouts (index.ts). The unit tests' servers standing in for it call this too, so their
// connections behave as the real one's do; it reads only constants-server.ts, so importing it reads no
// environment (those tests set theirs after their imports).
//
// Reverse proxies and CDNs keep idle upstream sockets open for a while (60s on many); Node's default
// keepAliveTimeout is 5s. When a proxy reuses a socket Node just closed, the user sees a random 502, so outlast
// the proxy. headersTimeout MUST exceed keepAliveTimeout or Node treats it as a misconfiguration.
// requestTimeout is the whole server's deadline on receiving a request, from its first byte: the backstop past
// the app's own, shorter deadlines (lib/request-deadline.ts), passed in by index.ts from the settings. Node stops
// counting once a request is all in, so SSE streams (ai/http run progress) and other long answers aren't cut off.
export function applyServerTimeouts(server: Server, requestTimeoutMs = HTTP_REQUEST_TIMEOUT_MS): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = requestTimeoutMs;
}
