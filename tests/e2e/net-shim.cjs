// Loaded into the e2e server only (scripts/e2e-harness.mjs sets NODE_OPTIONS
// --require for it), never in a real install. It lets specs reach a receiver
// they run on 127.0.0.1 (tests/e2e/helpers-receiver.ts) through Cubex's real
// outbound path, SSRF guard included:
//   - a name under .cubex-e2e.invalid resolves, through dns.promises.lookup
//     (what the guard calls), to a public address, so the guard checks it like
//     any public host and lets it through;
//   - a connection to such a name goes to 127.0.0.1 instead, and only on
//     E2E_RECEIVER_PORT.
// The guard is untouched: 127.0.0.1 or localhost in a URL is still refused, and
// specs check that. Without this file .invalid names don't resolve at all, so
// nothing leaves the machine. Worker threads load it too (the HTTP runs).
'use strict';
const dns = require('node:dns');
const net = require('node:net');

const SUFFIX = '.cubex-e2e.invalid';
const PORT = Number(process.env.E2E_RECEIVER_PORT || 0);
// example.com's address: public, and never contacted (connections are moved).
const STAND_IN = '93.184.215.14';
const ours = host => typeof host === 'string' && host.toLowerCase().endsWith(SUFFIX);

const lookup = dns.promises.lookup;
dns.promises.lookup = function (host, options) {
  if (!ours(host)) return lookup.apply(this, arguments);
  const one = { address: STAND_IN, family: 4 };
  return Promise.resolve(options && options.all ? [one] : one);
};

const connect = net.connect;
function moved(...args) {
  const o = args[0];
  if (o && typeof o === 'object' && ours(o.host)) {
    if (Number(o.port) !== PORT) throw new Error(`e2e net shim: ${o.host} is reachable on port ${PORT} only`);
    const to = { ...o, host: '127.0.0.1' };
    delete to.lookup;
    args[0] = to;
  }
  return connect.apply(this, args);
}
net.connect = moved;
net.createConnection = moved;
