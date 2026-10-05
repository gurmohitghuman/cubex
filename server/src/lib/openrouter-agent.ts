import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { MAX_AI_CONCURRENCY, OPENROUTER_IDLE_SOCKET_MS } from './constants';

// Shared HTTPS keep-alive agent for ALL OpenRouter traffic (SDK calls during
// AI runs + direct fetches for key validation / model list).
//
// Without this, every OpenRouter call opens a fresh TCP+TLS connection,
// burning ~80ms per row on handshake. On a 1000-row AI run that's ~80s of
// pure handshake overhead. With keep-alive, the first call pays the cost
// and the rest reuse the socket.
//
// keepAliveMsecs: 60s — the delay before TCP keep-alive probes start. It is NOT
//   an idle limit: on its own, an idle socket stays in the pool indefinitely.
// Idle limit: withIdleLimit below closes a pooled socket after
//   OPENROUTER_IDLE_SOCKET_MS, so a run after a quiet spell dials fresh instead
//   of reusing connections upstream already dropped (every row of its first
//   wave failed with EPIPE). It isn't the agent's `timeout` option on purpose:
//   the OpenAI SDK raises that to its request timeout + 1s (181s) on the first
//   request.
// maxSockets: MAX_AI_CONCURRENCY + 10 — a single run can fan out up to
//   MAX_AI_CONCURRENCY (100) parallel calls; the transport pool must cover that
//   or the run's concurrency silently queues behind the agent. +10 headroom for
//   incidental key-validation / model-list fetches. Still bounded so a runaway
//   can't exhaust fds.
// maxFreeSockets: 10 — keep a small pool warm between runs.

// Node calls keepSocketAlive when a request finishes and pools the socket if it
// returns true; a pooled socket that then times out is destroyed by the agent.
// Setting the timer here bounds idle time only: a socket in use emits 'timeout'
// at most, which nothing listening to the request acts on.
export function withIdleLimit<T extends new (...args: any[]) => http.Agent>(Base: T, idleMs: number) {
  return class extends Base {
    keepSocketAlive(socket: Duplex): boolean {
      // @types/node declares void; Node uses the boolean.
      const pooled = super.keepSocketAlive(socket) as unknown as boolean;
      if (pooled) (socket as Socket).setTimeout(idleMs);
      return pooled;
    }
  };
}

const IdleLimitedAgent = withIdleLimit(https.Agent, OPENROUTER_IDLE_SOCKET_MS);

export const openrouterAgent = new IdleLimitedAgent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: MAX_AI_CONCURRENCY + 10,
  maxFreeSockets: 10,
});
