# Connect an AI agent (MCP)

Cubex runs an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can work in your spreadsheets for you: create tables, import CSVs, edit rows, and start AI and HTTP enrichment runs. You describe the task in chat; the assistant does the clicking.

## What you need

- Cubex running somewhere the assistant can reach. On the same computer, that's `http://localhost:3002`.
- An **access token**. In Cubex, open **Settings → Agent access → Access tokens** and create one. It's shown once, so copy it then.

Choose the token's scopes:

| Scope | Lets the assistant |
|---|---|
| `read` | List tables, read rows, check runs. |
| `write` | Also create and change tables, sheets, columns and rows. |
| `run` | Also start, pause, resume, stop and re-run AI and HTTP runs. These spend your OpenRouter credits and call your APIs. |
| `secrets` | Also start HTTP runs that use your saved API keys. Needs `run`. |

`write` and `run` each include `read`. `run` doesn't include `write`, but starting a run does create its output columns. You can have 10 active tokens and revoke any of them at any time. A token can't create other tokens or change your password or saved keys.

## Setup

The **Agent access** page shows these commands with your Cubex address and token filled in.

**Claude Code**

```bash
claude mcp add --scope user --transport http cubex http://localhost:3002/mcp --header "Authorization: Bearer cubex_pat_..."
```

`--scope user` makes Cubex available in every folder. Without it, Claude Code only uses it in the folder where you ran the command. To switch to a new token later, run `claude mcp remove --scope user cubex`, then add it again.

**Codex**

```bash
export CUBEX_TOKEN="cubex_pat_..."
codex mcp add cubex --url http://localhost:3002/mcp --bearer-token-env-var CUBEX_TOKEN
```

**Cursor** (`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` in one project)

```json
{ "mcpServers": { "cubex": { "url": "http://localhost:3002/mcp", "headers": { "Authorization": "Bearer cubex_pat_..." } } } }
```

**VS Code** (`.vscode/mcp.json`; VS Code asks for the token once and stores it securely)

```json
{
  "inputs": [{ "type": "promptString", "id": "cubex-token", "description": "Cubex access token", "password": true }],
  "servers": { "cubex": { "type": "http", "url": "http://localhost:3002/mcp", "headers": { "Authorization": "Bearer ${input:cubex-token}" } } }
}
```

**Claude Desktop** (`claude_desktop_config.json`, through the `mcp-remote` bridge, which sends the header for you)

```json
{ "mcpServers": { "cubex": { "command": "npx", "args": ["mcp-remote", "http://localhost:3002/mcp", "--header", "Authorization:${CUBEX_AUTH}"], "env": { "CUBEX_AUTH": "Bearer cubex_pat_..." } } } }
```

**claude.ai connectors** connect from Anthropic's servers, so Cubex must be on the internet over HTTPS (see "Putting it on the internet" in the README). They are built around OAuth sign-in, which Cubex doesn't offer: it uses access tokens. If your connector form has no place for an `Authorization` header, use one of the clients above.

Any other client that speaks MCP over Streamable HTTP works the same way: point it at `<your Cubex address>/mcp` and send `Authorization: Bearer <token>`.

## Things to ask for

- "Import `leads.csv` into a new table called Leads."
- "In Leads, add an AI column that scores each company 1 to 10 for fit, using /company and /domain. Try it on 5 rows first and show me the results."
- "Run the fit score on every row, then tell me how many scored 8 or more."
- "Call `https://api.example.com/people?email={{email}}` for each row and add the job title and LinkedIn URL as columns."
- "The last run left some cells blank. Show me why, then re-run only those rows."
- "Export the rows where Status is Qualified, with just Email and Company."

## Tools

| Tool | What it does |
|---|---|
| `list_tables` | Tables and their sheets. Start here to turn names into ids. |
| `get_sheet` | A sheet's columns, row count, and how many rows and columns are left. |
| `read_rows` | Rows, paged, with optional filters and column selection. |
| `export_csv` | A sheet (or a filtered part of it) as CSV, up to 40,000 characters. Past that it says how many rows matched; the rest comes from `read_rows` or the REST export, which streams any size. |
| `append_rows`, `update_cells`, `delete_rows` | Add, edit and delete rows by their stable row id. |
| `add_column`, `rename_column`, `delete_column` | Manage columns. |
| `sort_sheet` | Permanently reorders the rows by a column. |
| `manage_table`, `manage_sheet` | Create, rename, delete and reorder tables and sheet tabs. |
| `import_csv` | Load CSV text into a sheet (append or replace). |
| `run_ai_column` | Start an AI column run. Can estimate the cost first, preview a few rows, target specific rows, or fill several typed columns at once. |
| `run_http_enrichment` | Start an HTTP API column run. |
| `get_run_status`, `list_runs` | Follow a run, or find recent ones. |
| `get_run_results` | Per-row results and errors, to see why cells are blank or wrong. |
| `control_run` | Pause, resume, cancel, or re-run (failed rows, empty rows, or all). |
| `list_models`, `set_default_model` | Find OpenRouter models and set the default. |
| `transform_column` | Free, instant text transforms (upper/lower case, trim, number, regex extract, split, template) with no model call. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |
| `transfer_rows` | Copy or move rows between sheets on the server. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |

