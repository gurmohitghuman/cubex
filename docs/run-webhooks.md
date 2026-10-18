# Run webhooks

When an AI, HTTP API, enrichment, waterfall or setup run finishes, Cubex can send a POST to a URL of yours. A script, an automation or an agent then carries on the moment the run is done, instead of checking again and again.

Each POST is signed, so your receiver can tell it came from your Cubex.

## What you need

- A URL that accepts a POST with a JSON body and answers with any 2xx status within 10 seconds. It must be a public address: Cubex never sends to localhost, your local network or cloud metadata addresses, and doesn't follow redirects.
- A place to keep the webhook's secret, where your receiver can read it. Treat it like a password.

## Set it up

1. Open **Settings, Run webhooks** and click **Add webhook**.
2. Paste your URL. Leave **Tell it about every run** on to hear about every run, auto-runs included. Turn it off to hear only about runs started over the API or MCP with this webhook's id (see [For agents and scripts](#for-agents-and-scripts)).
3. Copy the secret. It's shown once. Lost it? Click the key icon for a new one; the old one stops working at once.
4. Click the send icon to send a test notice, and open **Recent deliveries** to see how your URL answered.

Over the API: `POST /api/v1/run-webhooks` with `{"url": "https://...", "every_run": true}` (an access token with the `run` scope). The answer holds the secret, once. The [REST reference](mcp.md#run-webhooks) lists the rest.

## The notice

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: Cubex-Webhook/1
X-Cubex-Event: run.finished
X-Cubex-Delivery: 3d0f5c1e-8a8e-4f43-9a9e-1b2c3d4e5f60
X-Cubex-Signature: sha256=5c0a...e19b

{"event":"run.finished","run_id":"6f1c...","kind":"http","sheet_id":"a83b...","status":"completed","finished_at":"2026-10-17T14:03:22.418Z"}
```

| Field | What it is |
|---|---|
| `event` | `run.finished`, or `test` for a test notice (its other fields are `null`). |
| `run_id` | The run. Read it with `get_run_status` (MCP) or `GET /api/v1/ai-runs/:id`, `GET /api/v1/http-runs/:id`; a setup with `get_setup_run` or `GET /api/v1/setup-runs/:id`. |
| `kind` | `ai`, `http`, `enrichment`, `waterfall` or `setup`. |
| `sheet_id` | The sheet it ran on. |
| `status` | `completed`, `failed` or `cancelled`. Completed means every row was processed, not that every row worked: the run's status tells you how many failed. |
| `finished_at` | When it finished (UTC). |

The notice carries ids and the outcome, never values from your rows.

## Check the signature

`X-Cubex-Signature` is `sha256=` followed by the HMAC-SHA256 of the raw request body, made with the webhook's secret, in hex. Compute the same on your side and compare. Use the body exactly as it arrived, before any JSON parsing, and compare in constant time.

Node (no packages needed):

```js
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.CUBEX_WEBHOOK_SECRET

createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks) // the raw bytes, before any JSON parsing
    const expected = Buffer.from('sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'))
    const got = Buffer.from(req.headers['x-cubex-signature'] ?? '')
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(401).end()
      return
    }
    const notice = JSON.parse(body)
    res.writeHead(204).end() // answer first, then do the work
    // ... look the run up with notice.run_id
  })
}).listen(8080)
```

Python (standard library only):

```python
import hashlib, hmac, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["CUBEX_WEBHOOK_SECRET"].encode()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))  # the raw bytes
        expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, self.headers.get("X-Cubex-Signature", "")):
            self.send_response(401)
            self.end_headers()
            return
        notice = json.loads(body)
        self.send_response(204)  # answer first, then do the work
        self.end_headers()
        # ... look the run up with notice["run_id"]

HTTPServer(("", 8080), Handler).serve_forever()
```

To check one by hand: `printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET"`.

## Delivery

- Cubex waits up to 10 seconds for a 2xx. Any other answer (a redirect included), a timeout or no answer counts as a failure, and the notice is sent again: about 10 seconds later, then about a minute later (longer if your URL answers with `Retry-After`, up to a minute). After 3 tries it's marked failed in the log.
- Every try of a notice has the same body, signature and `X-Cubex-Delivery`, and a notice cut off by a restart of Cubex is sent again once it starts. To skip a repeat, use `run_id` with `finished_at`: they're in the signed body (`X-Cubex-Delivery` matches the log, but the signature doesn't cover it). You can also ignore a notice whose `finished_at` is much older than you'd expect.
- Notices can arrive in any order.
- When a URL falls behind, at most 200 notices wait for it; later ones are logged as not sent.
- The log keeps each webhook's last 50 deliveries: **Recent deliveries** in Settings, `GET /api/v1/run-webhooks/:id/deliveries`, or `list_run_webhooks` with `webhook_id` over MCP.

**Polling stays the source of truth.** Your URL can be down for longer than the tries last, so a notice can be lost. Treat a notice as the signal to look, and still check runs you care about now and then, for example once when you'd expect a long run to be done.

## For agents and scripts

Pass a webhook's id as `webhook_id` when you start a run: `run_ai_column`, `run_http_enrichment`, `run_enrichment`, `waterfall_column`, `apply_setup` and a `control_run` rerun over MCP, or the same field on `POST /api/v1/sheets/:id/ai-runs`, `/http-runs`, `/enrichment-runs`, `/waterfall-columns`, `/setups/:id/apply` and the reruns. That webhook hears when the run finishes, even when it's set to hear only named runs. `list_run_webhooks` (MCP) and `GET /api/v1/run-webhooks` list the ids.

With **every run** on, a webhook also hears each step of a setup (each is a run of its own) as well as the setup, and every auto-run batch.

## Security

- The URL must be public when you save it, and is checked again on every try, the same way as HTTP API columns: Cubex resolves the name, refuses private, loopback, link-local and metadata addresses, and connects only to the address it checked. Redirects aren't followed.
- The secret is stored encrypted (with your `.encryption-key`) and shown only when it's made.
- Reading webhooks over the API needs the `read` scope; adding, changing or deleting them, a new secret or a test needs `run`, since they decide where Cubex sends requests, as an HTTP API column does.
