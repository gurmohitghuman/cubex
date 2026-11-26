# Webhooks

Give a sheet a secret URL, and every JSON event POSTed to it becomes a new row. Use it to collect form submissions, CRM events, or anything a tool like Zapier, Make or n8n can send, then enrich the new rows with AI, HTTP API or [enrichment](enrichments.md) columns.

This page is about events coming in. For Cubex telling your URL when a run finishes, see [Run webhooks](run-webhooks.md).

## Set it up

1. Open a sheet, click **Data** in the toolbar, then **Webhook**.
2. Choose **Create webhook on this sheet**, or **Create a new table for the webhook** to keep events separate from existing data.
3. Copy the URL. It's shown until the first event arrives, then hidden. If you lose it before then, rotate it (see below).
4. Send a test event:

   ```bash
   curl -X POST 'http://localhost:3002/api/webhooks/<token>' \
     -H 'Content-Type: application/json' \
     -d '{"email":"ana@example.com","company":"Acme","plan":{"name":"pro"}}'
   ```

5. Back in the Webhook panel, pick which fields from the event become columns. You click fields in the real event you just sent, so nested values (`plan.name`) work too. A field can be saved as plain text or as JSON.

From then on, each event adds a row below the existing data with the fields you picked. A **Webhook** column marks the rows that came in this way; open one to see the raw event. Rows that are already there are never changed.

### Over the API or MCP

