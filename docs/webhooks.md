# Webhooks

Give a sheet a secret URL, and every JSON event POSTed to it becomes a new row. Use it to collect form submissions, CRM events, or anything a tool like Zapier, Make or n8n can send, then enrich the new rows with AI or HTTP columns.

## Set it up

1. Open a sheet and click **Webhook**.
2. Choose **Create webhook on this sheet**, or **Create a new table for the webhook** to keep events separate from existing data.
3. Copy the URL. It's shown until the first event arrives, then hidden for good. If you lose it before then, rotate it (see below).
4. Send a test event:

   ```bash
   curl -X POST 'http://localhost:3002/api/webhooks/<token>' \
     -H 'Content-Type: application/json' \
     -d '{"email":"ana@example.com","company":"Acme","plan":{"name":"pro"}}'
   ```

5. Back in the Webhook panel, pick which fields from the event become columns. You click fields in the real event you just sent, so nested values (`plan.name`) work too. A field can be saved as plain text or as JSON.

From then on, each event adds a row below the existing data with the fields you picked. A **Webhook** column marks the rows that came in this way; open one to see the raw event. Rows that are already there are never changed.

## Making the URL reachable

The sender has to be able to reach Cubex.

- **Cubex on a server with a domain.** Nothing to do; the URL uses the address you open Cubex on.
- **Cubex on your laptop.** Use a tunnel such as `cloudflared tunnel` or `ngrok`, and set `PUBLIC_URL` to the tunnel's address so the panel shows a URL the sender can use.
- **Webhooks arrive at a different address than you browse on** (for example you open Cubex by LAN IP, but senders use a public domain). Set `PUBLIC_URL` to the public address.

If Cubex is reachable from the internet, put it behind HTTPS. See "Putting it on the internet" in the [README](../README.md).

## What the endpoint accepts

| Situation | Response |
|---|---|
| Event stored | `202` |
| `Content-Type` isn't `application/json` | `415` |
| Body isn't valid JSON | `400` |
| Body over 512 KB | `413` |
| Nested deeper than 10 levels, or more than 5,000 values | `400` |
| More than about 10 events a second (bursts of 20 are fine) | `429` with `Retry-After` |
| The sheet is at its row limit | `409` |
| Unknown, rotated or disabled URL | `404` |

A text value longer than 8,000 characters is cut to 8,000 before it's written. If one event would write more than 64 KB in total, the row is still created and the cells that don't fit are dropped.

Cubex keeps the raw events for the newest 1,000 deliveries (up to 10 MB) per webhook, so you can pick new fields from a recent event later. The rows themselves are never deleted by this.

## Keeping it safe

- **The URL is the password.** Anyone who has it can add rows to that sheet, up to its row limit (by default 1,000,000 rows, which can take several GB at the per-event maximum). Cubex stores only a hash of the token, so the URL can't be recovered after the first event.
- **Rotate** in the Webhook panel if a URL leaks. The old URL stops working immediately.
- **Disable** to pause intake without losing the setup. Events sent while disabled get `404`.
- One webhook per sheet.
