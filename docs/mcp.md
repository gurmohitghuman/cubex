# Connect an AI agent (MCP)

Cubex runs an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can work in your spreadsheets for you: create tables, import CSVs, edit rows, and start AI and HTTP enrichment runs. You describe the task in chat; the assistant does the clicking.

## What you need

- Cubex running somewhere the assistant can reach. On the same computer, that's `http://localhost:3002`.
- An **access token**. In Cubex, open **Settings → Agent access → Access tokens** and create one. It's shown once, so copy it then.

Choose the token's scopes:

| Scope | Lets the assistant |
|---|---|
| `read` | List tables, read rows, check runs, and see the saved API keys' names and where they're used (never their values). |
| `write` | Also create and change tables, sheets, columns and rows. |
| `run` | Also start, pause, resume, stop and re-run AI, HTTP, enrichment and waterfall runs, and turn auto-run on or off. These spend your OpenRouter credits and your treg balance, and call your APIs. |
| `secrets` | Also start HTTP runs that use your saved API keys, and save the keys in a pasted cURL command as new saved keys. Needs `run`. |

`write` and `run` each include `read`. `run` doesn't include `write`, but starting a run does create its output columns. You can have 10 active tokens and revoke any of them at any time. A token can't create other tokens or change your password, and it can never read a saved key's value or change a saved key. Any token can list the keys by name, with where each is used (`list_saved_keys`); using one in a new request still needs `secrets`. With `secrets` it can add a new one, from a cURL command it passes to an HTTP run.

**Spend cap.** Give a token a spend cap when you create it, or later from its row in **Settings → Agent access**, to limit what an agent can spend in dollars. It counts what the runs the token started spent on AI (OpenRouter's charge and your own provider key's) and on enrichments, and also its previews and AI helpers (`preview_rows`, `write_formula`, `write_run_condition`). Auto-runs it turned on and setups it applied count too. These are the same numbers as the usage history. The cap is for the token's whole life, not a month: to go on, raise it or make a new token. At the cap, new AI and enrichment runs, previews and AI helpers are refused with a message that says so, and so is resuming any run with that token (yours from the app too). A run a token resumes spends for that token from then on, whoever started it, and calls already out when a run changes hands count for the token that resumed it; what was billed before stays with the token it was billed for. Running runs pause, and so does a setup before its next AI or enrichment step; you can resume them once the cap is raised (an auto-run goes on by itself). Resumed from the app, a run keeps its token, so its cap must have room, unless that token was revoked: then the app takes the run over and what it spends from then on counts against no token. HTTP API runs cost nothing here and are never stopped by the cap. Calls already in flight finish and count, also when you pause or stop the run, so spend can pass the cap by those calls alone: up to an AI run's concurrency (default 5, at most 100) for each run, with up to 4 runs at once, and a preview's rows (up to 20; each token runs at most 3 previews at once, and the app another 3). An enrichment or waterfall run with a per-row cap holds room for its rows first, so it stops before the cap. The token list shows each token's spend, cap and what is left, and the agent sees the same in `get_balances`, `GET /api/v1/me` and the run tools' descriptions. Only the app can set a cap; a token never can. Spend counts from the update that added caps, so older runs don't count. On your own provider key (BYOK) a row counts what OpenRouter charged plus what your provider billed, and the provider's part now also counts when OpenRouter sends only its two halves (input and output) and no total. So runs on your own key reach this cap, and their own spend limit, sooner than they used to. When OpenRouter gives no figure at all for such a row, its `provider_cost_usd` is `null` (it used to be left out of the row) and only OpenRouter's charge counts.

## Setup

The quickest way for Claude Code, Codex and Cursor is the [Cubex plugin](agent-plugin.md): it adds the connection (in Claude Code and Codex, your address and token come from environment variables) and skills for the common jobs. Paste "Set up Cubex by following https://raw.githubusercontent.com/gurmohitghuman/cubex/main/docs/agent-plugin.md" into your agent.

To connect by hand, the **Agent access** page shows these commands with your Cubex address and token filled in.

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

**claude.ai connectors** connect from Anthropic's servers, so Cubex must be on the internet over HTTPS (see [Run Cubex on your own server](self-hosting.md)). They are built around OAuth sign-in, which Cubex doesn't offer: it uses access tokens. If your connector form has no place for an `Authorization` header, use one of the clients above.

Any other client that speaks MCP over Streamable HTTP works the same way: point it at `<your Cubex address>/mcp` and send `Authorization: Bearer <token>`.

## Protocol versions

Cubex speaks MCP [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), the current revision, and the earlier ones most clients still use: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07. How a client opens picks the version:

- **2026-07-28** has no handshake. Each request names its version and the client's capabilities in `_meta`, and sends the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. A client may call `server/discover` first: it answers the versions Cubex takes this way (`2026-07-28`), its capabilities (tools only), its instructions, and its name and version (`cubex`, `1.0.0`) in `_meta`.
- **2025-11-25 and earlier** open with `initialize`, as before.

Every request needs the token, `server/discover` and `initialize` too. Cubex keeps no session between requests, and each answer is one JSON body, except a `subscriptions/listen`, which answers `text/event-stream`.

On every version:

- `tools/list` gives every tool at once and hands out no cursor, so a request with a `cursor` gets error `-32602`.
- An unknown tool name gets a JSON-RPC error `-32602` (`Tool nope not found`). Clients on 2025-11-25 and earlier used to get it as a tool result with `isError: true`.
- A browser page from another site (a foreign `Origin` header) gets HTTP 403 with code `-31403`, and `GET` or `DELETE` on `/mcp` gets 405 with `-32600`. Neither answer has an `id`.

On 2026-07-28:

- Every answer carries `resultType: "complete"` and Cubex's name and version in `_meta` (`io.modelcontextprotocol/serverInfo`).
- `server/discover` and `tools/list` say how long a client may keep them: `ttlMs` 300000 (5 minutes) and `cacheScope` `"private"`. They can name your token's spend cap, so a cache must not share them between tokens. Cubex sends no notice when they change: the tools change with a new version of Cubex, and descriptions change with the token's spend cap and what it has spent. A client sees each change within 5 minutes.
- `tools/list` gives every tool at once, in the same order every time. Every token sees every tool: one its scopes don't allow refuses with a message that names the scope.
- Tool input schemas are JSON Schema 2020-12. A wrong type or a value out of range comes back as a tool result with `isError: true`, such as `Input validation error: Invalid arguments for tool read_rows: max_chars_per_cell: max_chars_per_cell must be an integer from 1 to 200000.`
- Errors: a version Cubex doesn't speak gets HTTP 400 with code `-32022` and, in `data.supported`, every version it speaks, newest first: `2026-07-28`, then the five a client reaches with `initialize`. Headers that are missing or disagree with the body get 400 with `-32020` (an `Mcp-Name` sent as `=?base64?...?=` is decoded first). A `_meta` without `clientCapabilities`, or a request with the `MCP-Protocol-Version: 2026-07-28` header and no `_meta`, gets 400 with `-32602`. A method Cubex doesn't offer gets 404 with `-32601`.

Not offered:

- Resources, prompts and completions: Cubex has tools only.
- Change notices. A `subscriptions/listen` is acknowledged with nothing and closed at once.
- Progress and log messages, sessions (an `Mcp-Session-Id` header is ignored) and streams to resume. `GET` and `DELETE` on `/mcp` answer 405.
- Anything on the spec's [deprecated list](https://modelcontextprotocol.io/specification/2026-07-28/deprecated): roots, sampling, logging, dynamic client registration and the old HTTP+SSE transport.
- OAuth sign-in: Cubex uses its own access tokens.

## Things to ask for

- "Import `leads.csv` into a new table called Leads."
- "In Leads, add an AI column that scores each company 1 to 10 for fit, using /company and /domain. Try it on 5 rows first and show me the results."
- "Run the fit score on every row, then tell me how many scored 8 or more."
- "Call `https://api.example.com/people?email={{email}}` for each row and add the job title and LinkedIn URL as columns."
- "The last run left some cells blank. Show me why, then re-run only those rows."
- "Export the rows where Status is Qualified, with just Email and Company."
- "Show me the rows where the work email enrichment failed, and why."
- "Find a verified work email for everyone in Leads, using Name and Website. Show me the estimate first."
- "Find a work email for everyone in Leads: try treg first, then our API at `https://api.example.com/find?domain={{domain}}`, and add a column saying which one found it. Show me the estimate first."
- "Add the people at each company in Accounts to a new sheet called People, 10 per company. Try 5 companies first and show me which fields come back."
- "In Leads, split Name into first and last name, turn Website into a domain and fix the phone numbers. Use the free cleaners."
- "In Leads, the Response column holds each API reply. Add a Work email column with the email whose type is work, using a formula."
- "Add an Industry column to Leads with the industry of each lead's company from the Companies sheet, matched on the domain."
- "Keep finding work emails for new rows in Leads automatically, up to $5 a day."
- "In Leads, score each company's fit with AI. Then find work emails only where the score is 8 or more, and add those people to Smartlead only where the email is valid."

## Tools