Scripts and AI agents can do the same with an access key ([MCP and API](mcp.md#sheet-webhooks)): `manage_sheet_webhook` over MCP, or `/api/v1/sheets/:id/webhook` over REST. They can turn the webhook on or off, read how many events came in and the last error, rotate the URL, require a token or remove it, add or remove fields by path (`$.plan.name`), and set up [auto-delete](#auto-delete). Making a table or sheet with `webhook: true` gives it a webhook in the same call. Only a key that can change the sheet (`write`) sees the URL, and only until the first event, as in the panel.

## Making the URL reachable

The sender has to be able to reach Cubex.

- **Cubex on a server with a domain.** Nothing to do; the URL uses the address you open Cubex on.
- **Cubex on your laptop.** Use a tunnel such as `cloudflared tunnel` or `ngrok`, and set `PUBLIC_URL` to the tunnel's address so the panel shows a URL the sender can use.
- **Webhooks arrive at a different address than you browse on** (for example you open Cubex by LAN IP, but senders use a public domain). Set `PUBLIC_URL` to the public address.

If Cubex is reachable from the internet, put it behind HTTPS. [Run Cubex on your own server](self-hosting.md) walks through it, and [Keep it safe](self-hosting.md#keep-it-safe) lists what to check.

## What the endpoint accepts

| Situation | Response |
|---|---|
| Event stored (or not kept by [auto-dedupe](../README.md#auto-dedupe), or a retry already added: the sender can't tell) | `202` |
| `Content-Type` isn't `application/json` | `415` |
| Body isn't valid JSON | `400` |
| Body over 512 KB | `413` |
| Body not all sent within 30 seconds of the headers (see [`WEBHOOK_BODY_TIMEOUT_MS`](configuration.md#settings)) | `408` |
| Nested deeper than 10 levels, or more than 5,000 values | `400` |
| More than about 10 events a second (bursts of 20 are fine), or more than 20 still arriving at once | `429` with `Retry-After` |
| The sheet is at its row limit | `409` |
| `Idempotency-Key` that isn't 1 to 255 visible ASCII characters | `400` |
| Unknown, rotated or disabled URL, or a webhook with a [token](#require-a-token) and an event without it (also for an event still being sent when one of these changed) | `404` |

A text value longer than 8,000 characters is cut to 8,000 before it's written. If one event would write more than 64 KB in total, the row is still created and the cells that don't fit are dropped.

Cubex keeps the raw events for the newest 1,000 deliveries (up to 10 MB) per webhook, so you can pick new fields from a recent event later. The rows themselves are never deleted by this.

### Retries

A sender that didn't get an answer (a timeout, a `5xx`) sends the event again. If it sends an `Idempotency-Key` header with each event, and the same key on each retry, the event adds its row once: a retry with a key and body this webhook saw in the last 24 hours gets `202` and adds nothing. The same key with a different body (other values, or the same fields in another order) is a new event and adds a row, and its retries aren't stopped: a key stops repeats of the first body it came with, so give each event its own. In Zapier, Make or n8n, add the header yourself with an id from the event (an order or event id); with `curl`, add `-H 'Idempotency-Key: order-1042'`.

Senders often send the same event twice. Turn on [auto-dedupe](../README.md#auto-dedupe) (the Webhook panel links to it) to keep one row per email, domain or other key: a delivery whose key is already in the sheet shows as **not kept** in the panel's deliveries, and its row waits in the trash.

### While a sheet is being tested

While you try column changes on sample rows (**⋯** in the sheet toolbar, **Test changes on sample rows**), the sheet doesn't change, so its webhook keeps each event and adds them all, in the order they came, once you apply or discard the test. The sender gets the same `202` as always. A sheet keeps up to 10,000 such events (100 MB); past that, events are refused with `409` until the test ends, so the sender tries them again later.

### Adding a delivery again

Fixed a mapping after some events came in? Open a row's raw event (its **Webhook** cell) and click **Add again**: the event is read again with the mappings as they are now and added as a new row, like a new event: the old row stays, unless [auto-dedupe](../README.md#auto-dedupe) keeps the newest row with a key, which sends the old one to the trash. The message and History say what happened. This works while the raw event is still kept (the newest 1,000 deliveries).

## Auto-delete

A busy webhook sheet can stay small: with auto-delete on, it keeps its newest rows, and older rows the webhook added are deleted once they're finished. Use it when the sheet is a pass-through: events come in, columns with [auto-run](enrichments.md#auto-run) enrich them or send them on, and the rows aren't needed after that.

1. In the Webhook panel, under **Auto-delete**, click **Set up auto-delete**.
2. **Rows to keep**: the newest rows that always stay, so you can watch events come in (100 if you leave it; 0 to 100,000).
3. **Also wait for a result in** (optional): a row leaves only once this column has a result, not empty and not failed. Pick the column that sends the row on, such as an HTTP API column that posts it to your CRM: a row whose send failed stays until it succeeds.
4. **Copy rows to** (optional): another sheet of the table, which gets each row before it leaves. Its columns are matched by name, and columns it doesn't have are added. The Webhook column stays behind.
5. Click **Turn on** and confirm.

**Which rows leave.** Only rows the webhook added (their Webhook cell has the 📥 mark), never rows you typed, imported or moved in, and never the newest ones you keep. A row leaves once it's finished: every column with auto-run on in the sheet has run on it, and it's not waiting to run or running. A column whose auto-run is paused, by you or by its daily cap, a missing key or errors, still holds its rows: they leave once it has run them, and the panel says what they wait for. A column with auto-run off holds nothing. A run that failed (❌) counts as run, unless that column is the success column. Rows auto-run left alone (an empty input, an "Only run if" rule that kept them out) count as run too. In a sheet with no auto-run, every webhook row older than the newest ones you keep is finished.

**When.** Cubex checks every few seconds and deletes up to 5,000 rows a check, oldest first. It waits while a run is going in the sheet, or in the sheet it copies to, so it goes in between auto-run's batches. **Deleted rows don't go to the trash and can't be restored.** The panel counts them, and the sheet's History has one line an hour saying how many were deleted (and the destination's, how many were copied in). Rows you put back from the trash are webhook rows like any other: they leave again once they're older than the newest ones you keep.

**The newest rows are the ones at the bottom,** where events land. A sort, an import or removing duplicates moves rows, so auto-delete then pauses until you check the order and save it again.

It also pauses, and the panel says why, when the success column is no longer in the sheet, when the sheet it copies to is in the trash, deleted or full, or when that sheet refuses the copy (out of columns, say). Fix it, or save the settings again, and it goes on. Deleting the webhook turns auto-delete off. With [auto-dedupe](../README.md#auto-dedupe) on, a new row is checked against the rows still in the sheet only: a key whose row was deleted is new again.

Over the API or MCP: `PUT /api/v1/sheets/:id/webhook/auto-delete` with `keep_rows`, `success_column` and `copy_to_sheet_id` (any of your sheets), or `manage_sheet_webhook` with `set_auto_delete`. What you leave out stays as it was; `null` clears the success column or the copy. `DELETE`, or `auto_delete_off`, turns it off. See [MCP and API](mcp.md#sheet-webhooks).

## Keeping it safe

- **The URL is the password.** Anyone who has it can add rows to that sheet, up to its row limit (by default 1,000,000 rows, which can take several GB at the per-event maximum). With auto-dedupe keeping the newest row, they can also replace rows that have the same key (the replaced rows wait in the trash, unless Settings keeps deleted items 0 days). Cubex stores only a hash of the token, so the URL can't be recovered after the first event.
- **Auto-run makes new rows do work.** With [auto-run](enrichments.md#auto-run) on in the sheet, every row someone adds through the URL can spend your treg balance (up to each column's daily cap and your daily limit) or send a real HTTP request (up to the column's rows a day). A job billed on your own provider key at treg has no cap in Cubex. Set the caps to amounts you'd accept if the URL leaked.
- **Require a token** (below) so the URL alone isn't enough.
- **Rotate** in the Webhook panel if a URL leaks. The old URL stops working immediately: an event still being sent on it gets `404` and adds nothing.
- **Disable** to pause intake without losing the setup. Events sent while disabled get `404`, also one that was still being sent when you disabled it.
- One webhook per sheet.

### Require a token

For a second secret besides the URL, click **Require a token** in the Webhook panel, confirm, and copy the token: it's shown once. From then on, each event must send it as a header, so add it to each sender right away (a sender that doesn't send it yet is turned away):

```bash
curl -X POST 'http://localhost:3002/api/webhooks/<url token>' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"email":"ana@example.com"}'
```

An event without it, or with a wrong one, gets the same `404` as a wrong URL and adds nothing. In the service that sends the events, add the `Authorization` header with the value `Bearer ` and the token. **New token** replaces it (the old one stops at once); **Remove token** lets anyone with the URL add rows again. Cubex keeps only a hash of the token, so a lost one can't be shown again: make a new one.