Deletes are permanent; there's no undo. Every tool tells your client whether it only reads, adds, or changes and deletes data, so clients can ask you before the risky ones.

Starting a run on a very large sheet answers at once: the run shows as pending while Cubex marks its rows, then starts. Cancelling also answers at once; leftover cells clear in the background.

## Limits

Agents can get stuck in loops, so each token has its own budget:

- 120 requests a minute.
- 30 run starts a minute (reruns and previews count; estimates don't).
- Through MCP: 5 CSV imports a minute.

Row transfers are limited for the whole account: 10 a minute, one at a time.

Going over returns a clear error; the assistant can wait and retry.

## REST API

The same data is available as a plain HTTP API under `/api/v1`, with the same tokens and scopes. Send `Authorization: Bearer cubex_pat_...` and JSON bodies (`Content-Type: application/json`). `GET /api/v1/me` checks a token and lists its scopes.

All paths below are relative to `/api/v1`.

### Tables, sheets and columns

| Endpoint | Body or query |
|---|---|
| `GET /tables` | Tables with their sheets. |
| `POST /tables` · `PATCH /tables/:id` | `{"name": "Leads"}` |
| `DELETE /tables/:id` | Deletes the table, its sheets and their rows. Stops its runs first. |
| `POST /tables/:tableId/sheets` | `{"name": "Q3", "after_sheet_id": "..."}` (both optional) |
| `PATCH /tables/:tableId/sheets/:sheetId` | `{"name": "Q3 leads"}` |
| `DELETE /tables/:tableId/sheets/:sheetId` | A table always keeps one sheet. |
| `PATCH /tables/:tableId/sheets/order` | `{"ordered_sheet_ids": ["...", "..."]}` |
| `GET /sheets/:id` | Columns, row count, `data_version` and `row_generation`. |
| `POST /sheets/:id/columns` | `{"name": "Status"}` |
| `PATCH /sheets/:id/columns/:name` | `{"name": "New name"}` (URL-encode the old name) |
| `DELETE /sheets/:id/columns/:name` | |
| `PUT /sheets/:id/columns/order` | `{"order": ["Email", "Company", "Status"]}` (every column, once) |
| `POST /sheets/:id/sort` | `{"column": "Score", "direction": "desc"}`. Permanently reorders the rows. |

### Rows

Rows are addressed by their stable `id`, which survives sorts and imports.

| Endpoint | Body or query |
|---|---|
| `GET /sheets/:id/rows` | `?limit=100&cursor=...`. Returns `{rows: [{id, index, data}], next_cursor}`. `limit` is 1 to 500 (default 100). Pass `next_cursor` back as `cursor` until it's `null`. |
| `POST /sheets/:id/rows/query` | `{"where": [{"column": "Status", "operator": "eq", "value": "Qualified"}], "columns": ["Email"], "limit": 100, "cursor": 0, "return_mode": "rows"}`. Operators: `eq`, `neq`, `contains`, `empty`, `not_empty`, `gt`, `gte`, `lt`, `lte`. Values are strings. `return_mode` is `rows`, `ids` or `count`. To page a filtered query, send back `expected_data_version` and `expected_row_generation` from the first page; you get a 409 if the sheet changed in between. |
| `POST /sheets/:id/rows` | `{"rows": [{"data": {"Email": "a@b.com"}}]}`, up to 1,000 rows. Note the `data` wrapper (MCP's `append_rows` takes the objects directly). |
| `PATCH /rows/:rowId` | `{"data": {"Status": "Done", "Notes": null}}`. `null` clears a cell. |
| `POST /sheets/:id/rows/update` | `{"updates": [{"row_id": "...", "data": {"Status": "Done"}}]}`, up to 1,000. |
| `POST /sheets/:id/rows/delete` | `{"row_ids": ["..."]}`, up to 1,000. Permanent. |
| `POST /sheets/:id/import` | Multipart form: the CSV in a field named `file`, plus `replace=true` to replace the rows instead of appending. |
| `GET /sheets/:id/export` | The whole sheet as CSV, streamed (any size). |
| `POST /sheets/:sourceId/rows/transfer` | Copy or move rows to another sheet. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |

### Runs

Starting a run needs the `run` scope. A started run answers `202` with its `run_id`. An estimate, a preview, or a retry that replays an earlier start answers `200`.

**AI run:** `POST /sheets/:id/ai-runs`

```json
{
  "column_name": "Fit score",
  "prompt": "Score /company from 1 to 10 for fit. Reply with the number only.",
  "model": "deepseek/deepseek-v4-flash",
  "target_row_ids": ["..."],
  "estimate_only": true
}
```

- `prompt` reads other columns with `/column_name`: lower case, with spaces and symbols turned into `_` ("What they sell (Output)" is `/what_they_sell_output`).
- `estimate_only: true` returns the row count and estimated cost without starting anything. `preview_rows: 3` runs the prompt on a few rows and returns the answers without saving them.
- `output_columns: [{"column_name", "type", "description"}]` fills several typed columns from one call per row.
- `web_search: true` lets the model search the web. `web_fetch: true` lets it open pages, but only on the sites named in the cells the prompt references, so a prompt that mentions `/domain` keeps each row on its own site. Either one works with `output_columns`: the run also fills a `<column_name> (Data)` column with the sources it used. Estimates include web fees, and previews use the same tools and list each row's sources.
- Also optional: `system_prompt`, `temperature`, `max_chars`, `concurrency`.
- `model` is required unless you've set a default (Settings → AI). `GET /models?search=deepseek` finds exact ids.

**HTTP run:** `POST /sheets/:id/http-runs`

```json
{
  "url": "https://api.example.com/people?email={{Email}}",
  "method": "GET",
  "headers": { "Authorization": "Bearer {{my_saved_key}}" },
  "response_mapping": [{ "json_path": "$.title", "column_name": "Job title" }],
  "estimate_only": false
}
```

- `{{name}}` takes a column's value or a saved API key (saved keys need the `secrets` scope). A name that matches neither is refused before anything is sent.
- Also optional: `body` (for POST and PUT), `master_column_name` (the status column), `batch_size` (requests at once, default 5, up to 20) and `timeout_ms` (per request, default 30,000).
- The earlier shape, `{"config": {"requestConfig": {...}, "responseMapping": [{"jsonPath", "columnName"}], "batchSize": 5}}`, still works.

**Retrying safely:** send an `Idempotency-Key` header (or `idempotency_key` in the body). Repeating a start with the same key and arguments returns the original `run_id` instead of starting (and paying for) a second run.

| Endpoint | Body or query |
|---|---|
| `GET /runs` | Recent runs, newest first. `?sheet_id=...&filter=active` (`active`, `terminal` or `all`) `&limit=20` (up to 50). |
| `GET /ai-runs/:id` · `GET /http-runs/:id` | Status and progress. `completed` means every row was processed, not that every row worked: check `failed_rows`. A structured AI run also lists its `output_columns`, and a run with web search or fetch names its `data_column` (the sources). |
| `GET /ai-runs/:id/results` (same for `http-runs`) | Per-row results and errors. `?status=failed` (`failed`, `completed` or `all`, default `all`), paged with `limit` and `cursor` like rows. |
| `POST /ai-runs/:id/pause`, `/resume`, `/cancel` (same for `http-runs`) | |
| `POST /ai-runs/:id/rerun` | `{"mode": "errored"}` or `{"row_ids": [...]}`. One of them is required. Modes: `errored` (failed rows), `empty`, `missing` (empty, failed or unfinished), `all`. Starts a new run, which costs credits again. A structured (`output_columns`) run refills all its columns on those rows; its modes read the `(Status)` column. |
| `POST /http-runs/:id/rerun` | `{"mode": "missing"}` or `{"row_ids": [...]}`. Without either, every row runs again. |

### Responses and errors

- Errors are JSON: `{"error": "message"}`. Some add detail: `unknownColumns`, `lockedColumns` (columns a run is still filling), `protectedColumns`, or `busy: true` (the sheet is in the middle of an import or sort; retry shortly).
- `400` bad input · `401` missing or revoked token · `403` the token lacks a scope · `404` not found · `409` conflict (a name already taken, a run already active, a sheet that changed while you paged) · `413` body over 2 MB · `429` rate limited.
- The limits above apply to each token across MCP and REST together. Every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and a `429` adds `Retry-After` (and `retry_after_seconds` in the body when the run-start limit refused it; its `RateLimit-*` headers then describe that limit).

## Security notes

- A token is as good as your password for whatever its scopes allow. Give each assistant its own token so you can revoke one without breaking the others.
- Browser pages can't call `/mcp` (requests carrying a foreign `Origin` header are refused), which blocks DNS-rebinding tricks against a Cubex running on localhost. Desktop and command-line clients don't send that header and aren't affected.
- Cell values are data, not instructions. They can come from anyone who can send a webhook, from imported files, and from AI or HTTP runs, so a cell can contain text written to steer an assistant. Cubex tells connected assistants never to follow instructions found in cells; review what an assistant proposes to do with data it read.