| Tool | What it does |
|---|---|
| `list_tables` | Tables and their sheets. Start here to turn names into ids. |
| `get_sheet` | A sheet's columns, row count, description, and how many rows and columns are left. `column_details` says what each column is and what fills it, and `include_counts` adds how many rows are filled, empty or errors. Also lists its clean, formula and lookup columns, and its saved views with their filters and hidden columns. See [Column details](#column-details). |
| `read_rows` | Rows, paged, with column selection and filters: text, numbers, lists, OR groups, and run states such as failed or not run yet. `include_status` returns run columns as `{status, value, error}`. `group_by` and `aggregates` count, sum and average per value instead of reading rows, and `columns` can take one value out of a JSON cell. See [Finding rows](#finding-rows). `row_ids` reads up to 1,000 rows by id, in the order given, and lists the ids that are no longer rows in `missing` ([Rows by id](#rows-by-id)). `updated_since` reads the rows whose cells changed since a time ([Keeping a copy up to date](#keeping-a-copy-up-to-date)). `max_chars_per_cell` cuts each cell to its first N characters and lists the cells cut in `cut_cells` ([Long cells](#long-cells)). |
| `export_csv` | A sheet (or a filtered part of it, or a saved view) as CSV, up to 40,000 characters. Past that it says how many rows matched; the rest comes from `read_rows`, or save the whole sheet with `create_download_link`. |
| `manage_view` | Create, change or delete a saved view: a name, a description, filters and hidden columns. Creating one never switches the view the app shows. See [Saved views](#saved-views). |
| `append_rows`, `update_cells`, `delete_rows` | Add, edit and delete rows by their stable row id. Deleted rows go to the trash. `append_rows` and `update_cells` take an `idempotency_key` so a retry can't write twice: see [Retrying row writes](#retrying-row-writes). |
| `add_column`, `rename_column`, `delete_column` | Manage columns. `add_column` takes an optional `description`. A deleted column goes to the trash with its cells, its place, its description and its own setup: see [The trash](#the-trash). |
| `set_column_order` | Put a sheet's columns in a new order: every column, once, by name. Rows, runs and views don't change. |
| `set_description` | Describe a column, or the sheet when `column` is left out. See [Descriptions](#descriptions). |
| `sort_sheet` | Permanently reorders the rows by a column. |
| `manage_table`, `manage_sheet` | Create, rename, delete and reorder tables and sheet tabs. A deleted table or sheet goes to the trash whole. `manage_sheet` with `action: "copy"` makes a new sheet right after one, holding its values: the same rows in the same order under plain columns that nothing fills, a run's words (⏳, ❌, ⏭️, ➕) left empty, and only the `columns` you list if you list some. Free; a way to keep a sheet as it is before running its columns again. `manage_table` with `action: "create_sample"` makes a table of 25 made-up leads to try Cubex on: its free columns filled, its duplicate found by a dry run, and an AI column set up but not run (the answer says how to run it once the user agrees). |
| `import_csv` | Load CSV text into a sheet (append or replace). For a file, use `create_upload_link`. |
| `ai_visibility` | A ready-made table that asks AI engines a list of buyer questions and says whether each answer names a brand, plus the sites they cite, and weeks later checks again, keeping the old answers to compare. Asking is paid: estimate first, its default. See [AI visibility](#ai-visibility). |
| `create_upload_link`, `create_download_link` | One-time links to move a CSV file of any size into or out of a sheet with `curl`. See [Big CSV files](#big-csv-files). |
| `run_ai_column` | Start an AI column run. Can estimate the cost first, refuse to start over a cost ceiling, stop at a spend limit, preview a few rows, target specific rows, or fill several typed columns at once. See [Cost ceiling and spend limits](#cost-ceiling-and-spend-limits). |
| `run_http_enrichment` | Start an HTTP API column run, from a URL or a whole cURL command. Failed requests are retried; it can leave out empty values and add a response code column. |
| `check_run_condition`, `write_run_condition` | Check an "Only run if" rule on a sheet (free), or write one from plain words with your default AI model. See [Only run if](#only-run-if). |
| `get_run_status`, `list_runs` | Follow a run, or find recent ones. |
| `get_run_results` | Per-row results and errors, to see why cells are blank or wrong. |
| `control_run` | Pause, resume, cancel, or re-run (failed rows, empty rows, rows whose result is out of date, all, or only the sheet's first rows with `first_rows`). A cancelled run keeps the answers it wrote; the rows it hadn't reached get back what they held before it. `spend_limit_usd` raises the limit an AI, enrichment or waterfall run paused at, or sets a rerun's. `concurrency` changes how many rows run at once on an AI, HTTP API or enrichment rerun, and on an HTTP API or enrichment resume: for an HTTP API run it is the run's batch size, which later reruns and the column's auto-run batches repeat, so a 10-row test's batch size doesn't have to carry into the full run. `cancel_all` with a `sheet_id` stops every run and setup on that sheet at once. |
| `undo_run` | Undo what a finished run wrote: its cells go back to what they held before it, cells changed since stay as they are, and nothing runs again or is billed. See [Undo a run](#undo-a-run). |
| `list_models`, `set_default_model` | Find OpenRouter models and set the default. `:batch` models aren't listed: they run only through OpenRouter's batch API, so a run on one (its start, estimate, preview, resume or rerun), a waterfall step, a waterfall's resume, `write_formula`, `write_run_condition` and a default on one are refused with the model to use instead. |
| `get_balances` | What the account can spend: the treg balance, the enrichment daily limit, what OpenRouter reports for the saved key (its account balance only reaches a management key, so often just the key's own limit), and this token's spend cap with what is left (`access_token`). `openrouter.checked_at` is when Cubex read OpenRouter's numbers (a read is reused for 30 seconds). They can lag behind runs that just finished, while `access_token.spent_usd` is live. Costs nothing. |
| `get_usage` | What AI, HTTP API and enrichment runs ran and cost, by column (deleted ones too), day or run, for one sheet or the whole account, over this week, this month, last week, last month or two days you pick. Each row has runs, cells run, cells reused from earlier answers, the cost (OpenRouter, your own AI provider key, treg) and the cost per cell. Costs nothing. |
| `clean_column` | Free cleaning into a new column: names, first and last names, company names, emails, domains, phone numbers, Title Case, lowercase, spaces and garbled characters. No AI and no credits. See [Clean data](#clean-data). |
| `lookup_column` | A new column filled for free from another sheet: a column of the first matching row, yes/no, a count, or the matching rows. See [Lookups](#lookups). |
| `formula_column`, `write_formula` | A new column worked out for free from each row by a JavaScript formula, like picking an item out of an API response by a condition. `write_formula` writes the formula from plain words with your default AI model. See [Formulas](#formulas). |
| `remove_duplicates` | Find rows that match on one or more columns (as text, email, domain, phone, company or person name) and remove all but one of each, for free. A dry run unless `dry_run: false`. See [Remove duplicates](#remove-duplicates). |
| `set_auto_dedupe` | Keep one row per key as rows arrive (webhooks, appends, imports, transfers, edits), for free: the oldest or the newest row of a key stays, the others go to the trash. See [Auto-dedupe](#auto-dedupe). |
| `list_setups`, `save_setup`, `delete_setup` | Save a sheet's filled columns, and every filled column they read, as a named setup; list and delete the saved ones. See [Setups](#setups). |
| `list_setup_versions`, `manage_setup_version`, `restore_setup_version` | Keep a sheet's column setup by name (every column's prompt, request, formula, cleaner, lookup, "Only run if" rule, auto-run, description and the column order, never the values), compare one with the sheet now, and restore it without running anything. See [Setup versions](#setup-versions). |
| `apply_setup`, `get_setup_run`, `control_setup_run` | Build a saved setup's columns on another sheet and fill them in order (an estimate unless `estimate_only: false`, refused over a `max_cost_usd` ceiling), follow it, and pause, resume or stop it. See [Setups](#setups). |
| `transform_column` | Free text transforms (upper/lower case, trim, number, regex extract, split, template) with no model call. It works through the sheet a page at a time, so the server keeps answering. A call writes at most 10,000 rows or works about 2 seconds; the rows it wrote stay written. When it stops with rows left, the answer adds `next_cursor` and a `note`: call again with the same arguments and `cursor` set to it to go on after the last row it looked at. A call that spent all its time waiting for the database file to catch up with earlier writes answers `updated: 0` and a note saying so; its `next_cursor` goes on from where the pass is. A cursor works only with the sheet and the arguments it came from (the target column, the operation and its parameters, and `where`; a rename of the target column keeps it working; a `template` that read the target names it as it is now, `{{T2}}` once `T` is renamed `T2`, and the refusal of `{{T}}` says so), only while its pass is open, and only as the latest `next_cursor` that pass answered. Anything else is refused, writing nothing: a cursor from another call or with other arguments; an older or edited cursor of an open pass, with an error naming the pass's current one; a cursor whose pass is no longer open (it reached the end, was restarted, was replaced by a call without `cursor` before it wrote a row, or its column or sheet was deleted for good), with an error naming none. If a call stops on an error after writing rows (for instance, the database stayed busy past its wait), it answers an error with `next_cursor` and `rows_done`, the rows written so far: go on with that cursor. A column has at most one unfinished pass: until a pass that wrote rows gets to the end, whatever stopped it (its limit, an error, a server restart), any call writing that column without the pass's cursor is refused with an error carrying that `next_cursor` and `rows_done`, since starting over would apply the operation to those rows twice. A pass whose call stopped at its limit before writing a row is unfinished too, and its cursor goes on the same way, but a call without `cursor` isn't refused: since no row has the operation yet, it starts a new pass from the first row in its place, and the old cursor no longer works. `restart: true` (never with `cursor`) discards that pass and starts the column over from the first row, applying the operation to every row again: use it when rows changed since the pass stopped, or to run the column with different arguments. A column, sheet or table sent to the trash keeps its unfinished pass, and restoring it brings the pass back: a restored column's pass goes on under the name the column comes back as (`T (restored)` when a column `T` was added meanwhile, which has no pass and runs from the top). The pass is dropped when its column, sheet or table is deleted for good (Settings keeping 0 days) or purged from the trash. A column that a CSV replace or an import undo removes is gone for good, so its pass ends too, and so is the starter `Column 1` that a `transfer_rows` into a sheet still as created replaces. When its rows move (sorted, replaced by a CSV import or such an import undone, duplicates removed, or rows restored from the trash to other places than they had, when the old place or the new one is at or before where the pass had reached), the pass stays but can't go on: every call into its column is refused, with its cursor or without, writing nothing, with an error saying how many rows the pass had done. Only `restart: true` runs the column then, applying the operation to every row again, so the rows the pass had done get it twice (a pass that had done none is replaced by a call without `cursor`, as above). A column in the trash during such a move comes back with its pass in that state, and a copy of the sheet made after it gets its pass in that state too. Rows restored to other places that are all after where the pass had reached leave it going on. A copy of the sheet (`manage_sheet` with `action: "copy"`) that keeps the column gets an unfinished pass of its own at the same row, with its own cursor; the original's cursor doesn't work on it. A new target column is added to the sheet's columns without writing into the rows it skipped, which read as empty, as with `add_column`. Every column a call reads must be in the sheet: a `source_column` or a `where` column it doesn't have was already refused, and now a `template` naming one is refused too, naming the missing columns, before anything is written (such a call used to write the template's text around an empty value, `-x` for `{{Missing}}-x`). |
| `transfer_rows` | Copy or move rows between sheets on the server. A move is refused while a stopped run is still putting back any column of the source sheet, copied or not: the rows go to the trash whole. |
| `search_enrichments`, `get_enrichment` | Find a treg.to enrichment tool, then read its inputs, outputs, price and providers. See [Enrichments](#enrichments). |
| `run_enrichment` | Run an enrichment per row: work emails, phones, person or company data, or lists that become rows in another sheet. Can estimate first, test on 5 rows, and turn on auto-run. |
| `get_list_fields`, `add_list_rows` | For a job that adds rows: read the fields its results really have, then pick the ones to keep and add the rows. |
| `add_enrichment_field` | A new column filled from answers a run already stored, for free. |
| `waterfall_column` | One value per row (a work email, a phone, a domain, any text) from steps tried in turn until one answers: treg tools, AI prompts, your own APIs, free formulas and lookups in your other sheets, with the step that answered in its own column. An estimate unless `estimate_only: false`. See [Waterfalls](#waterfalls). |
| `set_auto_run` | Turn auto-run on or off for an enrichment, HTTP API, clean, formula or lookup column, or pause and resume it. |
| `list_saved_keys` | The saved API keys by name, never their values: when each was saved and last changed, and where it's used, each HTTP API, enrichment or waterfall column whose request names it (with its sheet, and whether auto-run is on) and each saved setup that names it. Up to 20 keys a call with 10 places and 10 setups each, and whole counts (`keys_count`, `used_in_count`, `setups_count`). When more keys are left, the answer has `next_after`: pass it as `after` for the next ones. `name` gives one key (any case) with up to 50 places and 50 setups. Sheets in the trash and setup versions are left out. Needs only the `read` scope. |
| `list_run_webhooks`, `manage_run_webhook` | The account's run webhooks (URLs told when a run finishes), and one webhook's last 50 deliveries. Pass a webhook's id as `webhook_id` when you start a run to hear when it ends. See [Run webhooks](run-webhooks.md). `manage_run_webhook` adds, changes and deletes them, makes a new signing secret or sends a test notice (`run` scope). |
| `list_trash`, `restore_from_trash` | What was deleted and can still come back: batches of rows, columns, sheets and tables. Look inside a batch or a column and search it, then restore whole items or rows you pick. See [The trash](#the-trash). |
| `get_sheet_history` | A sheet's change log: columns added, renamed, deleted and restored, runs, auto-run, views, its webhook, rows deleted (auto-dedupe's included), restored and imported, with when and who (the app or an access token by name). See [The trash](#the-trash). |

Deleted rows, columns, sheets and tables go to the trash for the days set in Settings (30 by default), and the delete's answer says how to restore them; sorting and deleting a setup or a setup version are permanent. What a run wrote can be undone for 7 days with `undo_run`. Every tool tells your client whether it only reads, adds, or changes and deletes data, so clients can ask you before the risky ones.

When auto-run is on in a sheet, `append_rows`, `import_csv` and `transfer_rows` (and the REST appends and imports) answer with `auto_run`: the columns that will fill the new rows on their own, each with its estimated cost (`estimated_usd`) or, for an HTTP API column, `sends_requests: true`.

Starting a run on a very large sheet answers at once: the run shows as pending while Cubex marks its rows, then starts. Cancelling also answers at once; its leftover ⏳ cells clear in the background. Rows the run already answered keep their new answers, and every row it hadn't reached gets back what its cells held before the run (an earlier answer comes back as it was; a cell that was empty stays empty). A run that fails or can't start does the same. Clean, formula and lookup columns that read one of those cells then work it out again. That's free: nothing that costs or sends requests runs.

## Retrying row writes

`append_rows` and `update_cells`, and their REST routes, take an optional `idempotency_key` (1 to 200 characters), so a call that timed out can be sent again without adding the rows twice:

- The same key with the same arguments within 24 hours answers as the first call did, with `replayed: true`, and writes nothing. The first call answers `replayed: false`. A replay leaves out `auto_run`, since the first call already set those runs off.
- The same key with other arguments is refused with `Idempotency key was already used with different arguments.` (a `409` over REST), and nothing is written.
- The same arguments means the same sheet and the same values as Cubex reads them: `1` and `"1"` are the same, so are `null` and `""`, and the order of a row's columns doesn't matter. Appended rows must come in the same order. For `update_cells`, the many-rows form's updates can come in any order, and the one-row form is the same call with or without its row's `sheet_id`.
- Two calls with one key at the same moment write once: the other answers as a replay.
- Keys belong to the account, not to a token or a sheet: the same key sent over REST or from another token replays too. Run starts and `transfer_rows` use the same keys, so use a new key for each separate call.
- A replay returns the first answer as it was, whatever happened since: the ids of rows deleted since, each row's `index` from before a sort, a one-row update's cells as they were then. Read the rows to see them now.
- A replay answers even after the sheet went to the trash, where an append or a many-row update with a new key gets `Sheet not found`, and while the sheet is busy sorting or importing, where an update with a new key is refused as busy, as one without a key is.
- When auto-dedupe sent rows to the trash, a row write's replay says how to restore them in the words of the surface asking: the MCP tool or the REST route. A `transfer_rows` replay keeps the first call's words.
- A replay of a one-row update keeps the row's cells up to 16 KB; past that it leaves them out and says `data_left_out: true`. Read the row to see them.
- Cubex keeps the newest 10,000 keys of row writes (run and transfer keys aside), each for 24 hours. Past that the key is free again, for a row write, a run start or `transfer_rows`. Without a key, nothing changes.

## Finding rows

`read_rows`, `export_csv`, `create_download_link`, `transfer_rows` and `transform_column` take `where`: a list of conditions a row must all pass. An item can also be a group: `{"or": [...]}` passes when any of its items does, `{"and": [...]}` when all of them do, and a group's items can be groups too, up to 5 deep (50 conditions in all). A condition with `"enabled": false` is turned off: it's kept, but no read counts it, and a group with nothing left on counts for nothing.

```json
[
  {"column": "Industry", "operator": "any_of", "values": ["SaaS", "Fintech"]},
  {"column": "Signed up", "operator": "date_gte", "value": "2024-01-01"},
  {"or": [
    {"column": "Email", "operator": "empty"},
    {"and": [{"column": "Phone", "operator": "empty"}, {"column": "Country", "operator": "eq", "value": "US"}]}
  ]}
]
```

- **Text:** `eq`, `neq`, `contains`, `not_contains`, `starts_with`, `ends_with`, `empty` and `not_empty`. `any_of` and `not_any_of` take `values`, a list. They ignore case and spaces at either end.
- **Numbers:** `gt`, `gte`, `lt` and `lte`. The cell has to hold a number (`1,000` counts, `1,5` doesn't); other cells never pass.
- **Dates:** `date_eq`, `date_neq`, `date_gt` (after), `date_gte`, `date_lt` (before) and `date_lte` compare calendar days. The cell and `value` have to hold a date: `2024-01-31`, `2024/01/31`, `1/31/2024`, `31.1.2024`, `Jan 31, 2024`, `31 Jan 2024` or `Wed, 31 Jan 2024`, with or without a time after it (`2024-01-31T10:30:00Z`, `1/31/2024 10:30 PM`). The day is the one written: the time and its zone are left out. With slashes or dashes and the year last, the month comes first unless the first number is over 12 (`13/1/2024` is 13 January); with dots the day comes first. Years have four digits, and a bare number (`20240131`, a Unix time) isn't a date. Other cells never pass a date condition, `date_neq` included: find blank ones with `empty`.
- **Run state**, on AI, HTTP API, enrichment and waterfall columns: `has_error`, `has_result`, `not_run`, `condition_not_met`, `running` and `out_of_date` (a result made from input cells that changed since; see below). They read the words runs write into cells (`❌`, `⏭️ Condition not met`, `⏳`, `➕`), so you don't have to. Leave `column` out to match any run column: `[{"operator": "has_error"}]` finds every row where a run failed. An output column reads the state from its run's status column, so `has_error` on Email finds the rows where the enrichment that fills Email failed.

Text conditions compare a cell as written, status words included. To page a filtered read, send back `expected_data_version` and `expected_row_generation` from the previous page; if the sheet changed in between, you're asked to start again. `return_mode: "count"` counts the matching rows without reading them.

With `include_status: true`, `read_rows` (and the REST row reads) return each run column's cell as `{status, value, error}`:

| `status` | Meaning |
|---|---|
| `done` | `value` holds the result. |
| `no_result` | The run finished without a value here. `reason` gives Cubex's words when there are any (`Not found`, `Budget ran out`, `No data`). |
| `error` | The run failed. `error` says why. |
| `condition_not_met` | The row's "Only run if" rule kept it out. |
| `running` | Waiting, running, or adding rows to another sheet. |
| `not_run` | Never run. |
| `out_of_date` | The row has a result (`value`, or `reason` for one without a value) made from input cells that changed since. A rerun with mode `out_of_date` refreshes it. |

**Out of date.** Each run remembers, row by row, the values of the input cells it was sent: an AI column's `/column` references, an HTTP API column's `{{column}}` tokens, an enrichment's or a waterfall's inputs. When one of them changes, the row's result is out of date: `include_status` says so, `where` finds it with `out_of_date`, and `control_run` (or REST) with mode `out_of_date` reruns only those rows (`empty_or_out_of_date` adds the rows never run). A column whose setup now reads other columns than a row was made from counts that row as out of date too. Rows filled before this version, and rows restored from the trash, carry no record and never read as out of date until they run again.

Other columns come back as text, the same as without it.

In the app, **Filter** in the bar above the grid edits the view's whole filter: rules joined with and or or, groups inside groups, and a switch on each rule to turn it off and on. Each column's menu has the same filters, one per column: text, number, date and list conditions on any column, and on a run column **Rows with errors** plus the other run states. A column's first rule that is on shows in its menu, the rest in **Filter**. **Is any of** lists the column's most common values with how many rows hold each (counted over the view's other filters), with a box to narrow the list; a value typed there and Enter adds it, even one the list doesn't show.

### Counting and summing

Pass `group_by` (up to 3 columns) and `aggregates` to get groups instead of rows. Groups compare values the way `eq` does (case and outer spaces ignored); an empty cell is the group `""`.

```json
{"group_by": ["Industry"], "aggregates": [{"op": "sum", "column": "Revenue"}, {"op": "avg", "column": "Revenue"}],
 "where": [{"column": "Country", "operator": "eq", "value": "Germany"}]}
```

The answer has `rows_matched`, `group_count`, `groups` (the 1,000 largest by row count, each `{group, count, values}`, ties by value) and `truncated` when there were more. `op` is `count` (rows; with a `column`, its non-empty cells), `sum`, `avg`, `min` or `max`. Numbers are read as `gt` reads them: `1,000` counts, text that isn't a number is skipped, and the value is `null` when no cell held one. Leave `group_by` out to aggregate over every matching row at once. It takes `where` and `view`, not `cursor`, `limit`, `columns`, `return_mode` or `include_status`. Grouping by a column with very many different values (emails, ids) stops past 100,000 groups with a message. While the sheet is busy with an import, a sort or a column filling, it answers busy (REST: 409 with `busy: true`): try again when that finishes. Over MCP a long answer keeps the largest groups up to about 40,000 characters and says `truncated`.

### Values inside JSON cells

An item of `columns` can take one value out of a cell holding JSON, such as an HTTP API answer:

```json
{"columns": ["Company", {"column": "Response", "path": ["data", "emails", 0], "as": "Email"}]}
```

`path` is a list of plain keys, at most 5: an object's key, or a list position from 0. It is not JSONPath. The value comes back as it is in the JSON (text, number, object or list), or `null` when the cell isn't JSON or has no such key. Without `as`, it is named after its path (`Response.data.emails.0`).

### Saved views

A view is a name, an optional description, filters and hidden columns. It never sorts rows (a sort is a one-time reorder of the sheet) and never changes the column order. Every sheet has a **Default** view, which can't be deleted. In the app, switch views from the bar above the grid; a new view starts as a copy of the one showing, and changing a filter or hiding a column changes the view showing. The view menu also offers two ready-made views, made only when you pick one: **Rows with errors** (any AI, HTTP API or enrichment column has an error) and **Fully filled rows** (every one of those columns has a result).

`read_rows`, `export_csv` and `create_download_link` (and REST `rows/query` and `export`) take `view`, a view's name or id, or `active` for the one the app shows: its filters are added to `where`, and when it hides columns its visible columns are the columns unless you pass `columns`. A read through a view answers `view_version`; to page, send it back as `expected_view_version` (plus `expected_data_version` and `expected_row_generation` when the view filters), and you're asked to start again if someone switched or edited the view in between. `get_sheet` lists the views, each with its filters as a `where`. `manage_view` creates, changes and deletes them (the REST endpoints below do the same): `where` and `hidden_columns` replace what a view had, `null` clears them, creating a view never switches the one the app shows, and the Default view can't be deleted.

### Rows by id

`row_ids` (1 to 1,000 row ids) reads exactly those rows, in the order you give, each with its `updated_at`. Ids that are no row of this sheet come back in `missing`: a deleted row (`list_trash` shows the ones in the trash), another sheet's row, or an id that never was one. It reads only the rows you name, so it takes `columns` and `include_status` but not `where`, `view`, `cursor`, `limit`, `return_mode`, `group_by` or the `expected_*` versions, and an id named twice is refused. Use it to read again the rows you already know, such as the ones a run just filled. With `include_status`, a failed run cell's `error` is the whole message its run recorded when Cubex finds it within a short look (up to 2,000 lookups or 50 ms), and otherwise the cell's own words: an HTTP API cell only says `❌ Error`, and an enrichment's cell is cut to 120 characters. The look starts at the column's newest run, so on a column with thousands of runs (auto-run makes one per batch) a failure from an older run usually reads the cell's words. A page read keeps giving the cell's own words. Over MCP the rows stop at about 40,000 characters, and `unread_ids` lists the ids left to ask for again.

### Keeping a copy up to date

`updated_since` returns the rows whose cells changed at or after a time, oldest change first, each with its `updated_at` and its cells as the row holds them. Times are UTC whole seconds, written `2026-11-05T10:00:00Z` (ISO 8601 with seconds and a zone; an offset such as `+01:00` works too) or `2026-11-05 10:00:00`. Page with `limit` and `cursor` (the `next_cursor` text) until `next_cursor` is `null`; a cursor works only with the sheet and the `updated_since` it came from. Every answer carries `as_of` and `filling`:

1. Read with `updated_since` set to an early time (`2000-01-01T00:00:00Z`) for a first full copy, and save each row by its `id`.
2. Follow `next_cursor` to the end.
3. Next time, read with `updated_since` set to the `as_of` you got, and so on.
4. Now and then, drop the rows that are gone: list the sheet's ids with `return_mode` `ids` (paged with `cursor`) and delete from your copy the ids that aren't there, or read your ids with `row_ids` and delete the ones in `missing`. A read by time never shows a deleted row, whatever deleted it: a person or `delete_rows`, removing duplicates (by hand or auto-dedupe), or a CSV import that replaces the sheet. The trash keeps them only for the days set in Settings (0 deletes them at once), so `list_trash` isn't a record of them.

`as_of` is 30 seconds before the read started, and a read takes the whole second it starts at, so a change still saving at that moment isn't missed. This counts on the server's clock not jumping back: after it is set back by more than that, read again from the start. A row can come back in the next read for the same reason: dedupe by `id` and keep the one read last (two changes in the same second share an `updated_at`). A walk reads the changes made up to its first page; later ones come in the next walk. A sort only moves rows, so it isn't a change: `index` can differ from your copy, `id` never does. Every other change to a cell counts: edits, appends, imports, webhooks, runs (their ⏳ and other marks too), clean, formula and lookup fills, transforms, transfers, rows restored from the trash (as of when they came back) and undone runs. A column rename or delete changes every row holding that cell. A whole sheet restored from the trash comes back with its rows' old times, so read it again from the start.

`filling` lists the columns you read that are being filled right now: a clean, formula or lookup column, or a column added from stored answers. Other reads show their cells as `⏳ Processing...` until the fill ends; a read by time gives what the rows hold instead, because a fill changes `updated_at` only on the rows whose value it changes. Those rows come in a later read, so keep reading from `as_of` and treat those columns as unfinished while `filling` names them.

With `include_status`, a run cell's state can change without its row's `updated_at` moving: `out_of_date` compares the row's cells with what the column's newest run reads, so a change outside the row, such as a new setup for the column that reads other columns, can turn rows out of date (or back). If your copy keeps run states, read them again with `row_ids` when you need them current.

### Long cells

AI answers and HTTP API responses can run to thousands of characters a cell, and a page of them can be far more text than you need. Pass `max_chars_per_cell` (1 to 200,000) to `read_rows` or REST `rows/query`, and each cell longer than that comes back cut to its first N characters. The answer then has `cut_cells`: the id of each row with a cell cut, and under it each cut cell's column with the length of its full text. Rows come in the order they are returned, and a row's columns in the order of its `data`; a row with nothing cut isn't listed. `cut_cells` is `{}` when you pass `max_chars_per_cell` and nothing was cut, and isn't there when you don't pass it. Read a cell whole with `row_ids` and `columns`.

```json
{"max_chars_per_cell": 40, "columns": ["Company", "Summary"], "limit": 2}
```

answers

```json
{
  "rows": [
    {"id": "0b6d3f0e-5c1a-4e8e-9f61-2a7c1d9e4b10", "index": 0,
     "data": {"Company": "Acme", "Summary": "Acme makes industrial pumps and sells th"}},
    {"id": "7e21c9a4-0d3b-4f5e-8a6c-91b2d4e0f3a7", "index": 1,
     "data": {"Company": "Beta", "Summary": "A short summary."}}
  ],
  "cut_cells": {"0b6d3f0e-5c1a-4e8e-9f61-2a7c1d9e4b10": {"Summary": 78}},
  "next_cursor": 1,
  "data_version": 12,
  "row_generation": 0
}
```

- Characters are counted the way JavaScript counts them, as every limit in Cubex is: most characters count 1, an emoji 2 (a surrogate pair). A cut never leaves half of a surrogate pair: when it would, the cell keeps one character fewer. An emoji built from several characters, such as one with a skin tone, a flag or a family, can lose its last parts.
- Cells are text. A cell holding JSON is cut like any text, so the cut JSON no longer parses: take values out of it with a `columns` path instead ([Values inside JSON cells](#values-inside-json-cells)).
- A value a `columns` path takes out is cut the same way when it is text. An object or list is measured by its JSON text; when that is longer, it comes back as that text, cut. Numbers, `true`, `false` and `null` are never cut. `cut_cells` lists the value under the name it comes back under.
- With `include_status`, a run cell's `value` or `error` (or `reason`) is cut, and its length in `cut_cells` is that text's full length. Its `status` is never cut.
- It works with every read of rows: pages, `where`, views (the columns the view shows), `row_ids` and `updated_since`. Over MCP, a read by id fits more rows into its 40,000 characters once they are cut: each row counts with its `cut_cells` entry, and the rows left for `unread_ids` leave their entries out too. A copy kept with `updated_since` holds the cut text: read the cells in `cut_cells` whole if you need them.
- `group_by`, `aggregates` and `return_mode` `ids` or `count` return no cells, so they refuse it, naming it with the other options to leave out. A group's value is already cut to 200 characters.
- Anything but a whole number from 1 to 200,000 is refused, and without `max_chars_per_cell` nothing is cut. On both surfaces, digits sent as text count as the number: `"200"` is 200, and so is `" 200 "` (whitespace around the digits is ignored). Any other text, such as `"1.5"`, `"1e3"`, `"0x10"` or `"-3"`, is refused.
  - REST answers 400 with `{"error": "max_chars_per_cell must be an integer from 1 to 200000."}`.
  - Over MCP the tool's schema says it: an integer, minimum 1, maximum 200,000. A value refused comes back as an error result (`isError: true`) whose text is `Input validation error: Invalid arguments for tool read_rows: max_chars_per_cell: max_chars_per_cell must be an integer from 1 to 200000.`

## Column details

`get_sheet` returns `column_details`: every column in the sheet's order, saying what it is and what fills it, so an agent can tell an AI column from a typed one before it runs or fixes anything.

```json
{"name": "Work email", "kind": "enrichment", "role": "status", "description": "Checked work email",
 "fill": {"run_id": "…", "run_status": "completed", "tool_id": "work_email", "tool_name": "Work email",
          "max_cost_per_row_usd": 0.05, "spend_limit_usd": 10},
 "reads": ["Name", "Domain"], "auto_run": true, "auto_run_caps": {"usd_per_day": 5},
 "run_if": "{{Title}} contains \"VP\"", "counts": {"filled": 412, "empty": 80, "errors": 8}}
```

- `kind` is `plain`, `ai`, `http`, `enrichment`, `waterfall`, `webhook`, `clean`, `formula` or `lookup`.
- A run that fills several columns describes its run on its main column. The others say which part they are (`role`) and name the main column in `filled_by`: an AI run's `answer` column, or its `status` column with `output` columns and a `sources` ("(Data)") column; an HTTP API column's `response` column and its `field` columns (with their `json_path`); an enrichment's `status` column and its `output` columns; a waterfall's result (`answer`) column, its `answered_by` column and a `step` column per step; a webhook's `payload` column and its `field` columns.
- `fill` is the column's newest run (`run_id` and `run_status`, for `get_run_status` and `control_run`; `restored` for a setup put back from a version, `set_up` for one a template set up that nothing has run) with its settings: an AI run's model and prompt, an HTTP API column's method, URL and header names (never their values; a key typed into the URL reads `…`), an enrichment's tool and its limits, a waterfall's result type, its steps in order (each with its tool, model and prompt, request, formula, or the sheet and columns it looks up) and its limits. A clean, formula or lookup column shows its setup.
- `reads` lists the columns it reads. `auto_run` says whether it fills new rows on its own (`auto_run_paused` says why it stopped, `auto_run_caps` gives its daily caps). `run_if` is the "Only run if" rule its next run checks.
- Prompts, formulas and URLs are cut to 300 characters. Name columns in `columns` to see them in full (up to 10,000 characters each and 40,000 in one answer; past that they are cut too). A very wide sheet lists its later columns by name and kind only, and `column_details_note` says so.
- `include_counts: true` adds `counts` to each column: `filled` (a value), `errors` (a failed run, or a cell starting with `❌`) and `empty` (the rest: blank, not run yet, skipped, condition not met, running). They agree with the `has_result` and `has_error` filters: an output column of a failed run counts as an error. Counting reads every row, about 0.7 s per column on a million rows, so it counts up to 20 columns: the ones in `columns`, or else the first 20. `counts_note` says what wasn't counted and why (a column still filling, or the sheet busy with an import or a sort).

REST: `GET /api/v1/sheets/:id?include_counts=true&columns=Email&columns=Phone`.

## Descriptions

A sheet and each column can have a description: a few words on what it holds, where its values come from or how to read them. People see a column's when they point at its name (an ⓘ marks it) and a sheet's when they point at its tab; agents read them in `get_sheet` (`description` and `column_details`). Descriptions are never added to AI prompts.

- `set_description` with `sheet_id`, `column` and `description` describes a column; leave `column` out to describe the sheet. An empty `description` removes it.
- Up to 1,000 characters for a column and 2,000 for a sheet. Line breaks are kept; invisible and direction-changing characters are removed.
- Renaming a column keeps its description; deleting the column deletes it.
- In the app: a column's menu has **Edit description…**, and so does a sheet tab's menu (the ⌃ on the tab).
- REST: `PATCH /sheets/:id/columns/:name` and `PATCH /tables/:tableId/sheets/:sheetId` take `description`, and `POST /sheets/:id/columns` takes it with the new column's `name`.

## Only run if

`run_ai_column`, `run_http_enrichment`, `run_enrichment` and `set_auto_run` take `run_if`, a rule a row must pass to run:

```
({{Industry}} is "SaaS" OR {{Industry}} is "Fintech") AND {{Employees}} > 50
```

Checks are `is`, `is not`, `contains`, `does not contain`, `is empty`, `is not empty`, `>`, `<`, `>=` and `<=`, and on dates `is before`, `is after`, `is on`, `is not on`, `is on or before` and `is on or after` (`{{Signed up}} is on or after 2024-01-01`; the cell needs a date, in the formats `where` reads), joined with `AND`, `OR`, `NOT` and brackets. Rows that fail it aren't sent anywhere, cost nothing, and show `⏭️ Condition not met` (a cell that already holds a result keeps it). Cells holding Cubex's own words (`⏳`, `❌`, `⏭️`, `➕`) count as empty, so a chain works: give each column a rule on the one before it, once that run has finished. A start is refused (`409`) while another run is filling a column the rule reads, or a stopped one is putting it back.

- `check_run_condition` (free) says how many rows pass and shows the first rows with the values the rule read. A misspelled column is refused with the closest name.
- `write_run_condition` writes a rule from plain words with one small call to your default model (or `model`), and returns it with the same check. The answer names the model and what the call cost.
- `estimate_only` counts only the rows that pass (`rows_skipped_by_rule`). `get_run_status` reports `run_if` and `condition_skipped_rows`. Reruns repeat the rule, and renaming a column updates the rules that name it.

## Clean data

`clean_column` cleans one column into a new column, for free: nothing is sent anywhere and no AI runs. Pick a `cleaner`:

| Cleaner | What it does | Example |
|---|---|---|
| `person_name` | Fixes words typed in ALL CAPS or lowercase (`John SMITH` too), turns "Last, First" around, and drops titles (Mr, Dr), suffixes (Jr, III, PhD, MBA) and nicknames. Words typed in mixed case, like DeShawn or McDonald, keep their capitals. Initials stay. | `smith, john q.` → `John Q. Smith` |
| `first_name`, `last_name` | The same, split. The first name skips initials (`J. Michael Fox` → `Michael`) and is never the last name, so initials alone before it give a blank (`J. Smith`, `Mr. R. Patel`, `J.`); a one-word value is a first name (`Prince`). One Han or Hangul character is a name, not an initial (`王 伟` → `王`); with a period, one letter is an initial in any script (`א. כהן` and `कु. कुमार` give a blank). The last name keeps words like "van" and "de la". Both read the column as full names: when it holds only first names, or only last names, pass `name_input: "first_name"` or `name_input: "last_name"`, so `Dr. Sarah` gives `Sarah` (not a blank) and `SMITH JONES` gives `Smith Jones` (not `Jones`). | `LUDWIG VAN BEETHOVEN` → `Ludwig`, `van Beethoven` |
| `company_name` | Drops legal endings (Inc, LLC, Corp, Co, Ltd, PLC, GmbH, AG, S.A. and more), a trailing ", a company of X", a bracket that never closes with what follows it, and a closing bracket that closes nothing at either end (`Acme ) Ltd` → `Acme`; one that ends an emoticon, as in `Acme :)`, stays), and fixes ALL CAPS. Keeps words like Holdings and Group. "The ... Company" loses both words (`The Coca-Cola Company` → `Coca-Cola`); for a company always named that way, pass `the_company: "keep"`: `The Christman Company` stays, other legal endings still go. | `ACME CO., LTD.` → `Acme`, `ImagineSoftware (Technology Partners` → `ImagineSoftware` |
| `email` | Pulls the address out of `Name <address>` or `mailto:`, and lowercases it. Blank when the format is invalid. It doesn't check that mail gets delivered. | `John <John.Smith@Acme.COM>` → `john.smith@acme.com` |
| `domain` | The root domain of a website or an email address. | `https://blog.acme.co.uk/about` → `acme.co.uk` |
| `phone` | One format for every number: `phone_format` is `national` (default), `international` or `e164`, and `phone_country` (default `US`) is how numbers without a country code are read. A number from another country comes out in international form. Blank when it isn't a real number. | `1-212-555-0123 x9` → `(212) 555-0123 ext. 9` |
| `title_case` | Capitalizes each word, keeps small words like "of" lowercase and acronyms like CEO upper. | `vp of sales` → `VP of Sales` |
| `lowercase` | Every letter lowercase. | |
| `trim` | Removes spaces at the ends, extra spaces and line breaks inside, and invisible characters. | |
| `fix_encoding` | Repairs text that was read with the wrong character set: UTF-8 read as Windows-1252 or Latin-1, once or twice over (up to three times). A spot it can't read, such as a character lost along the way, stays as it was and the text around it is still repaired. Unlike the others it changes nothing else: no spaces are tidied, and a value it can't repair stays exactly as it was, never blank. | `CafÃ©` → `Café`, `MÃƒÂ¼ller` → `Müller`, `Ã¢â‚¬â„¢` → `’` |

- The name and company cleaners (`person_name`, `first_name`, `last_name`, `company_name`) drop emoji, flags and symbols like ®, © and ™ (`Kowalski 👋` → `Kowalski`); an enclosed letter such as `Ⓜ` is a letter and stays, unless it is written as an emoji, and so does `℠`. They read full-width letters, digits and punctuation as plain ones and the ideographic space as a space (`Ｍｉｃｈａｅｌ` → `Michael`, `７－Ｅｌｅｖｅｎ` → `7-Eleven`), and keep every other character exactly as typed (`Mª José`, `№1`, `Henry Ⅷ`, `ﬁnn`, Thai). They leave placeholders blank: a whole value of n/a, #N/A, n.a., na, none, null, nil, blank, -, --, ?, unknown, test or tbd, in any case, with spaces, dots or brackets around it. Only whole values: `Test Kitchen` stays, and inside a longer value Nil, Null and Blank are words (`Gary Null` has the last name `Null`, `Blank Inc` the company name `Blank`). Written that way, with a capital and the rest lower case, `Nil`, `Null` and `Blank` stay even alone, so a cleaned value cleans to itself; `null`, `NULL`, `nil` or `blank` alone is blank. `Na` written that way is a name too (`Li Na`) on the person name cleaners. A cleaned value that is a placeholder is blank too (`Unknown Corp` → blank).
- `name_input` (`first_name` and `last_name` only) is `full_name` (the default), or the cleaner's own part: `first_name` on `first_name`, `last_name` on `last_name`. `the_company` (`company_name` only) is `strip` (the default) or `keep`. Any other pair, or an option on a cleaner that doesn't take it, is refused with the values it takes, every such option named in one answer, and nothing is written. A value outside these lists is refused too: MCP's input schema refuses it and names the values; REST answers 400 with the same sentence as a wrong pair. The answer and `get_sheet` repeat the options a column was made with (`phone_format`, `phone_country`, `name_input`, `the_company`).
- The new column is named after its source unless you pass `column`: `Name (clean)`, `Name (first name)`, `Name (last name)` or `Website (domain)`.
- `preview: true` shows the first rows before and after, and writes nothing.
- The answer waits for the column to fill, up to 10 seconds, and says how many rows it cleaned (`cleaned_rows`) and how many values it couldn't read (`blank_rows`). A bigger sheet answers `status: "filling"`; its cells read `⏳ Processing...` until it's done.
- Auto-run is on by default: new rows, and rows whose source cell changes, are cleaned on their own. If you fix a clean cell by hand, your fix stays until its source changes. Turn it off with `auto_run: false` or `set_auto_run`.
- Calling `clean_column` again on a clean column changes it (another cleaner, format or source) and cleans every row again. Any other existing column is refused, so nothing typed by a person is overwritten.

### Garbled text

Text saved in one character set and read in another comes out garbled: `Café` turns into `CafÃ©`, and `FraudFighter™` into `FraudFighterâ¢` with an invisible character (U+0084) after the `â`. Cubex keeps every cell as it was sent, those invisible U+0080 to U+009F characters included, because without them the text can't be repaired. Other control characters still go (tab and line breaks stay), and names and descriptions drop U+0080 to U+009F too.

- **On import.** When cells look garbled (they hold one of those characters, a sequence that lost a byte, or `fix_encoding` would change them), `import_csv`, an upload link and `POST /sheets/:id/import` add `garbled_cells`, how many, and `garbled_samples`, where the first 10 are, as `{"<row id>": ["<column>", ...]}`. It holds no values, so a file sent to an upload link stays out of the caller's context: `read_rows` (or `POST /sheets/:id/rows/query`) with those `row_ids` shows them. In the app, the import's message shows the cells themselves, each cut to its first 100 characters. Cells are counted as the file's rows arrive, so they include rows [auto-dedupe](#auto-dedupe) then didn't keep. A `note` says how to read and repair them; when cells were also cut to fit (`truncated_cells`), the one `note` says both. An import with no such cell answers as before, without these keys. A value over 1,000 characters is counted only when it holds one of those characters. Accented text such as `José`, `JOSÉ’S`, `Łódź`, `„Grüße“` or `€100` isn't counted.
- **In answers.** Every JSON answer writes these characters as `\u0080` to `\u009f` escapes: the app, REST, MCP and an upload link's result. They parse to the same text, and an answer printed in a terminal holds none of them as raw bytes. A CSV download keeps them as they are, so save it to a file (`curl -o`), as `create_download_link` suggests.
- **Repairing.** `clean_column` with `cleaner: "fix_encoding"` writes the repaired text into a new column (in the app: **Clean data**, **Fix garbled characters**). It repairs text garbled once or twice, as Windows-1252 or as Latin-1, so `MÃ¼ller`, `MÃƒÂ¼ller` and their Latin-1 forms with invisible characters all give `Müller`. Words in capitals whose letters took two bytes each (`ΑΘΗΝΑ`, `ИВАНОВ`, the Czech `PŘÍLIŠ`) are repaired whole. In `José – CafÃ©` only `CafÃ©` changes, and in `â€œquotedâ€`, a `”` that lost a character, the `“` is repaired and the rest stays. A repair never writes a character cells don't keep, such as a direction control: the text stays as it was there, and the import still counts it as garbled. What doesn't read as garbled stays as it was: real accented text, words in capitals before punctuation (`JOSÉ’S`, `AMANHÃ…`), a word in capitals ending in `É` before a sign (`NESCAFÉ™`, `NESCAFÉ®`), `ß` before punctuation (`Viel Spaß…`), and an accented letter before two punctuation marks (`“Cliché…”`, `«Ya está…»`, `hâlâ…”`, `Café` and a no-break space before `»` or `–`). A word in capitals ending in a capital before a footnote mark that would give a lowercase letter stays as it is, even in a cell with other garbled text (`AMANHÃ²`, `IRMÃ³`, `GÅ³`; `MÃ¼ller AMANHÃ²` gives `Müller AMANHÃ²`). A `×` read with the character after it that touches no other garbled character is repaired only in a cell that holds other garbled text (`1920`, a no-break space, `×`, a no-break space and `1080` stays); Hebrew words of two or more letters come as runs of such characters and are repaired, abbreviations of single letters aren't (below).
  - Three bytes read right after a Latin letter give a Latin letter, a character of U+2000 to U+214F (quotes, dashes, `…`, `€`, `™`), a symbol (`Doneâœ“` gives `Done✓`, `Parisâ†’Berlin` gives `Paris→Berlin`, `xâ‰¥5` gives `x≥5`), or any character when another garbled character follows right after them: garbled Japanese, Chinese and Korean come as such runs (`USBã‚±ãƒ¼ãƒ–ãƒ«` gives `USBケーブル`). A symbol read from a lead and two marks that follow words (`»`, `«`, `…`, `“`, `”`, `„`, `’`, `‘`, `‚`, `–`, a long dash, `•`, `·`, `‹`, `›`, a no-break space, `¹`, `²` or `³`) whose second mark also follows a closing quote (`»`, `…`, `”`, `’`, `–`, a long dash, a no-break space, `¹`, `²`, `³`) and ends the word, unless that mark is a long dash or a no-break space, is not one of them; a letter read that way is repaired only in a cell that holds other garbled text. So `«Ya está»` and a long dash, `está»¹` and `Ya está»` before a no-break space stay. Vietnamese letters can have that shape: a cell whose only garbled letters are `ỗ` or `Ỡ`, or `ỹ`, `ỳ`, `Ỳ`, `ễ`, `Ồ`, `Ổ` or `Ỗ` ending a word, stays as it is and isn't counted (`Má»¹ Tho` for `Mỹ Tho`, `Hoa Ká»³`, `dá»…`); garbled twice, it comes back garbled once and is counted (`MÃ¡Â»Â¹` gives `Má»¹`). Inside a word they are repaired (`Quá»³nh` gives `Quỳnh`), `Má»¹ Tho, Viá»‡t Nam` gives `Mỹ Tho, Việt Nam`, and `Nguyá»…n`, `Há»“` and `thá»‹` alone give `Nguyễn`, `Hồ` and `thị`.
  - A word never mixes Latin letters with another script after a repair, except characters decoded from three or four bytes in a run, whatever their script: garbled Japanese, Chinese, Korean, Thai, Hindi and the like glued to a Latin word are repaired (`iPhoneç”¨ã‚±ãƒ¼ã‚¹` gives `iPhone用ケース`, `Nikeà¤œà¥‚à¤¤à¥‡` gives `Nikeजूते`). So a Greek unit right after a Latin letter stays as it is and isn't counted: `10kÎ©` and `100Î¼F` (for `10kΩ` and `100μF`); garbled twice, they give those and are counted. A single Japanese, Chinese or Korean character, alone or right after a Latin word, isn't a run and stays as it is (`iPhoneç”¨`, `çŽ‹` for `王`, `ê¹€` for `김`): its bytes are those of an accented letter before a sign and a quote, such as `«café™»`, which stays too. Garbled once, it is counted only when its form holds U+0080 to U+009F, as most Latin-1 forms do (`iPhoneç` + U+0094 + `¨`); `çŽ‹` (`王` as Windows-1252) and `PCç«¯` (`PC端` either way) aren't counted. Garbled twice, it comes back garbled once and is counted.
  - Other known edges: a cell whose value is a single garbled Cyrillic letter, such as `Ð’` for `В`, stays, since it reads the same as an accented capital before punctuation. `THƠ` garbled once (`THÆ` and a no-break space) stays and isn't counted, since it reads the same as `AMANHÃ` before a no-break space; garbled twice, it gives `THÆ` and a no-break space. A word in capitals ending in a capital and a footnote mark that read as a capital is repaired, as `LIETUVIÅ²` gives `LIETUVIŲ`, so the real `KYLLÄ¹` and `PÅ²` give `KYLLĹ` and `PŲ` and are counted. Other footnote and sign shapes that change and are counted: two letters, a capital and `Ã` before a footnote mark (`LÃ¹` gives `Lù`, as do `FÃ²`, `SÃ²`, `RÃ³`: one capital before a Latin-1 letter, the same shape as garbled `SÃ³` for `Só`), an accented capital alone before a footnote mark (`Classe É¹` gives `Classe ɹ`, `Tipo Ó²` gives `Tipo Ӳ`), and a word in capitals ending in `Ã` or `Å` before `™`, `®` or `©` (`IRMÃ®` gives `IRMî`, `AMANHÃ™` gives `AMANHÙ`, `PÅ®` gives `PŮ`). The Lithuanian `Jų` and `Tų` have the shape of a footnote after a capital and stay as they are: `JÅ³ namai` stays and isn't counted, and `JÅ³ vaikai ir Å¡uo` gives `JÅ³ vaikai ir šuo` and is counted. A Hebrew letter alone in a cell has the shape of a `×` before a mark: `×©` (for `ש`) stays and isn't counted, and garbled twice it comes back garbled once and is counted. So do abbreviations of single Hebrew letters: `100 ש"ח`, `5 ק"ג`, `30 ס"מ`, `12 ק"מ`, `80 מ"ר`, `ש"ח`, `ע"י`, `ת"א`, `א, ב, ג`, `(א)` and `א'` stay as they came when garbled once. Garbled once as Windows-1252, those written with `"` aren't counted (`×©"×` and a long dash for `ש"ח`), except `ת"א`, whose form holds U+0090; every other form of them holds U+0080 to U+009F and is counted. Garbled twice, they come back garbled once, or as they came when that form holds U+0080 to U+009F, and are counted. A value that also holds a Hebrew word of two or more letters is repaired whole (`בע"מ`, `צה"ל`, `ד"ר כהן`, `מחיר 100 ש"ח לק"ג`). A Hebrew word glued to a Latin word stays as it is and is counted (`Nike×©×œ×•×` and U+009D for `Nikeשלום`): Hebrew is a two-byte script, as Greek is.
  - A repair gets at most 8 rounds of work over all its passes and the check after the last: a pass takes one, and another each time a word in it would mix scripts while other sequences are left to decode. A value that needs more stays as it came: a made-up run of sequences can, garbled text rarely does.
- **A lost byte.** A cell saved while U+0080 to U+009F were dropped holds sequences that lost a byte: `FraudFighter™` garbled as Latin-1 is left as `FraudFighterâ¢`, `CODE Éxitos` as `CODE Ãxitos`. The import counts such a cell, and `fix_encoding` repairs the parts that are still whole and leaves each damaged spot as it came, since the byte it lost can't be known: `CafÃ© âMÃ¼llerâ` gives `Café âMüllerâ`. The shapes counted are: `â` before one of the signs a lost middle byte leaves (`â¢` from `™` or `•`, `â¦` from `…`, `â¬` from `€`, `â¡` from `‡`, `â£` from `♣`, `â¥` from `♥` or `≥`, `â°`, `â²`, `â³`, `â¹`, `âº`, `â¯`, `â¤`) or before `€` (`â€` from a `”`), when no other character read from a continuation byte follows; `Ã` before a lowercase letter (`Ãxitos`; a Guarani word starting that way, such as `Ãga`, is counted too), before a capital B, C, D, F, H, J, L, P, Q, T, V, W or X (`ÃCOLE`), or starting a word before a K or R (`ÃREA` from `ÁREA`, `ÃKOS`); and a word starting with `â` with a later one ending in `â` after a letter that doesn't itself follow `â` (`âquotedâ`). Some shapes read like real text and aren't counted when they are a cell's only sign: a bare `â` left by an apostrophe, a quote or a dash garbled as Latin-1 (`it’s` becomes `itâs`, like `pâte`), `â` before an apostrophe, other punctuation or a no-break space (Welsh `â’r`, Turkish `hâlâ…`), a letter that lost its second byte after `Ä` or `Å` (`Łukasz` becomes `Åukasz`, like `Åsa`), and `Ã` before a capital vowel, `Y`, or a capital G, M, N, S or Z, or inside a word before a K or R (`ÁNGEL` becomes `ÃNGEL`, like `SÃO`, the Vietnamese `LÃNG` or the Guarani `MITÃKUÑA` and `AKÃRAGUE`).

## Formulas

`formula_column` fills a new column for free with a formula worked out from each row: nothing is sent anywhere and no AI runs. A formula is one JavaScript expression that reads the row's cells as `{{Column name}}`:

| Formula | What it gives |
|---|---|
| `{{Response}}?.emails?.find(e => e.type == "work")?.value` | The work email out of an API response |
| `` `${{{First}}} ${{{Last}}}` `` | First and last name joined |
| `Number({{Price}}) * 1.2` | Price plus 20% |
| `{{Email}}?.split("@")[1]` | The part after the @ |
| `_.startCase({{Name}})` | Name in Start Case (`_` is Lodash) |

- Cells are text: use `Number()` for math. A cell holding JSON (text starting with `{` or `[`, like a whole response that `run_http_enrichment` wrote by mapping `$`) reaches the formula parsed, so `find`, `filter` and `map` work on it. That's how to pick an item by a condition: JSONPath mappings refuse filters.
- Cells holding Cubex's own words (`⏳`, `❌`, `⏭️`, `➕`) read as empty. Use optional chaining (`?.`) so a row without the data gives an empty cell instead of an error.
- The result is written as text; objects and lists as JSON; `null`, `undefined` and `NaN` as an empty cell. A row the formula can't work out shows `❌ <the error>`; the answer counts them in `error_rows` and names the first in `first_error`.
- `preview: true` shows the first rows with the cells the formula reads and its result, and writes nothing.
- The answer waits for the column to fill, up to 10 seconds. A bigger sheet answers `status: "filling"`; its cells read `⏳ Processing...` until it's done.
- Auto-run is on by default: new rows, and rows where a column the formula reads changes, are worked out again on their own. A fix you make by hand stays until one of those columns changes. Turn it off with `auto_run: false` or `set_auto_run`.
- Calling `formula_column` again on a formula column replaces its formula and works every row out again. Any other existing column is refused. Renaming a column a formula reads rewrites the formula.
- `write_formula` writes a formula from plain words with one small call to your default model (or `model`). The model sees the column names and what the first rows hold, and the formula is checked on those rows before it comes back with a preview. Nothing is saved: pass the formula to `formula_column`. It needs the `run` scope, because the call costs money.
- Formulas run in a sandbox inside Cubex, with no access to files, the network or the server, a memory limit and a time limit per row. A formula that keeps running out of time stops its column's fill (or pauses its auto-run) and says so.

## Lookups

`lookup_column` fills a new column of `sheet_id` for free from another sheet, `other_sheet_id` (any table; `list_tables` gives the ids). For each row, the value of `source_column` is matched against `match_column` of the other sheet, and the column gets, by `returns`:

| `returns` | What each row gets |
|---|---|
| `value` | `return_column` of the first matching row, top of the other sheet first |
| `exists` | `Yes` or `No` |
| `count` | How many rows match (`0` when none) |
| `list` | The first `limit` matches (1 to 100, default 10) as a JSON list of objects with `return_columns` (left out: every column) |

- `match` is `equals` (the default: the whole value) or `contains` (the value anywhere inside the other cell; it needs 3 or more characters and looks at the first 1,000 characters of each cell). Both ignore capital letters (accented ones too) and spaces around the value.
- An empty value gives an empty cell. Status cells (`⏳ ...`, `❌ ...`, `⏭️ ...`) read as empty on both sides. A row the lookup can't answer honestly shows `❌ <why>` and counts in `error_rows`: a contains value under 3 characters, or more than 10,000 rows containing it.
- The other sheet is read as it is when each row is worked out. Later changes there don't update the column: call `lookup_column` again with the same arguments to look every row up again.
- A lookup is refused while a run is filling its `match_column` or a column it returns by name (stop it or let it finish). A fill already going waits for a run that starts meanwhile on a column it reads (`waiting`), a rerun of chosen rows too, then looks every row up again from the first. The one exception is a run auto-run started for the rows it takes (new rows, and older ones not run yet): after one, it goes on where it was. A paused run doesn't hold it: the rows that run hasn't reached read as empty, and `paused_run` says so while the run is paused; call `lookup_column` again once it's done.
- A column it reads that a clean, formula or lookup column of the other sheet, or a column added from stored answers (`add_enrichment_field`), is filling doesn't stop it: the fill waits for that column to finish (`waiting`: `Waits for "Industry" in "Companies" to finish filling.`), then goes on by itself. If it had already written rows, it looks every row up again from the first, so no row mixes old and new values. It does the same after a run there is undone (`undo_run`), after the other sheet is sorted, replaced by an import or has duplicates removed, after a column it reads there is renamed (or deleted, for a `list` without `return_columns`), when such a fill or a run that isn't an auto-run batch started and finished (or a paused run went on or was cancelled) while it waited for something else, and after a restart if it had written rows. A run there that was stopped or failed holds the columns it wrote until its leftover ⏳ cells are back to what they held before it: the lookup waits for that too. A `list` without `return_columns` reads every column of the other sheet, so it waits for a fill of any of them.
- A fill looks every row up again at most 3 times for such changes (a restart doesn't count). After that it goes on where it was, and `kept_changing` says what kept changing, for example `"Name" in "People" kept changing, so rows looked up before its last change may hold older values. Look up every row again to redo them.` It stays after the fill ends, until the column is looked up again or Cubex restarts: call `lookup_column` again with the same arguments to redo those rows.
- Lookups that would wait for each other in a loop (each reads a column the next one is filling, back to the first) can't finish: their fills fail with an `error` naming each column and sheet, and a `lookup_column` call that would close such a loop is refused. Look them up again one at a time.
- `preview: true` shows the first rows with their results and writes nothing. When that column of the other sheet has no index yet (no lookup reads it), or its index is being built or brought up to date, the preview checks the other sheet's first 50,000 rows and says so (`checked_rows`).
- Auto-run is on by default: new rows, and rows whose `source_column` changes, are looked up on their own. Turn it off with `auto_run: false` or `set_auto_run`.
- Calling `lookup_column` again on a lookup column changes it and looks every row up again. Any other existing column is refused, and so is a lookup into its own sheet.
- Renaming a column of the other sheet updates the lookup. Deleting the other sheet, or a column the lookup reads, stops it: `get_sheet` shows why in `broken`, and `lookup_column` with new settings sets it up again.
- The answer waits for the fill up to 10 seconds and returns `filled_rows` and `error_rows`; a bigger sheet, or a fill still waiting (`waiting` says for what), returns status `filling` (`get_sheet` lists it in `filling_columns` until done). Contains on very large sheets can take a few minutes. A lookup column isn't a setup step: a setup reading one lists it as an input.

## Remove duplicates

`remove_duplicates` finds rows that match on every column you list and removes all but one row of each group, for free: nothing is sent anywhere and no AI runs. It's a dry run unless you pass `dry_run: false`, so a first call only reports.

```json
{"sheet_id": "...", "columns": [{"column": "Website", "match": "domain"}, "Last name"], "keep": "first", "dry_run": true}
```

- `columns`: column names, or `{"column", "match", "phone_country"}`. `match` is `text` (the default), `email`, `domain`, `phone`, `company` or `person_name`. Upper/lower case and extra spaces never matter.
- `keep`: `first` (the default, the highest row), `last`, or `most_complete` (the row filling the most cells; the highest of a tie).
- Some things that tell rows apart are kept even where the matching is loose: an address at a free email provider (Gmail, Outlook, Yahoo and others) never matches by `domain`, a page on a shared site (Facebook, LinkedIn, Instagram, Google Sites, Yelp, Substack and others) matches only the same page, a `phone` extension keeps numbers apart, and so do Jr and Sr in a `person_name`.
- A row with any listed column empty, unreadable as its match (an email column holding "n/a"), or holding a run status such as `⏭️ Not found` is never removed. The answer counts them in `rows_with_empty_key`.
- The answer has `rows_checked`, `duplicate_groups`, `rows_to_remove` (or `rows_removed`), `rows_left`, up to 5 `samples` (the row that stays and up to 3 that go, each with its row `id`, row number and the listed cells), and the `largest_group` when it's bigger than those, so a value like "n/a" shared by thousands of rows shows up before anything goes.
- A dry run needs the `read` scope; `dry_run: false` needs `write`. Removed rows go to the trash as one batch (the answer's `trash` says how to restore them); their AI and HTTP results go. The whole sheet is checked; filters don't apply.
- Refused while a run is active on the sheet: stop or finish it first. Rows appended while a removal works are left alone.

## Auto-dedupe

`set_auto_dedupe` keeps one row per key in a sheet from now on, for free. Pick one key column and how it matches (`match`, the same as `remove_duplicates`), and which row of a key stays:

```json
{"sheet_id": "...", "column": "Email", "match": "email", "keep": "oldest"}
```

- `keep`: `oldest` (the default: the row already there stays, a new row with its key is not kept) or `newest` (the new row replaces the older rows with its key, enriched cells and all).
- **What's checked:** a row that arrives (a webhook event, `append_rows`, `import_csv` or an upload link, `transfer_rows`, list rows from an enrichment), and a row someone gives a new key (`update_cells`, the app). Values that runs and other filled columns write, and rows `restore_from_trash` brings back, are never checked. Blank cells, run statuses and cells over 200 characters never match.
- **The key column** must be one rows arrive with: not an AI, HTTP, enrichment, waterfall, clean, formula or lookup column. To match on a cleaned value, pick the raw column and the `match` that cleans it (a website column as `domain`).
- **What it answers:** `append_rows`, `update_cells`, `transfer_rows` and `import_csv` answer `auto_dedupe`: which of the call's rows were `not_kept`, which older rows they `replaced`, and the `trash` batch with the `seqs` that put just those rows back (`restore_from_trash` with `trash_id` and `seqs`). Ids and `seqs` list at most 100 each, with whole counts (`not_kept_count`, `replaced_count`, `seqs_count`); past 100 seqs, `seq_ranges` names them all as `[first, last]` runs. A restore isn't checked, so the rows stay; a row that arrives later with the same key is checked against them like any other.
- **Where they go:** the trash, one batch per sheet a day. `list_trash` with `how: "auto_dedupe"` and the `sheet_id` lists them, and `get_sheet_history` has a line counting them (by Cubex).
- **Rows already there** stay as they are when it's turned on: `get_sheet`'s `auto_dedupe.shared_rows` says how many share a key with an older row, counted once the keys are built (`null` until then; when a change to the name or company cleaner builds them again, it is counted again), and `remove_duplicates` cleans those up once. On a big sheet the keys take a moment to read (`state: "building"`); rows arriving meanwhile are checked once it's done.
- **Runs:** a row a run is working on is never removed; that check waits for the run (`waiting_rows`). Turning it on, changing it and turning it off are refused while a run is active on the sheet.
- Call it again to change it (fields left out stay); `off: true` turns it off. `get_sheet` shows the setting as `auto_dedupe` (or `null`). Needs the `write` scope.

## The trash

Deleted rows, columns, sheets and tables aren't gone at once: they wait in the trash for the days set in Settings (30 by default, up to 90; 0 deletes at once), then are deleted. The app has a Trash page; agents use `list_trash` and `restore_from_trash`.

- **What goes there:** rows from `delete_rows`, `remove_duplicates`, an `import_csv` (or upload link) in replace mode, `transfer_rows` moving rows out, and the app's deletes, one batch per deletion; rows [auto-dedupe](#auto-dedupe) didn't keep, and rows a list job's rerun replaced, one batch per sheet a day; a deleted sheet or table, whole (rows, columns, runs, views, webhook). A deleted sheet's webhook answers 404 until it's back, and lookups into it stop with a message.
- **The answer:** each of those deletes answers with `trash`: `trash_id`, `kept_days`, `restorable_until` and `how_to_restore` (a column's also `state`, below).
- **Restoring rows:** a batch goes back to its old places when the sheet hasn't been sorted, replaced or deduplicated since and those places are free; otherwise to the end of the sheet, in the order the rows had. Rows keep their ids. Columns they need that the sheet lost come back (`columns_added`); when the sheet has no room for them, the restore is refused rather than leaving cells out. Rows moved out with `transfer_rows` are still in their new sheet, so restoring them keeps both. Auto-run doesn't run restored rows. A run active on the sheet refuses a restore. A batch over 20,000 rows answers `"state": "restoring"` and finishes in the background.
- **Finding rows:** `list_trash` with a batch's `trash_id` reads its rows (`seq`, `row_id`, `old_row_index`, `cells`); `column` and `contains` search them. Pass the `seq`s you want to `restore_from_trash` with that `trash_id`.
- **Restoring a sheet or table:** it comes back as it was, renamed "(restored)" if its name was taken meanwhile. A sheet whose table is in the trash waits for the table, and rows and columns wait for their sheet.
- **A deleted column** (`delete_column`, the app, `DELETE /sheets/:id/columns/:name`) is one item of kind `column`: its cells (the rows that held a value, each with its row's id), its place among the columns, its description and its own setup, what makes it an AI, HTTP API, enrichment, waterfall, formula, lookup or clean column (an AI column's outputs and its "(Data)" column are part of its setup; a column another column fills, such as one of those outputs, has none of its own). `list_trash` shows it with `column`, `cells`, `column_kind` and `references_dropped` (a count), and with its `trash_id` reads its cells like a batch's rows, one row per cell with the row it came from. Its cells move to the trash in slices with the sheet busy, so a big column takes a while. The column leaves the sheet at once, and the delete waits for its cells up to 5 seconds: its answer's `trash` then says `"state": "kept"` (every cell is in), or `"state": "moving"` with a `note` (they are still going to the trash, in the background; a restart finishes the move). Until they are all in, the item reads `state: "moving"` in `list_trash` and `GET /trash/:id`, and restoring it is refused: "still moving to the trash, try again in a moment" (`409` over REST, a failed item in `restore_from_trash`'s results).
- **What doesn't come back with a column:** what other columns, views and settings said about it is removed when it's deleted, as before: its own auto-run, its filters and hidden state in views and the sheet's filter, webhook mappings into it, the fields another HTTP API, enrichment, waterfall or AI column wrote into it (and web search on an AI column whose "(Data)" column it was), list enrichments of other sheets putting a field in it, lookups in other sheets reading it (they stop), auto-dedupe on it, and undoing the runs that wrote it. Setups that read it by name (a prompt's `/column`, a request's `{{column}}`, a formula, a clean or lookup column reading it, another column's auto-run waiting for it) read it again once it is back under the same name.
- **Restoring a column:** it comes back under its old name, or "<name> (restored)" ("(restored 2)" and so on) when a column has that name now in any case, at its old place (last if the sheet has fewer columns now), with its description and its own setup. Its cells go back to the rows that still exist, found by row id. A row holding a value there now keeps it (`cells_kept`), and the trashed cell stays in the item, so a restore never deletes it. A cell whose row is gone (`cells_skipped`: deleted since, maybe in the trash too) stays in the item as well. Once those rows are back and empty there, restore the item again and the cells go into that column; if that column is gone or renamed by then, they come back as a column of their own, with the setup the column had, and the answer's `note` says so. An AI, HTTP API, enrichment or waterfall column is set up as it was and nothing runs: rerun it with `control_run` and the `setup.run_id` the answer gives. A clean, formula or lookup column works its rows out again, as when it was made. Auto-run stays off for every kind. A setup that can't work now (the column it reads is gone, the sheet a lookup looks in or a list enrichment adds rows to is gone) isn't restored: the column comes back plain with its cells, and `setup.note` says why. A column its setup wrote that another setup fills now (an AI output, an HTTP API field, the "(Data)" column) stays with that setup, as restoring a setup version does: an HTTP API, enrichment or waterfall column comes back without that field, an AI column without that output, and an AI column comes back plain when none of its outputs is left or its "(Data)" column is another's. `setup.note` names them, and `references_dropped` lists each one (`kind` `output_taken`, with the column whose setup fills it now as `owner`). The answer's `references_dropped` lists each reference that didn't come back, with `where` it was, what it `did` and how to `redo` it (the tool, or the app). A restore is refused while a run is active on the sheet, while the sheet is busy, while the column is still moving into the trash, when the sheet already has the most columns it can hold, and, for a column whose request reads saved API keys, from a token without the `secrets` scope. `restore_from_trash` answers those per item in `results` (`fail` and `error`; the other items still go), not as a tool error. A column of over 20,000 cells answers `"state": "restoring"` and shows once its cells are all back; its setup's outcome (restored, or plain and why) is in the change log's `column_restored` line. While its cells go back, its name is taken: `add_column` (or `POST /sheets/:id/columns`) under that name, in any case, is refused until it is back.
- **Rows and a column of the same name:** rows deleted before their column hold that column's cells. Restored first, they add it back as a plain column, and the column item then comes back beside it as "<name> (restored)". Restore the column first, and the rows come back into it. Rows deleted after their column don't hold its cells: restored after the column, they leave those cells in its item until you restore it again. `restore_from_trash` with both ids does it right either way: after tables and sheets, it restores columns and batches of rows newest deletion first. Auto-dedupe and a list job's rerun add to one batch a day, so such a batch can count as newer than a column deleted after some of its rows: then the restore leaves some of those cells in the column's item, and a second restore of it brings back what's left.
- **Deleting from the trash** is only in the app.

`get_sheet_history` reads a sheet's change log (kept 90 days): what changed and who did it, the app or an access token by name. A line about rows or a column deleted to the trash has the item's `trash_id`, and `in_trash: true` while it is in the trash, also while a big column's cells are still moving in (`list_trash` shows it as `"state": "moving"`); `in_trash` is `false` once it is restored or deleted for good.

## Undo a run

`undo_run` puts back what a run's cells held before it ran: an AI, HTTP API, enrichment or waterfall run, a first run or a rerun of every row that went wrong. Pass `run_type` and `run_id` (from `list_runs` or `get_sheet`'s column details), or `sheet_id` and `column` for that column's newest run that can still be undone.

- **What comes back:** every cell the run wrote, in all its columns (the result, an HTTP API column's mapped columns, a structured run's typed columns, `(Data)`, status, "Answered by" and step columns). Cells that were empty go empty again, and each row's `out_of_date` state goes back with it.
- **What stays:** a cell changed since the run wrote it, by a person, an agent or a newer run, is left as it is (`skipped`). Cells in rows or columns deleted since are counted as `gone`, also when the rows came back from the trash. Rows a list enrichment added to another sheet stay (`delete_rows` removes them), and so does a column added later from the run's stored answers (`add_enrichment_field`).
- **What it costs:** nothing. Nothing runs again and nothing is billed; what the run cost stays spent. A restored row's stored answer stops being that cell's answer: the cell's answer and sources show the run before it, a column added later from stored answers reads that one, and the undone answer is never reused, so running the column again calls (and bills) again, unless reuse finds an older run's answer. A skipped cell keeps its answer. Clean, formula and lookup columns that read a restored cell work it out again (they're free), and so do the ones reading those; no auto-run that costs or sends requests starts.
- **When:** once the run has stopped (cancel a paused one first), once per run, for 7 days after it started. Newest first: while a newer run that wrote one of its columns can still be undone, an older one is refused (undo the newer one first). A run stopped or failed before it wrote a row has nothing to undo, so it stops standing in the way once its cells are back. While another run fills one of its columns, it waits. `dry_run: true` says whether it can be undone (`can_undo`, `reason`) and how many rows it wrote, and changes nothing.
- **The answer:** `state`, `restored`, `skipped`, `gone` and a `message`. An undo over 20,000 rows answers `"state": "undoing"` and goes on in the background (the sheet is busy meanwhile); `dry_run: true` shows how far it got. The sheet's history lists each undo.

## Cost ceiling and spend limits

A cost ceiling refuses a run that could cost more than you allow, before it starts. A spend limit stops an AI run once it has spent that much.

**The ceiling.** `run_ai_column` and `apply_setup` take `max_cost_usd` (dollars, more than 0) and `allow_unpriced` (default `false`). Cubex prices the call as `estimate_only` would. The start is refused when the ceiling can't cover the estimate's high end plus one row's most (below), or when something in it has no known price and `allow_unpriced` isn't `true`. Nothing is created then, and no run-start slot is used. MCP answers with an error that holds the estimate. REST answers `409` with `{"error", "over_ceiling": true, "estimate"}`. With `estimate_only: true` nothing is refused: the estimate carries `max_cost_usd`, `over_ceiling` (`true` or `false`) and `ceiling_problem` (why it's over, or `null`).

```json
{"sheet_id": "...", "column_name": "Fit", "prompt": "Rate /company from 1 to 10", "max_cost_usd": 2}
```

Why one row's most on top: the ceiling is also the run's spend limit, and the limit starts a row only while what that row could cost at most still fits (see below). So even a run that costs exactly its high end needs that much room left before its last row. The estimate names it as `row_most_usd`: the most of the sampled rows (the one with the longest prompt), so a row outside the sample with a longer prompt can cost more, and a ceiling that only just covers both can still pause the run before its last row. `ceiling_problem` gives both figures and the amount to raise `max_cost_usd` to, for example "It could cost up to $0.05, and its spend limit starts a row only while the row's most still fits, so it needs room for one row at its most on top (up to $0.12): $0.17 in all, more than the $0.10 ceiling (max_cost_usd)."

Something has no known price when its model isn't in OpenRouter's price list or its listed price is negative (the price varies, as with `openrouter/auto`), or when a web search engine has no listed price and no past run measured it. A routing variant (`:nitro`, `:floor`, `:exacto`, a preset) is priced as its model. An HTTP API step is never priced (it sends requests to your own API) and doesn't count.

**An AI run's spend limit.** `max_cost_usd` on `run_ai_column` is also the run's hard spend limit. `spend_limit_usd` sets a limit without the estimate check. With both, the lower one is the limit. The limit is kept with the run, so it holds after a restart and on every resume.

- Before each row starts, Cubex adds what the run has spent, the most its rows still out can cost and the most this row can cost. The row starts only while that stays within the limit.
- A row's most comes from the model's listed prices: the prompt counted as one token a byte (no model makes more tokens than bytes), all the output the call may write, and the model's fee per request. The output part is the `max_tokens` each call sends: 8,000 tokens, or `max_chars` when that is more (up to 16,000). `max_chars` can't lower it below 8,000, which reasoning models need to think and answer. At $15 per million output tokens that is $0.12 a row.
- When only rows still out are in the way, the run waits for them. When what it spent leaves no room for the next row, it pauses. `get_run_status` then shows `pause_reason: "spend_limit"` and a `pause_message` such as "The run reached its $2.00 spend limit ($1.98 spent). The next row could cost up to $0.03, more than is left. Resume it with a higher limit to go on." The rows not started stay waiting (⏳), and rows that already hold results are left as they are.
- A call cut off before its answer came back (it timed out, or its answer broke off) may still be billed, with no cost Cubex can see. Its row's most then counts as spent for the rest of the run, also when the run was paused or resumed while the call was out, and after a resume or a restart, so the run pauses rather than waits for room that never comes back, and the `pause_message` says so.
- A connection reset counts by when it comes. Within 2 seconds of the call going out, it is a stale connection that never reached OpenRouter: it counts as not billed, and Cubex tries the call once more. Later (a proxy that drops a connection while a long answer is written), the call may have been billed: a run with a limit doesn't try it again, and the row counts as a cut-off call.
- `control_run` with `action: "resume"` and a higher `spend_limit_usd` goes on (REST: `POST /ai-runs/:id/resume` with `{"spend_limit_usd": 5}`). After a `spend_limit` pause the new limit must be at least what the run spent, plus what its cut-off calls count, plus its next row's most; a lower one would only pause it again, so it is refused, and the refusal says what to raise it to (that least, rounded up). A run you paused yourself resumes as usual, with its limit kept, unless what it spent and its cut-off calls count already reach the limit: then a resume is refused the same way until the limit is above that. A refused resume changes nothing, the limit included. `get_run_status` and `GET /ai-runs/:id` show the least a resume takes as `resume_least_usd`, exact to the micro-dollar, for a run with a limit that isn't finished. In the app, Resume on a run that needs a higher limit asks for it: it shows why the run paused and won't take less than that least amount (to the micro-dollar). It fills in that least plus the rows left at what a row has cost so far on average (just the least before any row has run), and says what would finish for sure, with every row left at its most, as words only: a row's most is a worst case, often many times what rows really cost. A rerun (`control_run` `rerun`, `POST /ai-runs/:id/rerun`) takes `spend_limit_usd` too, for the new run.
- The run reads its model's price from OpenRouter's model list when its worker starts. If the list can't be read after a few tries, the run pauses before its next row with `pause_reason: "provider_errors"`; a resume tries again. It never runs a priced model as unpriced.

When the spend can pass the limit:

- With web search or fetch, a row's most also counts the search fees and the text they bring in, which Cubex can only estimate (the row's `max_searches_per_row`, else the usual number). Set `max_searches_per_row` to keep it close. Such a run can pass the limit by what its last rows cost over that estimate.
- A model with no listed price has no most. Its run stops once what was billed reaches the limit, so it can pass it by what the rows out at that moment cost.
- When the server restarts while calls are out, the new worker doesn't know about those calls. If OpenRouter bills them, the run can pass its limit by up to their most.
- A connection reset within 2 seconds of a call going out is taken for a stale connection that never reached OpenRouter, and the call is tried again. If it did reach OpenRouter and was billed, the run can pass its limit by what that call cost.
- Otherwise it doesn't. Near the limit fewer rows run at once, and up to one row's most can stay unspent.

**A setup's ceiling.** `apply_setup` checks `max_cost_usd` against the whole setup's estimate when you call it: its high end, plus one row's most for each AI step that has a price (each step's `row_most_usd`, summed in the estimate's `row_most_usd`). Once it runs, Cubex works out what is left for each step that spends as it starts: the ceiling, less what the steps started before it spent or may still spend (a run still going counts at its own limit), less what the steps not started yet need (their estimated high ends, and an AI step's row most). A step that no longer fits doesn't start: the setup pauses before it and says why. Otherwise an AI step's run gets what is left as its hard spend limit, and an enrichment step's run limit is the lower of its own and what is left. The high ends are the estimate's from when you applied it. They are estimates, not a most: a later step's prompt is priced as if each value an earlier step writes were a few words, so a step can need more. Clean, formula and HTTP API steps cost nothing here. A step with no known price (let in by `allow_unpriced`) runs without a limit, but what it spends counts for the steps after it. To go on after a pause at the ceiling, stop the setup and call `apply_setup` again with a `max_cost_usd` that covers what is left to do. That starts a new setup run that carries on where the old one stopped; its ceiling counts only what it spends from then on, not what the first one spent. `get_setup_run` shows the `max_cost_usd` it was applied with. While a step's AI run is paused at its spend limit, `control_setup_run` resume is refused, since a setup can't raise that limit: stop the setup and call `apply_setup` again with a higher `max_cost_usd`.

## Setups

A setup is a named copy of how a chain of filled columns is filled: AI, HTTP API, enrichment, clean data and formula columns, with their "Only run if" rules and auto-run. Save it once from a sheet, then build the same columns on another sheet.

```json
{"sheet_id": "...", "name": "Lead fit", "columns": ["Fit (Output)"]}
```

- `columns`: any column a step made (an AI column's `(Output)`, an HTTP API or enrichment status column or one of its output columns, a clean or formula column). With `include_upstream` (the default), every filled column they read comes too, down the chain.
- Each step is saved as its column is set up now: the prompt, model, web search and output columns, the request and its JSONPaths, the enrichment's choices, the formula or cleaner, "Only run if" and auto-run. Rows are never saved, and the sheet doesn't change.
- The answer lists the steps in the order they run, the `inputs` (columns the setup reads that none of its steps make: a sheet it's used on needs them) and the saved `keys` its requests name. A saved key is kept by name, never its value.
- `preview: true` shows what would be saved and saves nothing (`read` scope). Saving needs `write`. Names are unique, ignoring upper/lower case.
- A column that adds rows to another sheet (a list enrichment) can't be saved yet.
- `list_setups` lists them; pass `setup_id` for one in full. `delete_setup` deletes one; sheets it was used on keep their columns. A setup is a copy, never a link.
- A column with a key typed straight into its request can't be saved: save the key in Settings and write `{{its name}}` instead.

`apply_setup` builds a setup's columns on another sheet and fills them. It's an estimate unless you pass `estimate_only: false`, so a first call only prices it:

```json
{"sheet_id": "...", "setup_id": "...", "inputs": {"Website": "Company URL"}, "estimate_only": true}
```

- `inputs` maps each of the setup's inputs to a column of this sheet. An input left out uses the column with its name (any upper/lower case).
- The steps run in order: each one starts once every step whose columns it reads has finished, and steps that don't depend on each other run side by side. A run that fails or is stopped ends the chain; rows that failed inside a run don't (they read as empty further on).
- The estimate lists each step: AI steps priced on the sheet's rows, enrichments at treg's prices, HTTP API steps as one request a row, clean and formula steps free. A step reading what an earlier one writes is priced as if each of those values were a few words, so it can cost more than its estimate.
- A step whose columns the sheet has already, made the same way (the same kind of column making the same columns, reading the same ones and set up alike: the same prompt, request and fields, enrichment job, cleaner or formula, as when this setup made them), carries them on: it fills only the rows it hasn't done, with the column's own model, speed and "Only run if" rule. AI columns take their empty rows, HTTP API columns their empty, failed or unfinished rows, enrichments the rows not enriched yet; a row the rule kept out runs only if the rule passes on it now. Clean and formula columns follow their columns (or are filled again, free, when their auto-run is off). A step with nothing left to do is done at once, and one whose column has a run working waits for it; a paused run there stops the setup at that step until you resume or stop it. A step that reads a column another run is filling (or a stopped one is putting back) waits for it, its `note` saying which, then starts. The estimate prices those rows, and `carries_on` lists the steps. That's how to fill new rows on a sheet, or finish a setup that failed or was stopped: call `apply_setup` again with the same `inputs` and `names` (`get_setup_run` with `sheet_id` and `setup_id` shows the `choices` its runs there used).
- Any other column the sheet has under a name the setup makes is refused (`taken`); give the step another name in `names`, keyed by the column the setup makes (an AI step by its `(Output)` or `(Status)` column). Renaming a step that would carry on makes it a new column instead. `models` picks a new AI step's model; by default it keeps the one it was saved with.
- `first_rows` tests it on the top rows (up to 1,000). After a run on every row, the auto-runs saved with the setup are turned on; a test doesn't turn them on.
- `max_cost_usd` refuses to start a setup that could cost more (its estimate's high end, plus one row's most for each AI step), and limits each AI and enrichment step as it starts. `allow_unpriced: true` lets a step with no known price in. See [Cost ceiling and spend limits](#cost-ceiling-and-spend-limits).
- It needs the `run` scope, and `secrets` too when its requests read a saved key. Every saved key it names must exist in Settings.
- The answer is a `setup_run` with each step's `run_id` (`get_run_status` works on those). `get_setup_run` follows the whole chain; `control_setup_run` pauses, resumes or stops it. Stopping keeps the columns and values made so far.

## Setup versions

A setup version keeps how one sheet's columns are set up, so you can put it back after changing a prompt, a request or a formula: every column in order, with its description, what fills it (an AI column's prompt, model and settings; an HTTP API, enrichment or waterfall column's request or choices; a clean, formula or lookup column's settings), its "Only run if" rule and its auto-run. Never the values in the cells.

- `manage_setup_version` with `action: "save"` and a `name` keeps the setup as it is now (names are unique in a sheet, ignoring upper/lower case; a sheet keeps up to 100). `rename` and `delete` take a `version_id`; deleting one is permanent and changes nothing in the sheet. Saving needs `write`.
- `list_setup_versions` lists a sheet's versions, newest first, with who saved each one. With `version_id` it compares that version with the sheet now, column by column: `add_back` (gone since: a restore adds it back, empty), `restore` (set up differently: `fields` lists each setting as the version and the sheet have it), `leave` (filled another way now, an AI column where the version had a formula: a restore leaves it, and the `note` says why) and `keep` (not in the version: it stays). Request URLs are masked, headers show by name, and a request body shows only as changed.
- `restore_setup_version` is a dry run unless you pass `dry_run: false`; a dry run's `blocked` says why it can't be restored now (a run going on the sheet, say). A restore first keeps the setup it replaces as a version of its own (`auto: true`, named "Before restoring: …"), then adds the gone columns back empty with their setup, puts back every setup that differs, every column's description and the column order (columns the version doesn't have stay next to the column they follow), and turns auto-run on or off as the version has it (from the rows there now; one already on goes on from where it was; one you paused stays paused).
- **Nothing runs and nothing is billed, and no cell changes.** An AI, HTTP API, enrichment or waterfall column runs the restored way the next time it runs: a rerun (`control_run`), its column menu, or auto-run on new rows. Until then its newest run is a record that ran nothing: `get_sheet` shows its `run_status` as `restored`, and `list_runs` and usage leave it out. A clean, formula or lookup column keeps its cells until it is worked out again (`clean_column`, `formula_column` or `lookup_column` on its own column, free). Each column's `note` says which.
- A column filled another way now is left as it is, and so is an AI column whose output column is; an HTTP API column comes back without a field whose column is now filled another way. Each `note` says why.
- A restore is refused while a run or a setup is going on the sheet, or while a clean, formula or lookup column is still filling (a lookup can wait for the sheet it looks in). It needs the `write` and `run` scopes, and `secrets` too when a request it puts back reads a saved key. A column renamed since keeps its new name: versions follow renames, in other sheets' lookups too.
- The sheet's history lists each save and each restore.

## Enrichments

Enrichments look things up per row through [treg.to](https://treg.to) with the treg key saved in Cubex (Settings, Enrichment; setup and examples in the [enrichments guide](enrichments.md)): verified work emails, phone numbers, person and company data, and lists (people at a company, similar companies) that become rows in another sheet. Every row is a paid call on your treg balance, so the assistant should estimate first and tell you what it found.

**The usual flow**

1. `search_enrichments` (for example "work email") finds the tool; `get_enrichment` lists its inputs, its output fields, its price and, for a waterfall (treg asks many providers in turn), each provider with its price, hit rate and whether your team's own key or a free route serves it.
2. `run_enrichment` with `estimate_only: true` checks everything a run would check and returns the rows it would take, the cost range, the per-row cap and run limit it would use, your treg balance and `daily_limit`. It creates nothing.
3. `run_enrichment` with `test: true` runs the first 5 rows; without it, every row in scope. It returns a `run_id` at once. When other columns in the sheet have auto-run on and read what this run writes, it also returns `chained_auto_run`: those auto-runs, which fill the same rows after it (and the ones they set off in turn), each with its estimated cost or, for an HTTP API column, `sends_requests: true`. HTTP ones send real requests.
4. `get_run_status` (run type `enrichment`) follows it: `cost_usd` is what its treg calls cost so far, and `enrichment.pause_reason` says why it paused (its run limit, the daily limit, the treg balance, a missing key, treg unreachable). `control_run` resumes it once that's fixed, with `spend_limit_usd` to raise a run limit and `concurrency` to change how many rows run at once. `get_run_results` gives each row's cost and the provider that found it. While another run is filling a column its inputs read, or a stopped one is putting it back, a start, an estimate and a resume are refused (`409`) and a running enrichment's rows wait for it, so treg is never sent (or paid for) `⏳ Processing...`; the same goes for waterfalls.

**Money**

- `max_cost_per_row_usd` is sent to treg as each row's cap (the default lets every provider you kept answer). `spend_limit_usd` is the run's limit: it pauses there (default: the rows in scope times the per-row cap).
- **The daily limit** for all enrichments is $10 a day by default (UTC days), counting the app, auto-runs and agents together. Estimates, run starts and run status return it as `daily_limit {limit_usd, used_today_usd, remaining_usd}`. Only you can change it, in Settings: a token can't. Runs going at the same moment can pass it by about one batch each.
- A `run` token can spend your treg balance, up to these limits. Providers on your team's own keys at treg bill your team directly, outside every Cubex limit.
- **Found answers are reused.** A row whose lookup (same tool, same inputs, same provider choices) found something in any run of the account in the last 30 days (a Settings choice; 0 turns it off) fills from that answer with no call and no cost. `estimate_only` returns `reuse {rows, complete, checked_rows, days, fresh}` and prices only the other rows (`complete: false`: a big run was counted for a while, so at least that many). `get_run_status` reports `enrichment.reused_rows`, and `get_run_results` marks each reused row with `reused_answer_from` (when that answer was found). `fresh: true` calls every row again.

**Status cells are Cubex's words, not data.** The status column says per row: `✅ Found` (the outputs are filled), `⏭️ Not found`, `⏭️ Budget ran out` (the per-row cap stopped the waterfall before a provider found it), other `⏭️ …` skips with their reason, `❌ …` failures with their reason, and `⏳ Processing...` while it runs. Verified work email writes `✅ Valid`, `✅ Catch-all` or `✅ Risky`; on a row it rejected (`⏭️ Only a catch-all address (not accepted)` and the like) it still fills Email status and Checked by, never Email. Jobs that add rows write `➕ Adding N rows…`, `➕ N results, waiting for fields`, `➕ N rows waiting for room in <sheet>`, `✅ N rows added` (with `, M already there` when duplicates were skipped), `✅ Already there`, `✅ No rows to add` (the job's own outputs filled, no results), `➕ Removing earlier rows…` (a rerun with no results replaces the rows the row added before) and `❌ Rows not added: <reason>`. Output columns are empty on rows that found nothing, and so is a column added from stored answers where an answer had no value (an HTTP API column's says `⏭️ No data`). An empty status means the row hasn't run; rows missing an input are skipped and stay empty.

**Jobs that add rows** (`adds_rows: true`): treg returns each provider's own fields, so a list job asks one provider and you keep the fields its real results have.

1. `run_enrichment` with `test: true` and `list: {new_sheet_name or destination_sheet_id, provider, results_per_row, copy_columns}` runs 5 rows; their results wait for fields.
2. `get_run_status` shows them in `enrichment.list.waiting_for_fields`; `get_list_fields` lists the fields (path, label, how many results have it, a sample).
3. `add_list_rows` picks the fields (and `dedupe_path` to skip results added before) and adds those rows, for free.
4. `control_run` rerun with mode `empty` runs the rest of the rows with the same fields.

`results_per_row` is the price dial: providers that charge per result charge for each.

- `copy_columns` takes `{from, to}` to copy a column of the asking row into each added row, or `{to, value}` to write the same text into each (say which engine or source the rows came from).
- `outputs` are optional on a list job: they fill columns of the asking row from the answer's fields outside its results (`get_enrichment` lists only those for a tool that adds rows), from the same call.
- A rerun replaces the rows each source row added before, and a rerun that answers with no results removes them: they go to the trash (one batch per sheet a day, `list_trash` with `how: "rerun"`; deleted at once when Settings keeps the trash 0 days) and the other sheet's History counts them, so an answer that comes back shorter never costs the rows it replaced. Restored, they stay as rows of their own: a later rerun adds new rows beside them.
- A single tool's other lists (often shown empty in its example answer, so treg's catalog doesn't name them as results) are in `get_enrichment`'s `other_lists`; pass one as `list.items_path` to add its items as rows. Deleting a sheet whose results aren't rows yet drops them: `manage_sheet` and `manage_table` deletes (and the REST deletes) say how many in `list_results_dropped`.

**Auto-run** (`set_auto_run`, or `auto_run` on `run_enrichment`) keeps an enrichment or HTTP API column filling new rows, and rows whose inputs get filled, at most once a row. Rows already in the sheet when you turn it on are left alone. An enrichment auto-run has a daily cap (default $5, never above the daily limit); an HTTP API auto-run has a daily row cap (default 500) and **sends real requests**, for example adding leads to a sequencer. With a webhook on the sheet, anyone with its URL can add rows that spend.

**More from stored answers.** `get_run_results` with `include_answers: true` shows each row's stored answer (10 rows a page, rows that answered unless you pass `status_filter`; `answer_cut` lists parts left out of a very big answer; a run that used saved API keys needs the `secrets` scope). `add_enrichment_field` turns any value in it (a JSONPath such as `$.output.company.linkedin_url`) into a new column, filled from the answers already stored with no new calls. It fills in the background: `get_sheet` lists it in `filling_columns`, and reads show its cells as `⏳ Processing...` until it's done. Cubex removes the provider's raw data (`raw`) from a row's older answers when the row is enriched again, and from answers of runs that ended over 90 days ago when you prune them in Settings; the result fields stay. A value that was only in removed raw data can't become a column, and `add_enrichment_field` says so.

## Waterfalls

A waterfall column fills one value per row by trying steps in order and stopping at the first answer. For a work email: a treg tool first, then your own API, then an AI prompt. A row pays only for the steps it reaches. In the app it's **Waterfall**, under the arrow next to **AI Column** in the sheet's toolbar; agents use `waterfall_column`.

```json
{
  "sheet_id": "…",
  "column_name": "Work email",
  "result_type": "email",
  "inputs": { "full_name": "Name", "domain": "Website" },
  "steps": [
    { "kind": "enrichment", "tool_id": "treg.people.email.find" },
    { "kind": "http", "label": "Our API", "url": "https://api.example.com/find?domain={{domain}}&name={{full_name}}",
      "headers": { "Authorization": "Bearer /our_api_key" }, "value_path": "$.email" },
    { "kind": "ai", "prompt": "What is the work email of /full_name at /domain? Reply with the address only.",
      "web_search": true }
  ],
  "test": true
}
```

**Starter waterfalls.** `template` sets up a new column's `result_type` and steps; you still map `inputs` to your columns (the template's other input keys stay unmapped), and `steps` you pass replace its own. `work_email`: treg's email finder (`treg.people.email.find`) asks its providers in turn; where none finds an address, a first.last@domain guess from the name and the domain counts only when treg's email verify says it's valid. `mobile_phone`: treg's phone finder (`treg.people.phone.find`) asks its providers in turn until one has the person's mobile or direct number. Each template's treg step has a label (`treg email finder`, `treg phone finder`) that `test_step` can name. With a template and no `steps`, `inputs` takes only the template's keys. In the app they're on the Waterfall drawer's first screen, with the inputs matched to your columns by name.

**What it finds** (`result_type`): `email`, `phone`, `domain`, `linkedin_url`, `url` or `text`. A step's value counts as an answer only when it reads as that type: "not found", "N/A" or a broken address is no answer, and the next step runs. Phone numbers come out in one format: `phone.format` is `international` (default), `national` or `e164`, and `phone.country` (default `US`) reads numbers written without a country code.

**Inputs, mapped once.** `inputs` maps each input key to a column (`{"full_name": "Name"}`), or to a fixed `{"value": "..."}`. Steps read the keys, never the columns: an AI prompt with `/full_name`, a request with `{{domain}}`, a treg tool by the same names (`first_name`, `last_name`, `full_name`, `domain`, `company`, `linkedin_url`, `email`) unless its own `inputs` map them differently.

**Steps** (up to 12), in order:

| `kind` | It takes | It costs |
|---|---|---|
| `enrichment` | `tool_id` from `search_enrichments`; optional `inputs` (the tool's input to an input key, or a fixed value), `value_path` (the answer field; by default the one `result_type` names), `provider_order`, `skip_providers` and `max_cost_usd` (its cap per row) | treg's price, on your treg balance |
| `ai` | `prompt` with `/input_key` words; optional `model` (default: the sheet's, else the account's) and `web_search` | OpenRouter's price |
| `http` | `url` with `{{input_key}}`, a saved API key as `/key_name` (needs the `secrets` scope), and `value_path`, the JSONPath of the value in the JSON reply; optional `method`, `headers`, `body` and `retries` | whatever your API charges |
| `formula` | `formula`: JavaScript over `{{input_key}}`, such as `{{first_name}}.toLowerCase() + "@" + {{domain}}`, worked out in a sandbox like a formula column | nothing |
| `lookup` | `other_sheet_id` (another sheet of the account, any table), `match_column` (its column to match), `input` (the input key whose value it looks for), `return_column` (its column that holds the answer) and optional `match`: `equals` (default) or `contains` | nothing |

Every step also takes a `label` (what "answered by" shows: by default the provider, `treg (N providers)` for a treg tool that asks several, `AI`, the API's host or the sheet a lookup looks in; a repeated label gets a number), `on: false` to keep a step but skip it, and `requires`: alternatives of input keys, such as `[["full_name", "domain"], ["linkedin_url"]]`. A row with none of them skips the step at no cost. Left out, an AI or HTTP step needs every key it reads, and an enrichment step follows its tool's own rule. A step that fails (an HTTP 500, a timeout) doesn't stop the row: the next step runs. An AI step that meets a rate limit (or OpenRouter's limit on calls in flight for your balance) is tried twice more first.

**Lookups.** A lookup step takes the answer from a list you already have, such as a CRM export: the first row of the other sheet, top first, whose `match_column` equals (or, with `contains`, holds) the row's input, and that row's `return_column`. Capital letters and spaces around the value don't matter. When nothing matches, or the matching row's cell isn't a `result_type` value, the next step runs; put it first, and only the rows it can't answer reach the paid steps. It reads the other sheet as it is when each row runs; that column is indexed the first time (a big sheet takes a moment). So that a row never misses only because that sheet is mid-change, the step waits while it's being imported into, sorted, cleared of duplicates or having a column renamed or deleted, and a row waits while a run there is still filling the cell it would return. Renaming a column there updates the step. Deleting the sheet, or a column the step reads, pauses a run that reaches it (`pause_reason` `setup`), and a new run is refused until the step is changed. A deleted sheet is in the trash: restore it, then resume the run, and the step goes on where it stopped.

**Checks.** A step's `check` tests the value it finds before it counts. `{"kind": "verify", "accept": "safest"}` asks treg's email verify (a work email result only; each check costs what treg charges): `safest` takes valid addresses, `balanced` catch-all ones too, `wide` risky ones too. `{"kind": "formula", "formula": "{{value}}.endsWith('@' + {{domain}})"}` passes when the formula's result is true. A value that fails is rejected (its trace says `rejected`, with the check's verdict) and the next step runs. The most a row can cost includes its checks.

**Dry run.** `dry_run: true` runs the waterfall for real on the first 3 rows it would take (rows where some step has its inputs; or `target_row_ids`, up to 10) and writes nothing to the sheet: no column, no cell. It costs what those rows cost and waits up to 25 seconds, then returns each row's inputs, its answer and every step it reached with its outcome, value and cost. For 7 days a real run replays what a dry run bought (treg and AI steps, and verify checks) at $0, so trying first costs nothing extra; `fresh: true` asks again. `test_step` (a step's label or id) with `dry_run` runs that one step alone. It isn't an estimate, so leave out `estimate_only`. In the app: **Try on 3 rows**, and **Test this step** on a step.

**Columns and cells**

- `column_name` holds the answer. When no step found one it says `⏭️ Not found`, or `⏭️ Budget ran out` when the last step reached stopped at its cap; `❌ <step>: <why>` when no step answered and one failed. A row with no inputs for any step stays empty.
- `<column> (Answered by)` names the step that answered each row. `answered_by_column: false` leaves it out.
- `<column> (<label>)`, one per step: that step's own value, `⏭️ Not found`, `⏭️ No inputs` or `❌ …`, and empty where the row never reached it. They're hidden in the sheet's views (the columns picker shows them); `hide_step_columns: false` keeps them visible.
- In the app, a click on a result cell shows its trace: each step the row reached, what it did, what it cost.

**Money**

- `estimate_only` defaults to `true` on `waterfall_column`: it checks everything a run would and creates nothing. It returns the `rows` in scope, `per_row {average_usd, max_usd}`, `total` for those rows, `run_limit_usd`, `daily_limit` when a treg step is on, and per step its `reach` (the share of rows that get that far), `max_usd`, `expected_usd` and `answer_rate` (`rate_from`: `history`, this column's earlier runs, or `treg`, treg's observed rate). A step with no known rate counts as never answering, so the average errs high. Tell the user, then call again with `estimate_only: false`.
- The most a row can cost is every switched-on step's cap added up: an enrichment step's `max_cost_usd` (by default what its providers can cost), an AI step's most expensive call (its prompt, the longest answer and web fees). `spend_limit_usd` caps the run's treg and AI spend together and pauses it there (default: the rows in scope times that most). The enrichment daily limit counts the treg steps; a treg step with no listed price (your own provider key should bill it) stops there on what treg really charged.
- A treg answer any run of the account found in the last 30 days (the Settings choice) is reused at $0, as for enrichments. `fresh: true` calls every step again.
- When a run pauses part way, what its AI and HTTP steps already answered is kept, so resuming it doesn't pay for them twice; treg steps replay their paid answers for free.
- Running the `failed` rows again asks again only the steps that failed. A treg or AI step that already paid to find nothing for that row isn't asked again, and a value the row paid for that its check rejected, or couldn't check, comes back and is checked again (a verify from its kept verdict, at $0); their trace says `from: "last_run"`. `fresh: true` asks every step.

**Running it again.** `add_to_column: true` with the same `column_name` runs a waterfall column again, with its own inputs and steps or new ones you pass: a step keeps its column by its `id` or by the same `label`. `action: "describe"` (`read` scope) returns the column's setup in that same shape, step ids included, to change and send back. Without the `secrets` scope, an HTTP step's keys in its URL, its header values and its body read `…`; sent back with the same `id` and URL, they keep their stored values. `rows` picks which rows: `not_enriched` (not run yet, the default when adding to a column), `no_result`, `failed` or `any`. `test: true` runs the first 5 rows; `use_sheet_filter`, `target_row_ids` and `run_if` narrow the rows. `auto_run: {"enabled": true, "daily_cap_usd": 5}` keeps it filling new rows (`daily_row_cap` instead when no step is paid).

**Following a run.** `get_run_status` with `run_type: "waterfall"` returns `cost_usd` (treg and AI so far) and `waterfall`: `result_type`, `spent {treg_usd, ai_usd, total_usd}`, `run_limit_usd`, `pause_reason`, and per step how many rows it `reached`, `answered`, `failed` and `skipped` (no inputs), and its `cost_usd`. `get_run_results` gives each row's `answered_by`, `cost_usd` and `trace`: every step the row reached, with its `outcome` (`answered`, `rejected` by its check, `not_found`, `no_inputs`, `error` or `budget`), `value`, `detail` and `cost_usd` (`from` says where a free answer came from: `reused`, `dry_run`, `journal` after a resume, `last_run` on a retry, `same_lookup`), and `check` when the step has one (`outcome` `passed`, `failed` or `error`, the `verdict`, its `cost_usd`). `control_run` pauses, resumes (`spend_limit_usd` raises the limit that paused it), cancels and reruns (`mode` `errored`, `empty`, `missing`, `out_of_date`, `empty_or_out_of_date` or `all`, or `row_ids`). `get_usage` lists waterfall runs as their own kind.

## AI visibility

`ai_visibility` checks whether AI engines recommend a brand for the questions buyers ask. In the app it's **Check AI visibility** on the dashboard and in **New Table**.

1. `action: "create"` with `brand`, `other_brands` (competitors to look for), `domain` (optional, your site), `country` (two letters, default `US`), `engines` (`chatgpt`, `gemini`, `ai_mode`, `perplexity`, `copilot`; the first four by default) and `questions`. It makes the table "AI visibility for <brand>" and asks nothing: no cost.
2. `action: "ask"` with the `id` create returned (or the table's Questions sheet id, from `list_tables`). `estimate_only` defaults to `true` and returns the cost per engine and in total. With `estimate_only: false` it starts one enrichment run per engine on the questions not asked yet (`again: true`: every question, with fresh answers). Follow them with `get_run_status` (run type `enrichment`). Each start takes the token's run-start slot and stops at its spend cap. Needs the `run` scope.
3. Read the **Questions** sheet with `read_rows`: per engine its status, its answer and `You in <engine>` ("1st of 4" = your place among the brands its answer names, "Not named", or empty while it hasn't answered). `Named by` counts the engines that name you; `Named first` is the brand most engines name first. Brands are found as whole words, ignoring case and accents, among `brand` and `other_brands` only.
4. The **Cited sites** sheet holds every source an answer cites: `Question`, `Engine`, `Position`, `Title`, `URL`, `Domain` (a clean column) and `Your site`. `read_rows` with `group_by: ["Domain"]` counts the sites cited most.
5. `action: "set_brands"` changes the brands looked for and works every row out again from the answers there, at no cost. `other_brands` replaces the list; left out, the list stays, and so does `brand`.
6. Weeks later, `action: "check_again"` keeps the answers there now and asks again. `estimate_only` defaults to `true`: it returns the cost, `answers_of` (the day most of the answers there were asked; pass `time_zone`, such as `America/New_York`, for the user's day, else UTC), `answers_days_old`, the `engines` it would ask, the names it would use (`will_make`) and a `note` when the answers are under three weeks old (a change then is mostly the usual variation between asks). With `estimate_only: false` it copies Questions and Cited sites, values only, into sheets named with that day ("Questions 2026-10-01", "Cited sites 2026-10-01"), adds to Questions `Named by on <day>` (a lookup of that day's Named by, by question) and `Change since <day>`, then asks every engine every question again with fresh answers. `Change since` says "Up 2", "Down 1" or "Same", "New" for a question with no answers that day (added or edited since), and stays blank while a different number of engines has answered than that day (still answering, one failed or was added); it counts with the brands looked for that day, so `set_brands` leaves it as it is. The answer is the check: its `stage` (`done` once every engine was started, else `stopped`), its `problems`, the copies' sheet ids, the two columns and the `runs` it started. A token at its spend cap is refused before anything is copied. A check that stopped (no treg key, the daily limit, a restart) is picked up by the next `check_again` (the estimate shows `picks_up`): its copies and columns stay and only the engines it didn't start are asked; `fresh: true` starts a new check instead. Needs the `run` scope; refused while an engine is still being asked. The create and set_brands answers also carry `answers_at` (when the engines were last asked) and the latest `checks`. A restart in the middle finishes the copies and columns but never asks on its own.

The engine columns are ordinary enrichment columns (the column menu, `control_run` and `set_auto_run` work on them) and the formulas are ordinary formula columns. Answers vary from one ask to the next: compare totals, not one question.

## Big CSV files

Everything an assistant sends or receives passes through its context, so a CSV pasted into chat is expensive: a 4 MB lead list is about a million tokens, and a file of a few hundred MB can't go through chat at all. For files, the assistant asks Cubex for a one-time link and moves the file with `curl`. Only a short summary goes through the chat.

- **Import.** Ask "Import ~/Downloads/leads.csv into a new table called Leads." The assistant calls `create_upload_link`, then runs `curl -sS -T leads.csv '<link>'`, which prints the result: rows imported and new columns (and cells that look garbled, see [Garbled text](#garbled-text)). Files up to `MAX_CSV_UPLOAD_MB` (500 MB by default) work, the same as an upload in the app. The upload has to come from a file, not a pipe: Cubex uses the file's size to tell a finished upload from one that was cut off.
- **Export.** Ask "Save the Qualified rows of Leads to qualified.csv." The assistant calls `create_download_link`, then runs `curl -sS -f -o qualified.csv '<link>'`. It can also give you the link to open in your browser.

This works from any computer that can reach Cubex, as long as the assistant can run commands (Claude Code, Codex). With other assistants, such as claude.ai or Claude Desktop, ask for a download link and open it yourself; to import, open the sheet in Cubex and choose **Data**, then **Import CSV**.

What keeps the links safe:

- A link works once and stops working after 15 minutes, or as soon as the token that made it is revoked.
- It does one thing for one sheet, and only what its token could already do. An upload link needs a token with `write`; any token can make a download link. A token without `write` is told so, and what to do instead.
- Until it's used, anyone who has the link can use it, so treat it like a password. Cubex stores only a hash of it.
- Don't paste a download link into an app that previews links, such as Slack, Discord or iMessage: the preview would download the file and use the link up.

A million rows take about 10 seconds to import once the file is up. If `curl` stops waiting, the import still finishes, so check the sheet before trying again. Links point at the address the assistant reached Cubex on, or at `PUBLIC_URL` when you set it. Behind Cloudflare's proxy, the free plan refuses uploads over 100 MB.

## Limits

Agents can get stuck in loops, so each token has its own budget:

- 120 requests a minute.
- 30 run starts a minute (reruns and previews count; estimates don't).
- Its spend cap, if you set one (see **Spend cap** above): what it may spend in all.
- Through MCP: 5 CSV imports a minute. Each upload link counts as one.
- 5 sheet copies a minute (`manage_sheet` copy and `POST /sheets/:id/copy`).

Row transfers are limited for the whole account: 10 a minute, one at a time.

Going over returns a clear error; the assistant can wait and retry.

**Runs that stop themselves.** An AI or HTTP API run doesn't write an error into every row when its provider is down. After 5 rows in a row fail on the provider's or the account's side (no answer, a server error, a rate limit after its retries, a rejected key, no credits, a model that's gone), it pauses, and the rows not run yet stay waiting. `get_run_status` then shows `pause_reason: "provider_errors"` and a `pause_message` with the last error; `control_run` resume goes on once it's fixed. An HTTP API column's auto-run tries again by itself a few minutes later. Three more reasons work the same way: `storage` (results couldn't be saved, usually a full disk; a resume is refused until there's space), `stalled` (its worker stopped several times) and `web_engine` (an AI run with web fetch limits reads pages through Exa, and your OpenRouter workspace's engine list doesn't allow Exa; see the web fetch limits under [Runs](#runs)). An AI run with a spend limit pauses with `spend_limit`, and with `provider_errors` when OpenRouter's model list (its price) can't be read (see [Cost ceiling and spend limits](#cost-ceiling-and-spend-limits)). Every AI call ends within 10 minutes, its answer included; a row that takes longer fails as timed out.

## REST API

The same data is available as a plain HTTP API under `/api/v1`, with the same tokens and scopes. Send `Authorization: Bearer cubex_pat_...` and JSON bodies (`Content-Type: application/json`). `GET /api/v1/me` checks a token and lists its scopes and its spend cap (`token.spend`: `spend_cap_usd`, `spent_usd`, `left_usd`).

All paths below are relative to `/api/v1`.

### OpenAPI document

`GET /api/v1/openapi.json` describes every endpoint below in OpenAPI 3.1: what it does, the scope it needs, its path and query parameters, and its body. It needs a token like every other endpoint, and any scope can read it.

```bash
curl -H "Authorization: Bearer $CUBEX_TOKEN" http://localhost:3002/api/v1/openapi.json -o cubex-openapi.json
```

Import the file into Postman, Insomnia or Swagger UI, or generate a client from it. Its server address is relative (`/api/v1`), so set your Cubex address as the base URL, such as `http://localhost:3002/api/v1`. It says what each answer means, but not the shape of its JSON.

### Tables, sheets and columns

| Endpoint | Body or query |
|---|---|
| `GET /tables` | Tables with their sheets. |
| `POST /tables` · `PATCH /tables/:id` | `{"name": "Leads"}` |
| `POST /tables/sample` | No body. A table of 25 made-up leads (every website and email at `.example`), with a clean and a formula column filled, the duplicate it holds found by a dry run, and the AI column "Good fit (Output)" set up but not run: `ai_column` has its prompt and the first 5 `target_row_ids`. `write` scope. |
| `DELETE /tables/:id` | Puts the table, its sheets and their rows in the trash. Stops its runs first. |
| `POST /tables/:tableId/sheets` | `{"name": "Q3", "after_sheet_id": "..."}` (both optional) |
| `PATCH /tables/:tableId/sheets/:sheetId` | `{"name": "Q3 leads"}` to rename, `{"description": "…"}` to describe (`""` removes it), or both. |
| `DELETE /tables/:tableId/sheets/:sheetId` | Puts the sheet in the trash, whole. A table always keeps one sheet. |
| `PATCH /tables/:tableId/sheets/order` | `{"ordered_sheet_ids": ["...", "..."]}` |
| `GET /sheets/:id` | Columns, row count, `data_version`, `row_generation`, its `description` and `column_details` (see [Column details](#column-details); `?include_counts=true` counts rows, `&columns=Email` names columns to show in full and count first), its clean, formula and lookup columns, its saved `views`, and what's running on it now: `active_runs` (AI, HTTP and enrichment runs) and `active_setup_runs`. |
| `POST /sheets/:id/columns` | `{"name": "Status"}`, plus an optional `description`. |
| `POST /sheets/:id/formula-columns` | `{"column": "Work email", "formula": "{{Response}}?.emails?.find(e => e.type == \"work\")?.value"}`, plus optional `description`, `auto_run` and `preview`. Same as `formula_column` (see [Formulas](#formulas)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `POST /sheets/:id/lookup-columns` | `{"column": "Industry", "source_column": "Domain", "other_sheet_id": "…", "match_column": "Website", "returns": "value", "return_column": "Industry"}`, plus optional `match`, `return_columns`, `limit`, `auto_run` and `preview`. Same as `lookup_column` (see [Lookups](#lookups)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `POST /sheets/:id/formula-columns/write` | `{"words": "the work email from Response"}`, plus optional `model`. Same as `write_formula`. `run` scope. |
| `POST /sheets/:id/remove-duplicates` | `{"columns": ["Email"], "keep": "first", "dry_run": false}`. Same as `remove_duplicates` (see [Remove duplicates](#remove-duplicates)): a dry run unless `dry_run` is `false`. `read` scope for a dry run, `write` to remove. |
| `PUT /sheets/:id/auto-dedupe` · `DELETE /sheets/:id/auto-dedupe` | `{"column": "Email", "match": "email", "keep": "oldest"}` turns it on or changes it (fields left out stay); `DELETE` turns it off. Same as `set_auto_dedupe` (see [Auto-dedupe](#auto-dedupe)); `GET /sheets/:id` shows it as `auto_dedupe`. `write` scope. |
| `POST /sheets/:id/clean-columns` | `{"source_column": "Name", "cleaner": "first_name"}`, plus optional `column`, `phone_format`, `phone_country`, `name_input`, `the_company`, `auto_run` and `preview`. Same as `clean_column` (see [Clean data](#clean-data)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `PATCH /sheets/:id/columns/:name` | `{"name": "New name"}` to rename (URL-encode the old name), `{"description": "…"}` to describe (`""` removes it), or both: the description is checked first, so a bad one changes nothing. |
| `DELETE /sheets/:id/columns/:name` | Puts the column in the trash with its cells, place, description and own setup. Answers `deleted` and `trash` (`trash_id` null when Settings keeps deleted things 0 days). `trash.state` is `"kept"` once every cell is in, or `"moving"` when they were still going to the trash after 5 seconds (they go on in the background; a restore before then answers `409`). |
| `PUT /sheets/:id/columns/order` | `{"order": ["Email", "Company", "Status"]}` (every column, once) |
| `POST /sheets/:id/sort` | `{"column": "Score", "direction": "desc"}`. Permanently reorders the rows. |
| `POST /sheets/:id/copy` | `{"name": "Leads Oct 20", "columns": ["Email", "Company"]}` (both optional). A new sheet right after this one holding its values: the same rows in the same order under plain columns that nothing fills, a run's words (⏳, ❌, ⏭️, ➕) left empty. `name` defaults to "Copy of <sheet>". Answers `201` once every row is in, with `sheet`, `sheets`, `rows_copied` and `columns`. Same as `manage_sheet` copy. `write` scope. |

### Views

| Endpoint | Body or query |
|---|---|
| `GET /sheets/:id/views` | The sheet's saved views, Default first: `{id, name, description, is_default, active, hidden_columns, where}`. `read` scope. |
| `POST /sheets/:id/views` | `{"name": "Qualified", "description": "...", "where": [...], "hidden_columns": ["Notes"]}`. A copy of the view showing (or of `from`, a view's name or id), then the `where` and `hidden_columns` you give. It doesn't switch the view the app shows. `201`, `write` scope. |
| `PATCH /sheets/:id/views/:view` | Any of `name`, `description`, `where`, `hidden_columns` (`null` or `[]` clears). `:view` is an id or a name. `write` scope. |
| `DELETE /sheets/:id/views/:view` | Deletes the view, never rows or columns. The Default view can't be deleted. `write` scope. |

### Setups

| Endpoint | Body or query |
|---|---|
| `GET /setups` · `GET /setups/:id` | The saved setups; one in full. `read` scope. |
| `GET /sheets/:id/setup-steps` | The sheet's filled columns as steps: what each reads, or why it can't be saved. `read` scope. |
| `POST /sheets/:id/setups/plan` | `{"columns": ["Fit (Output)"], "include_upstream": true}`. What a setup of them would hold; saves nothing. `read` scope. |
| `POST /sheets/:id/setups` | `{"name": "Lead fit", "columns": ["Fit (Output)"]}`, plus optional `description` and `include_upstream`. Same as `save_setup`. `201`, `write` scope. |
| `PATCH /setups/:id` | `{"name": "...", "description": "..."}`. `write` scope. |
| `DELETE /setups/:id` | Permanent. `write` scope. |
| `GET /setups/:id/export` | `{file, filename}`: the setup as a file for another Cubex, saved keys by name only. Refused while a key is typed straight into a request. `read` scope. |
| `POST /setups/import` | The `file` from an export. A name already taken gets " (2)". `write` scope. |
| `POST /sheets/:id/setups/:setupId/apply` | `{"inputs": {"Website": "Company URL"}, "names": {}, "models": {}, "first_rows": 10, "estimate_only": true}`. Same as `apply_setup`, but `estimate_only` defaults to `false` here. `200` with the estimate, `201` with the `setup_run`; a missing input or a name taken answers `missing` or `taken`. `max_cost_usd` and `allow_unpriced` work as on `apply_setup`: over the ceiling it answers `409` with `over_ceiling: true` and the `estimate`. `run` scope (and `secrets` for saved keys). |
| `GET /sheets/:id/setup-runs` · `GET /setup-runs/:id` | The setups working on a sheet (newest first, `?setup_id=` for one setup's), or one of them, with the `choices` each was used with. `read` scope. |
| `POST /setup-runs/:id/control` | `{"action": "pause"}` (or `resume`, `cancel`). `run` scope. |

### Setup versions

| Endpoint | Body or query |
|---|---|
| `GET /sheets/:id/setup-versions` | The sheet's versions, newest first: `{id, name, description, auto, by, saved_at, columns, filled}`. `read` scope. |
| `POST /sheets/:id/setup-versions` | `{"name": "Before the new prompt", "description": "..."}`. Keeps the setup as it is now. `201`, `write` scope. |
| `GET /sheets/:id/setup-versions/:versionId` | The version against the sheet now: the same answer as `restore_setup_version` with `dry_run`. `read` scope. |
| `PATCH /sheets/:id/setup-versions/:versionId` | `{"name": "...", "description": "..."}`. `write` scope. |
| `DELETE /sheets/:id/setup-versions/:versionId` | Permanent; the sheet doesn't change. `write` scope. |
| `POST /sheets/:id/setup-versions/:versionId/restore` | A dry run unless the body says `{"dry_run": false}`, as `restore_setup_version`: it only says what restoring would do, and `blocked` why it can't now (`read` scope). `{"dry_run": false}` restores: `write` and `run` scopes (and `secrets` when a request it puts back reads a saved key). |

### Rows

Rows are addressed by their stable `id`, which survives sorts and imports.

| Endpoint | Body or query |
|---|---|
| `GET /sheets/:id/rows` | `?limit=100&cursor=...`. Returns `{rows: [{id, index, data}], next_cursor}`. `limit` is 1 to 500 (default 100). Pass `next_cursor` back as `cursor` until it's `null`. Add `&include_status=true` for run columns as `{status, value, error}`. |
| `POST /sheets/:id/rows/query` | `{"where": [{"operator": "has_error"}], "columns": ["Email"], "limit": 100, "cursor": 0, "return_mode": "rows", "include_status": true}`. `where` is the same as in MCP (see [Finding rows](#finding-rows)): text, number and list operators, OR groups, and run states. Values are strings. `return_mode` is `rows`, `ids` or `count`; `include_status` works with `rows`. `columns` can take a value out of a JSON cell ([Values inside JSON cells](#values-inside-json-cells)), and `group_by` with `aggregates` answers groups instead of rows ([Counting and summing](#counting-and-summing)). `view` reads through a saved view (see [Saved views](#saved-views)). To page a filtered query, send back `expected_data_version` and `expected_row_generation` from the previous page; you get a 409 if the sheet changed in between. `{"row_ids": ["..."]}` (up to 1,000) reads those rows instead, in the order given, with `missing` for ids that are no row of the sheet; it takes `columns` and `include_status` only ([Rows by id](#rows-by-id)). `{"updated_since": "2026-11-05T10:00:00Z", "limit": 500}` reads the rows changed since then, oldest change first, paged with the text `next_cursor` it answers as `cursor`, plus `as_of` for the next read and `filling` for the columns being filled; it takes `columns`, `include_status`, `limit` and `cursor`, not `where`, `view` or `group_by` ([Keeping a copy up to date](#keeping-a-copy-up-to-date)). `{"max_chars_per_cell": 200}` cuts each cell to its first 200 characters and lists the cells cut in `cut_cells` as `{"<row id>": {"<column>": <full length>}}` (`{}` when none); it works with every read of rows, and digits sent as text (`"200"`) count as the number ([Long cells](#long-cells)). |
| `POST /sheets/:id/rows` | `{"rows": [{"data": {"Email": "a@b.com"}}]}`, up to 1,000 rows. Note the `data` wrapper (MCP's `append_rows` takes the objects directly). `201`; a replay answers `200`. |
| `PATCH /rows/:rowId` | `{"data": {"Status": "Done", "Notes": null}}`. `null` clears a cell. |
| `POST /sheets/:id/rows/update` | `{"updates": [{"row_id": "...", "data": {"Status": "Done"}}]}`, up to 1,000. |
| `POST /sheets/:id/rows/delete` | `{"row_ids": ["..."]}`, up to 1,000. They go to the trash: the answer's `trash` gives the `trash_id`. |
| `POST /sheets/:id/import` | Multipart form: the CSV in a field named `file`, plus `replace=true` to replace the rows instead of appending (the replaced rows go to the trash). Answers `rows_imported`, `starting_row`, `new_columns`, `truncated_cells` (cells cut to fit), `replaced` and `dropped_blank_starter_rows`, plus `auto_dedupe`, `trash` and `auto_run` when they apply; when cells look garbled, also `garbled_cells`, `garbled_samples` and a `note` ([Garbled text](#garbled-text)). |
| `GET /sheets/:id/export` | The whole sheet as CSV, streamed (any size). `?view=<name or id>` exports a saved view: its rows and visible columns. |
| `POST /sheets/:sourceId/rows/transfer` | Copy or move rows to another sheet. |

**Retrying safely:** the three writes above (append, `PATCH /rows/:rowId`, `rows/update`) take an `Idempotency-Key` header or `idempotency_key` in the body, as `append_rows` and `update_cells` do: see [Retrying row writes](#retrying-row-writes).

### Saved keys

| Endpoint | Body or query |
|---|---|
| `GET /saved-keys` | Same as `list_saved_keys`: `{keys: [{name, created_at, updated_at, used_in, used_in_count, setups, setups_count}], keys_count, next_after?}`, each place in `used_in` as `{sheet_id, sheet_name, table_id, table_name, column, kind, auto_run}`. Up to 20 keys a call with 10 places and 10 setups each (the counts are whole); `?after=` with `next_after` for the next keys. `?name=` for one key (any case; `404` when there's none) with up to 50 places and 50 setups. Never a value. `read` scope. |

A saved key's name can be at most 200 characters. Only saving or renaming a key to a longer name is refused: a key saved with a longer name before this limit still works, lists and pages, and every listed key can be looked up by `name`, whatever its length.

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
- The estimate sizes each row's answer from your past rows, in this order: this column's own runs of the same prompt, then runs of the same prompt on the model, then previews of that prompt, then any run on the model. "The same prompt" means the same prompt text, system prompt and number of output columns. What web search and fetch add to the prompt is read only from runs and previews with the same web tools and the same web fetch limits (no limit counts as a setting of its own). Each needs at least 5 finished rows, or the next one answers. `assumptions.history_from` says which one it used (`column`, `prompt`, `preview` or `model`; `null` when none had enough, so a default size was used) and `assumptions.history_rows` how many rows it read. `basis` keeps its meaning (`history`, `heuristic-no-history` or `measured`). Runs from before this update are found by their column and model, whatever their prompt, and not by their prompt.
- The estimate and the preview both return `in_flight`: what the run holds of OpenRouter's in-flight credit budget at its concurrency, and a `warning` when that could be refused. It comes back on your own provider key (BYOK) too. OpenRouter holds nothing for a call your key serves, but a row your key can't serve falls back to OpenRouter's credits and is held, and web search and fetch are paid by OpenRouter, so such rows can still be refused with a `402`.
- Each preview row has `cost_usd` (what OpenRouter charged), `paid_with` and `tokens` `{input, output, reasoning}` (`null` where OpenRouter didn't report one). `paid_with` is `"own_key"` when the row ran on your own provider key, `"credits"` when OpenRouter's credits paid for it (on a run meant for your own key, that means OpenRouter fell back to its credits), or `null` when OpenRouter didn't say. A row on your own key also has `provider_cost_usd`: what your provider charged, or `null` when OpenRouter didn't say, since the provider bills your key directly (its own dashboard has that cost). What a preview measured is kept for later estimates of the same prompt on the same model (a new preview of it on the same sheet replaces the last one, and the newest 2,000 preview rows are kept).
- `output_columns: [{"column_name", "type", "description"}]` fills several typed columns from one call per row.
- `web_search: true` lets the model search the web. `web_fetch: true` lets it open pages, but only on the sites named in the cells the prompt references, so a prompt that mentions `/domain` keeps each row on its own site. Either one works with `output_columns`: the run also fills a `<column_name> (Data)` column with the sources it used. Estimates include web fees, and previews use the same tools and list each row's sources.
- Web fetch has two limits (each needs `web_fetch: true`). `max_content_tokens` (100 to 100,000) cuts each page to about that many tokens. A page's text goes into the prompt, so this bounds what a row costs. `max_pages_per_row` (1 to 50) is the most pages a row may open; after that, a fetch is refused and the model answers from what it read. 50 is Cubex's own cap: Exa sets none. With either one, pages are read through Exa ($0.001 a page), because a model's own fetch doesn't cut pages. If an admin of your OpenRouter workspace limited the web fetch engines on its Server Tools page, Exa must be allowed for these runs: otherwise OpenRouter refuses their calls (`403`), and the run pauses once with `pause_reason: "web_engine"` and a `pause_message` that says so. No row is marked failed; allow Exa there and resume, or run the column again without the limits. A row's most under a spend limit counts 3 pages of 6,000 tokens, or the limits where they allow more. Without limits, a model whose provider fetches pages itself does so at that provider's price, which OpenRouter passes on: the estimate counts that fee from $0 to $0.001 a page and says so (`max_cost_usd` checks the high end), and otherwise counts $0.001 a page. A value out of range is refused with the range (MCP: `Input validation error: Invalid arguments for tool run_ai_column: max_pages_per_row: max_pages_per_row must be a whole number from 1 to 50.`; REST: `400` with `{"error": "max_pages_per_row must be a whole number from 1 to 50."}`), and so is a limit without `web_fetch`. Digits sent as text (`"3"`) work on both. Reruns and saved setups keep the limits, and the app's AI column has them under "Fetch URLs from referenced columns".
- Search fees are usually most of a web run's cost, so you can choose how searches run (each needs `web_search: true`):
  - `search_engine`: `auto` (the default: the model's own search if it has one, otherwise Exa), `native` (the model's own search, billed by its provider at its list price: about $0.01 a search on OpenAI and Anthropic, $0.025 on GPT-4.1, $0.014 on Google, $0.005 on xAI), `exa` ($0.007 a search), `parallel` ($0.005, or $0.001 in `turbo` or `fast` mode) or `perplexity` ($0.005). Prices as of October 2026; the estimate shows the live price of what will run.
  - `search_mode` (with `search_engine` `exa` or `parallel` only; deeper modes search more thoroughly, take longer and cost more): for `exa`, `instant`, `fast` or `auto` (default) at $0.007, `deep-lite` or `deep` at $0.012, `deep-reasoning` at $0.015; for `parallel`, `turbo` (English and Japanese only) or `fast` at $0.001, `basic` (default) or `advanced` at $0.005.
  - `max_searches_per_row`: a hard limit from 1 to 10. Exa, Parallel and Perplexity enforce it, and so does Anthropic models' own search; a row that reaches it is made to answer. OpenAI's, Google's and xAI's own search can't be limited: with `auto`, Cubex then uses Exa and says so (`switched: true`); with `native`, the run is refused.
- The estimate names the engine the run will really use and prices that one. Its `web_search` block has `engine` (what the run sends to OpenRouter), `runs_on` (what runs the searches), `mode` (the one billed: the engine's default when you chose none), `price_per_search_usd`, `switched`, the searches it expects per row, and what your past runs with the same settings really cost per row.
- Every row records what it searched for and what it cost. `GET /ai-runs/:id/results` (MCP `get_run_results`) returns `cost_usd`, `searches` (how many ran) and `search_queries` (`[{query, ran}]`, where `ran: false` is a search the limit stopped) for each row, and the run's status adds up `cost_usd` and `searches`. Every AI row also has `paid_with` and `tokens`, as in a preview, and `provider_cost_usd` on your own key (rows from before this update have `paid_with: null` and `reasoning: null`). `GET /ai-runs/:id` (MCP `get_run_status`) counts rows per payer in `rows_paid_with` `{own_key, credits}` once a row has said, so you can see when OpenRouter fell back from your key to its credits. The `(Data)` cell shows the same, cost first: `📊 $0.0018 · 1 search: "stripe ceo" · 5 sources: …`. With a model's own search (`runs_on: native`), the searches and their words show up only when the provider reports them; the cost is always OpenRouter's own figure.
- `run_if`: run only the rows that pass a rule. See [Only run if](#only-run-if).
- `max_cost_usd` refuses a start whose estimate could cost more, counting one row's most on top of the high end (`409`, `over_ceiling: true`, with the estimate; its `row_most_usd` is that row's most, of the sampled rows), and so does something with no known price unless `allow_unpriced: true`. It is also the run's hard spend limit. `spend_limit_usd` sets the limit alone. See [Cost ceiling and spend limits](#cost-ceiling-and-spend-limits).
- Boolean options also take the text `"true"` or `"false"`.
- Also optional: `system_prompt`, `temperature`, `max_chars`, `concurrency`.
- `model` is required unless you've set a default (Settings → AI). `GET /models?search=deepseek` finds exact ids. A model ending in `:batch` (before any `:nitro`, `:floor`, `:exacto` or `:online`) runs only through OpenRouter's batch API, which Cubex doesn't use, so it is refused (`400`) with `The model "<id>" is a batch-only variant: it runs only through OpenRouter's batch API, which Cubex doesn't use. Use "<id without :batch>" instead.` `GET /models` leaves those out.

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

- `{{name}}` takes a column's value or a saved API key (saved keys need the `secrets` scope). A name that matches neither is refused before anything is sent. Once a column the request read is deleted, a saved key with its name never stands in for it: a rerun is refused until you edit the column or add the column back. A start, rerun or resume is also refused (`409`) while a column the request reads is still being filled by another run, or is getting back what it held before a stopped one, so no request goes out with `⏳ Processing...` in it; wait for that run, or stop it, and try again. A running request waits for a column another run is filling instead: the row sends nothing until the column is free, then sends what the row holds then (pausing or stopping the run still works meanwhile). While the run it waits for hasn't started yet or is paused, the waiting run gives its place in the queue back: `get_run_status` shows it `pending` until it goes on by itself. When runs would wait for each other in a ring, the newest of them fails the rows that would wait, naming the columns, so the others finish; run those rows again once the column is filled.
- Also optional: `body` (for POST, PUT and DELETE), `master_column_name` (the status column), `batch_size` (requests at once, default 5, up to 100) and `timeout_ms` (per request, default 30,000).
- Retries: a request answered `429` or `503` is sent again, whatever the method; another `5xx`, or no answer at all (refused, reset, timed out), is sent again for GET, HEAD, PUT and DELETE, and for POST only with `"retry_post": true`. `retries` (0 to 5, default 3) sets how many more tries a row gets; each waits longer than the last (with some randomness) or as long as the API's `Retry-After` asks, up to a minute. A `4xx` is never retried. A row that still fails says how many tries it took (`(tried 4 times)` in its error). Every try is checked like the first: private addresses are refused and redirects aren't followed. Pausing or cancelling stops a row that is waiting to try again.
- `skip_empty_values: true` leaves out a query parameter, form field or JSON body field whose `{{column}}` is empty for a row, instead of sending it empty. Cell values always go in the way their place needs: escaped inside a JSON string in the body, and in a query value `&`, `#`, `+` and a stray `%` are encoded, so `a+b@x.co` or `AT&T` arrive as they are (a value already holding `%XX` escapes keeps them). A `{{column}}` standing for a whole JSON value (`"count": {{Count}}`) goes in as written, and saved keys always go in exactly as saved.
- `status_code_column: "Code"` adds a column with each row's HTTP status code, failed rows included (`❌ No response` when the API never answered). The same column comes from a `response_mapping` entry with `"json_path": "@status"`.
- `webhook_id`: a [run webhook](run-webhooks.md) to tell when this run finishes. The AI and enrichment starts, `apply_setup` and the reruns below take it too.
- `curl`: a whole cURL command, copied from an API's docs or a browser, in place of `url`, `method`, `headers` and `body`. `{{column}}` works inside it. A key Cubex finds in the command (sign-in headers and `-u`, headers and fields named like keys, well-known key formats) is never stored in the column's setup: the call is refused and names where the key is, unless you pass `save_keys`. `"save_keys": true` saves each key as a saved key under a suggested name (a key already saved with the same value is used instead), and `"save_keys": {"Authorization header": "openai"}` names every key. Saving needs the `secrets` scope. Keys are saved just before the run starts, after its other checks pass (`estimate_only` lists them as `keys_to_save`). A `$VARIABLE` where a key goes uses the saved key with that name. The reply lists `saved_keys` and `notes` (what the command asked for that Cubex changed or left out).

```json
{
  "curl": "curl https://api.example.com/people?email={{Email}} -H 'Authorization: Bearer $EXAMPLE_KEY'",
  "response_mapping": [{ "json_path": "$.title", "column_name": "Job title" }]
}
```
- `run_if`: run only the rows that pass a rule. See [Only run if](#only-run-if).
- The earlier shape, `{"config": {"requestConfig": {...}, "responseMapping": [{"jsonPath", "columnName"}], "batchSize": 5}}`, still works.

**Enrichment run:** `POST /sheets/:id/enrichment-runs` takes `run_enrichment`'s arguments as JSON:

```json
{
  "tool_id": "treg.people.email.find",
  "preset": "verified_email",
  "column_name": "Work email",
  "inputs": { "full_name": "Name", "domain": "Website" },
  "test": true,
  "estimate_only": true
}
```

**Waterfall column:** `POST /sheets/:id/waterfall-columns` takes `waterfall_column`'s arguments as JSON (see [Waterfalls](#waterfalls)), but here `estimate_only` defaults to `false`: pass `"estimate_only": true` to price it first. `GET /sheets/:id/waterfall-columns/:column` (`read` scope) returns a column's setup in the same shape, step ids included, to change and send back with `"add_to_column": true`.

**Retrying safely:** send an `Idempotency-Key` header (or `idempotency_key` in the body). Repeating a start with the same key and arguments returns the original `run_id` instead of starting (and paying for) a second run. Such a retry answers what the first start answered, even when the sheet has changed since (the column it made now exists, its webhook was deleted): only the token's scopes are checked again. As with row writes, the key belongs to the account, so a retry from another token replays too, when that token has the scopes the start needs (a cURL command with a key in it, or a request that uses a saved key, needs `secrets`; without it, the retry gets the start's refusal). Which saved keys a request uses is read from the saved key names at the time of the retry. It also replays after the sheet went to the trash, where a start without the key gets `Sheet not found`. A dry run's replay reads its trace again from the trashed sheet.

| Endpoint | Body or query |
|---|---|
| `POST /sheets/:id/run-conditions/check` | `{"rule": "{{Tier}} is \"A\""}`: how many rows pass, and the first rows with their verdict. `read` scope. |
| `POST /sheets/:id/run-conditions/generate` | `{"text": "tier A companies", "model": "..."}`: writes a rule with one AI call (`model` optional). `run` scope. |
| `GET /runs` | Recent runs, newest first. `?sheet_id=...&filter=active` (`active`, `terminal` or `all`) `&limit=20` (up to 50). |
| `GET /ai-runs/:id` · `GET /http-runs/:id` | Status and progress. `completed` means every row was processed, not that every row worked: check `failed_rows`. A structured AI run also lists its `output_columns`, and a run with web search or fetch names its `data_column` (the sources). An AI run reports what its rows cost so far (`cost_usd`) and, with web search, the searches that ran (`searches`) and its `web_search` settings. An AI run with a spend limit reports `spend_limit_usd` and, until it finishes, `resume_least_usd` (the least limit a resume takes). |
| `GET /ai-runs/:id/results` (same for `http-runs`) | Per-row results and errors. `?status=failed` (`failed`, `completed` or `all`, default `all`), paged with `limit` and `cursor` like rows. AI rows also carry `cost_usd`, and with web search `searches` and `search_queries`. |
| `POST /ai-runs/:id/pause`, `/resume`, `/cancel` (same for `http-runs`) | An AI run's resume takes `{"spend_limit_usd": 5}` to raise the limit that paused it (`pause_reason` `spend_limit`). |
| `GET /ai-runs/:id/undo` · `POST /ai-runs/:id/undo` (same for `http-runs`) | GET says whether the run can be undone (`can_undo`, `reason`), how many rows it wrote, and an undo's `state`, `restored`, `skipped` and `gone`; `read` scope. POST undoes it: `200` once done, `202` while a big undo goes on in the background (GET it for the counts). Nothing runs again or is billed. `write` scope. See [Undo a run](#undo-a-run). |
| `GET /sheets/:id/undo?column=...` | The column's newest run that can still be undone, as `GET /ai-runs/:id/undo` (or `http-runs`) answers it, or `null`. `read` scope. |
| `POST /sheets/:id/runs/stop` | Stops every AI, HTTP and enrichment run on the sheet and every setup being used on it, at once (MCP `control_run` with `cancel_all`). Returns `stopped_runs`, `stopped_setup_runs`, `auto_run_paused` (columns whose auto-run batch it stopped: paused until you resume them), `auto_run_on` (auto-runs still on, where new rows start runs), `still_filling` (free fills, which finish) and a `message`. Calls already sent finish and are billed. `run` scope. |
| `POST /ai-runs/:id/rerun` | `{"mode": "errored"}`, `{"row_ids": [...]}` or `{"first_rows": 10}`. One of them is required. Modes: `errored` (failed rows), `empty`, `missing` (empty, failed or unfinished), `out_of_date` (results whose input cells changed since), `empty_or_out_of_date`, `all`. Starts a new run, which costs credits again. Add `"concurrency"` (1 to 100) to change how many rows run at once; rows that failed on OpenRouter's in-flight credit budget need a lower one. `first_rows` reruns only among the sheet's first rows (up to 1,000, not with `row_ids`): all of them, or those `mode` picks. A structured (`output_columns`) run refills all its columns on those rows; its modes read the `(Status)` column. `spend_limit_usd` gives the new run a hard spend limit. |
| `POST /http-runs/:id/rerun` | `{"mode": "missing"}` or `{"row_ids": [...]}`. Modes are the AI rerun's (`errored`, `empty`, `missing`, `out_of_date`, `empty_or_out_of_date`, `all`). Without either, every row runs again. `"first_rows": 10` takes only the sheet's first rows (not with `row_ids`, and not on an enrichment or waterfall run). An enrichment or waterfall run needs `row_ids` or `mode`: `errored`, `empty` (not run yet), `missing` (no result), `out_of_date`, `empty_or_out_of_date` or `all`, and takes `spend_limit_usd`. An HTTP API or enrichment run takes `concurrency` (rows at once, 1 to the server's `HTTP_MAX_CONCURRENCY`: 100 unless it's set, 20 in the Docker Compose file; default: the run's own): an HTTP API run's new run keeps it as its batch size, so later reruns and the column's auto-run batches repeat it. A waterfall run refuses it. Out of range, `concurrency` answers `400` `concurrency must be a whole number from 1 to 100.`, with the server's bound in place of 100. MCP's `control_run` refuses with the same words. Its input schema publishes `concurrency` up to the larger of 100 (the AI runs' bound) and the server's bound; when the two differ, a value outside the schema is refused with words naming both, and each run kind's own bound is checked after that, in the words above. Only a waterfall column's newest run can be rerun, with the column's setup. |
| `POST /http-runs/:id/resume` | An enrichment or waterfall run takes `{"spend_limit_usd": 40}` to raise the limit that paused it. An HTTP API or enrichment run takes `concurrency` (rows at once, 1 to the server's `HTTP_MAX_CONCURRENCY`) to change its speed: an HTTP API run keeps it as its batch size, which later reruns and the column's auto-run batches repeat. Out of range it answers `400` as a rerun does. A waterfall run refuses it (`400` `concurrency doesn't apply to a waterfall run.`), and so does an AI run. |

Both reruns also take `webhook_id`, a [run webhook](run-webhooks.md) to tell when the new run finishes.

An enrichment is an HTTP run: `GET /http-runs/:id` adds `cost_usd`, `daily_limit` and `enrichment` (the tool, its limits, `pause_reason`, and a list job's progress), and `GET /http-runs/:id/results` adds each row's `cost_usd` and `found_by` (and `reused_answer_from` on a row filled from an earlier found answer), plus its stored `answer` with `?answers=true` (10 rows a page).

A waterfall is an HTTP run too: `GET /http-runs/:id` adds `cost_usd` (treg and AI) and `waterfall` (`result_type`, `spent`, `run_limit_usd`, `pause_reason` and per step its counts and cost), and `GET /http-runs/:id/results` adds each row's `answered_by`, `cost_usd` and `trace`, as `get_run_status` and `get_run_results` do (see [Waterfalls](#waterfalls)).

### Run webhooks

URLs Cubex tells, with a signed POST, when a run finishes. Agents use `list_run_webhooks` and `manage_run_webhook`, the same actions as below. Reading needs `read`; adding, changing, deleting, a new secret and a test need `run` (they decide where Cubex sends requests, as an HTTP API column does). See [Run webhooks](run-webhooks.md) for the notice and how to check its signature.

| Endpoint | Body or query |
|---|---|
| `GET /run-webhooks` | The webhooks: `id`, `url`, `every_run` and the last delivery. Never the secret. |
| `POST /run-webhooks` | `{"url": "https://...", "every_run": true}`. Answers `201` with `webhook` and `secret`, the only time the secret is shown. The URL must be a public http(s) address. |
| `GET /run-webhooks/:id` · `PATCH /run-webhooks/:id` | Read one; change its `url` or `every_run`. |
| `DELETE /run-webhooks/:id` | Deletes it and its log. Runs that named it just aren't told. |
| `POST /run-webhooks/:id/secret` | A new secret, shown once; the old one stops signing at once. |
| `GET /run-webhooks/:id/deliveries` | The last 50 deliveries, newest first: `state` (`pending`, `sending`, `delivered`, `failed`), `tries`, `response_code`, `error`. |
| `POST /run-webhooks/:id/test` | Sends a signed `test` notice now, once, and answers with how it went. |

### Enrichments

| Endpoint | Body or query |
|---|---|
| `GET /balances` | Same as `get_balances`. |
| `GET /usage` | Same as `get_usage`: `?sheet_id=` (leave out for the whole account), `group_by` (`column`, `day` or `run`), `range` (`this_week`, `this_month`, `last_week`, `last_month`) or `from` and `to` (`2026-10-01`), `limit` (up to 1,000; totals always cover the whole range). `format=csv` downloads every row. Days are UTC, and a run counts on the day it started. `read` scope. |
| `GET /enrichments` | `?q=work email`. Without `q`, the popular jobs. |
| `GET /enrichments/:toolId` | A tool's inputs, outputs, price and providers. |
| `POST /sheets/:id/enrichment-runs` | `run_enrichment`'s arguments (above). `202` with the `run_id`, plus `chained_auto_run` when auto-runs in the sheet read what the run writes (they fill those rows after it; HTTP ones send real requests); an estimate or a replay answers `200`. |
| `GET /sheets/:id/enrichment-list-fields` | `?column=People`: the fields a list job's results have. |
| `POST /sheets/:id/enrichment-list-fields` | `{"column": "People", "fields": [{"path": "$.first_name", "column_name": "First name"}], "dedupe_path": null}`: adds the waiting results as rows. |
| `POST /sheets/:id/enrichment-fields` | `{"column": "Work email", "json_path": "$.output.linkedin_url", "column_name": "LinkedIn"}`: a column from stored answers (`202`; it fills in the background). |
| `PUT /sheets/:id/enrichment-auto-run` | `{"column": "Work email", "enabled": true, "daily_cap_usd": 5}`, or `{"paused": true}` for every auto-run on the sheet. |
| `POST /ai-visibility` | `ai_visibility` create's arguments: `{"brand": "Acme", "other_brands": ["Northdesk"], "questions": ["Best CRM for a small team?"]}`. `201`. `write` scope. |
| `POST /ai-visibility/:id/ask` | `{"estimate_only": true}` for the cost, or `{}` to start (`again: true` asks every question again). `:id` is the table's id or its Questions sheet id. `run` scope. |
| `POST /ai-visibility/:id/check-again` | `{}` for the plan and its cost (the default), `{"estimate_only": false}` to keep the answers there in dated sheets, add the comparison columns and ask every question again; `time_zone` (optional) dates them in the user's day; `fresh: true` starts a new check rather than picking up one that stopped. Same as `ai_visibility` check_again. `run` scope. |
| `PUT /ai-visibility/:id/brands` | `{"brand": "Acme", "other_brands": ["Pipewell"]}`. `write` scope. |

### Trash and history

| Endpoint | Body or query |
|---|---|
| `GET /trash` | Same as `list_trash` without an id: `?q=` (a table, sheet, column or token name), `kind` (`rows`, `sheet`, `table`, `column`), `how` (`grid`, `api`, `duplicates`, `auto_dedupe`, `import`, `transfer`, `rerun`, `sheet`, `table`, `column`), `sheet_id`, `before` (the next page), `limit`. `read` scope. |
| `GET /trash/:id` · `GET /trash/:id/rows` | One item; a batch's rows, or a column's cells: `?after=` (a `seq`), `limit` (up to 500), `column` and `contains` to search. `read` scope. |
| `GET /trash/:id/csv` | A batch's rows, or a column's cells, as CSV. `read` scope. |
| `POST /trash/restore` | `{"trash_ids": [12, 14]}`: tables first, then sheets, then columns and rows, newest deletion first. `results` says what each did. `write` scope. |
| `POST /trash/:id/restore` | One item, or `{"seqs": [3, 9]}` for rows picked from a batch (a column comes back whole: `400` with seqs). A column answers `name`, `old_name`, `renamed`, `position`, `cells_restored`, `cells_skipped`, `cells_kept`, `setup` and `references_dropped` (each `redo` names the REST route); kept and skipped cells stay in the item. `403` for a column whose request reads saved API keys, from a token without `secrets`; `409` for a column still moving into the trash. `POST /trash/restore` answers `200` with those refusals in `results`. `write` scope. |
| `GET /sheets/:id/history` | Same as `get_sheet_history`: `?before=` (a change id), `limit`, `column`. `read` scope. |

### Responses and errors

- Answers are JSON, with U+0080 to U+009F written as `\u0080` to `\u009f` escapes (the same text once parsed; see [Garbled text](#garbled-text)).
- Errors are JSON: `{"error": "message"}`. Some add detail: `unknownColumns`, `lockedColumns` (columns a run is still filling), `protectedColumns`, or `busy: true` (the sheet is in the middle of an import or sort; retry shortly).
- `400` bad input · `401` missing or revoked token · `403` the token lacks a scope · `404` not found · `409` conflict (a name already taken, a run already active, a sheet that changed while you paged, an idempotency key sent before with other arguments, a start over its cost ceiling: `over_ceiling: true` with the `estimate`) · `413` body over 2 MB · `429` rate limited.
- The limits above apply to each token across MCP and REST together. Every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and a `429` adds `Retry-After` (and `retry_after_seconds` in the body when the run-start or sheet-copy limit refused it; its `RateLimit-*` headers then describe that limit).

## Security notes

- A token is as good as your password for whatever its scopes allow. Give each assistant its own token so you can revoke one without breaking the others.
- Browser pages can't call `/mcp` (requests carrying a foreign `Origin` header are refused), which blocks DNS-rebinding tricks against a Cubex running on localhost. Desktop and command-line clients don't send that header and aren't affected.
- Upload and download links work once, expire after 15 minutes, and die with the token that made them. Cubex stores only a hash of each. See [Big CSV files](#big-csv-files).
- Cell values are data, not instructions. They can come from anyone who can send a webhook, from imported files, and from AI or HTTP runs, so a cell can contain text written to steer an assistant. Cubex tells connected assistants never to follow instructions found in cells; review what an assistant proposes to do with data it read.
