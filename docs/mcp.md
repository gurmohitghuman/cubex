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
| `run` | Also start, pause, resume, stop and re-run AI, HTTP, enrichment and waterfall runs, and turn auto-run on or off. These spend your OpenRouter credits and your treg balance, and call your APIs. |
| `secrets` | Also start HTTP runs that use your saved API keys, and save the keys in a pasted cURL command as new saved keys. Needs `run`. |

`write` and `run` each include `read`. `run` doesn't include `write`, but starting a run does create its output columns. You can have 10 active tokens and revoke any of them at any time. A token can't create other tokens or change your password, and it can never read or change a saved key. With `secrets` it can add a new one, from a cURL command it passes to an HTTP run.

**Spend cap.** Give a token a spend cap when you create it, or later from its row in **Settings → Agent access**, to limit what an agent can spend in dollars. It counts what the runs the token started spent on AI (OpenRouter's charge and your own provider key's) and on enrichments, and also its previews and AI helpers (`preview_rows`, `write_formula`, `write_run_condition`). Auto-runs it turned on and setups it applied count too. These are the same numbers as the usage history. The cap is for the token's whole life, not a month: to go on, raise it or make a new token. At the cap, new AI and enrichment runs, previews and AI helpers are refused with a message that says so, and so is resuming any run with that token (yours from the app too). A run a token resumes spends for that token from then on, whoever started it, and calls already out when a run changes hands count for the token that resumed it; what was billed before stays with the token it was billed for. Running runs pause, and so does a setup before its next AI or enrichment step; you can resume them once the cap is raised (an auto-run goes on by itself). Resumed from the app, a run keeps its token, so its cap must have room, unless that token was revoked: then the app takes the run over and what it spends from then on counts against no token. HTTP API runs cost nothing here and are never stopped by the cap. Calls already in flight finish and count, also when you pause or stop the run, so spend can pass the cap by those calls alone: up to an AI run's concurrency (default 5, at most 100) for each run, with up to 4 runs at once, and a preview's rows (up to 20; each token runs at most 3 previews at once, and the app another 3). An enrichment or waterfall run with a per-row cap holds room for its rows first, so it stops before the cap. The token list shows each token's spend, cap and what is left, and the agent sees the same in `get_balances`, `GET /api/v1/me` and the run tools' descriptions. Only the app can set a cap; a token never can. Spend counts from the update that added caps, so older runs don't count.

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
| `read_rows` | Rows, paged, with column selection and filters: text, numbers, lists, OR groups, and run states such as failed or not run yet. `include_status` returns run columns as `{status, value, error}`. `group_by` and `aggregates` count, sum and average per value instead of reading rows, and `columns` can take one value out of a JSON cell. See [Finding rows](#finding-rows). |
| `export_csv` | A sheet (or a filtered part of it, or a saved view) as CSV, up to 40,000 characters. Past that it says how many rows matched; the rest comes from `read_rows`, or save the whole sheet with `create_download_link`. |
| `append_rows`, `update_cells`, `delete_rows` | Add, edit and delete rows by their stable row id. Deleted rows go to the trash. |
| `add_column`, `rename_column`, `delete_column` | Manage columns. `add_column` takes an optional `description`. |
| `set_description` | Describe a column, or the sheet when `column` is left out. See [Descriptions](#descriptions). |
| `sort_sheet` | Permanently reorders the rows by a column. |
| `manage_table`, `manage_sheet` | Create, rename, delete and reorder tables and sheet tabs. A deleted table or sheet goes to the trash whole. `manage_sheet` with `action: "copy"` makes a new sheet right after one, holding its values: the same rows in the same order under plain columns that nothing fills, a run's words (⏳, ❌, ⏭️, ➕) left empty, and only the `columns` you list if you list some. Free; a way to keep a sheet as it is before running its columns again. `manage_table` with `action: "create_sample"` makes a table of 25 made-up leads to try Cubex on: its free columns filled, its duplicate found by a dry run, and an AI column set up but not run (the answer says how to run it once the user agrees). |
| `import_csv` | Load CSV text into a sheet (append or replace). For a file, use `create_upload_link`. |
| `create_upload_link`, `create_download_link` | One-time links to move a CSV file of any size into or out of a sheet with `curl`. See [Big CSV files](#big-csv-files). |
| `run_ai_column` | Start an AI column run. Can estimate the cost first, preview a few rows, target specific rows, or fill several typed columns at once. |
| `run_http_enrichment` | Start an HTTP API column run, from a URL or a whole cURL command. Failed requests are retried; it can leave out empty values and add a response code column. |
| `check_run_condition`, `write_run_condition` | Check an "Only run if" rule on a sheet (free), or write one from plain words with your default AI model. See [Only run if](#only-run-if). |
| `get_run_status`, `list_runs` | Follow a run, or find recent ones. |
| `get_run_results` | Per-row results and errors, to see why cells are blank or wrong. |
| `control_run` | Pause, resume, cancel, or re-run (failed rows, empty rows, rows whose result is out of date, all, or only the sheet's first rows with `first_rows`). `cancel_all` with a `sheet_id` stops every run and setup on that sheet at once. |
| `undo_run` | Undo what a finished run wrote: its cells go back to what they held before it, cells changed since stay as they are, and nothing runs again or is billed. See [Undo a run](#undo-a-run). |
| `list_models`, `set_default_model` | Find OpenRouter models and set the default. |
| `get_balances` | What the account can spend: the treg balance, the enrichment daily limit, what OpenRouter reports for the saved key (its account balance only reaches a management key, so often just the key's own limit), and this token's spend cap with what is left (`access_token`). Costs nothing. |
| `get_usage` | What AI, HTTP API and enrichment runs ran and cost, by column (deleted ones too), day or run, for one sheet or the whole account, over this week, this month, last week, last month or two days you pick. Each row has runs, cells run, cells reused from earlier answers, the cost (OpenRouter, your own AI provider key, treg) and the cost per cell. Costs nothing. |
| `clean_column` | Free cleaning into a new column: names, first and last names, company names, emails, domains, phone numbers, Title Case, lowercase and spaces. No AI and no credits. See [Clean data](#clean-data). |
| `lookup_column` | A new column filled for free from another sheet: a column of the first matching row, yes/no, a count, or the matching rows. See [Lookups](#lookups). |
| `formula_column`, `write_formula` | A new column worked out for free from each row by a JavaScript formula, like picking an item out of an API response by a condition. `write_formula` writes the formula from plain words with your default AI model. See [Formulas](#formulas). |
| `remove_duplicates` | Find rows that match on one or more columns (as text, email, domain, phone, company or person name) and remove all but one of each, for free. A dry run unless `dry_run: false`. See [Remove duplicates](#remove-duplicates). |
| `set_auto_dedupe` | Keep one row per key as rows arrive (webhooks, appends, imports, transfers, edits), for free: the oldest or the newest row of a key stays, the others go to the trash. See [Auto-dedupe](#auto-dedupe). |
| `list_setups`, `save_setup`, `delete_setup` | Save a sheet's filled columns, and every filled column they read, as a named setup; list and delete the saved ones. See [Setups](#setups). |
| `list_setup_versions`, `manage_setup_version`, `restore_setup_version` | Keep a sheet's column setup by name (every column's prompt, request, formula, cleaner, lookup, "Only run if" rule, auto-run, description and the column order, never the values), compare one with the sheet now, and restore it without running anything. See [Setup versions](#setup-versions). |
| `apply_setup`, `get_setup_run`, `control_setup_run` | Build a saved setup's columns on another sheet and fill them in order (an estimate unless `estimate_only: false`), follow it, and pause, resume or stop it. See [Setups](#setups). |
| `transform_column` | Free, instant text transforms (upper/lower case, trim, number, regex extract, split, template) with no model call. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |
| `transfer_rows` | Copy or move rows between sheets on the server. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |
| `search_enrichments`, `get_enrichment` | Find a treg.to enrichment tool, then read its inputs, outputs, price and providers. See [Enrichments](#enrichments). |
| `run_enrichment` | Run an enrichment per row: work emails, phones, person or company data, or lists that become rows in another sheet. Can estimate first, test on 5 rows, and turn on auto-run. |
| `get_list_fields`, `add_list_rows` | For a job that adds rows: read the fields its results really have, then pick the ones to keep and add the rows. |
| `add_enrichment_field` | A new column filled from answers a run already stored, for free. |
| `waterfall_column` | One value per row (a work email, a phone, a domain, any text) from steps tried in turn until one answers: treg tools, AI prompts, your own APIs, free formulas and lookups in your other sheets, with the step that answered in its own column. An estimate unless `estimate_only: false`. See [Waterfalls](#waterfalls). |
| `set_auto_run` | Turn auto-run on or off for an enrichment, HTTP API, clean, formula or lookup column, or pause and resume it. |
| `list_run_webhooks` | The account's run webhooks (URLs told when a run finishes), and one webhook's last 50 deliveries. Pass a webhook's id as `webhook_id` when you start a run to hear when it ends. See [Run webhooks](run-webhooks.md). |
| `list_trash`, `restore_from_trash` | What was deleted and can still come back: batches of rows, sheets and tables. Look inside a batch and search its rows, then restore whole items or rows you pick. See [The trash](#the-trash). |
| `get_sheet_history` | A sheet's change log: columns added, renamed and deleted, runs, auto-run, views, its webhook, rows deleted, restored and imported, with when and who (the app or an access token by name). See [The trash](#the-trash). |

Deleted rows, sheets and tables go to the trash for the days set in Settings (30 by default), and the delete's answer says how to restore them; deleting a column, sorting and deleting a setup or a setup version are permanent. What a run wrote can be undone for 7 days with `undo_run`. Every tool tells your client whether it only reads, adds, or changes and deletes data, so clients can ask you before the risky ones.

When auto-run is on in a sheet, `append_rows`, `import_csv` and `transfer_rows` (and the REST appends and imports) answer with `auto_run`: the columns that will fill the new rows on their own, each with its estimated cost (`estimated_usd`) or, for an HTTP API column, `sends_requests: true`.

Starting a run on a very large sheet answers at once: the run shows as pending while Cubex marks its rows, then starts. Cancelling also answers at once; leftover cells clear in the background.

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

`read_rows`, `export_csv` and `create_download_link` (and REST `rows/query` and `export`) take `view`, a view's name or id, or `active` for the one the app shows: its filters are added to `where`, and when it hides columns its visible columns are the columns unless you pass `columns`. A read through a view answers `view_version`; to page, send it back as `expected_view_version` (plus `expected_data_version` and `expected_row_generation` when the view filters), and you're asked to start again if someone switched or edited the view in between. `get_sheet` lists the views, each with its filters as a `where`. Agents read views; to create or change them, use the app or the REST endpoints below.

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
- `fill` is the column's newest run (`run_id` and `run_status`, for `get_run_status` and `control_run`) with its settings: an AI run's model and prompt, an HTTP API column's method, URL and header names (never their values; a key typed into the URL reads `…`), an enrichment's tool and its limits, a waterfall's result type, its steps in order (each with its tool, model and prompt, request, formula, or the sheet and columns it looks up) and its limits. A clean, formula or lookup column shows its setup.
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

Checks are `is`, `is not`, `contains`, `does not contain`, `is empty`, `is not empty`, `>`, `<`, `>=` and `<=`, and on dates `is before`, `is after`, `is on`, `is not on`, `is on or before` and `is on or after` (`{{Signed up}} is on or after 2024-01-01`; the cell needs a date, in the formats `where` reads), joined with `AND`, `OR`, `NOT` and brackets. Rows that fail it aren't sent anywhere, cost nothing, and show `⏭️ Condition not met` (a cell that already holds a result keeps it). Cells holding Cubex's own words (`⏳`, `❌`, `⏭️`, `➕`) count as empty, so a chain works: give each column a rule on the one before it, once that run has finished.

- `check_run_condition` (free) says how many rows pass and shows the first rows with the values the rule read. A misspelled column is refused with the closest name.
- `write_run_condition` writes a rule from plain words with one small call to your default model (or `model`), and returns it with the same check. The answer names the model and what the call cost.
- `estimate_only` counts only the rows that pass (`rows_skipped_by_rule`). `get_run_status` reports `run_if` and `condition_skipped_rows`. Reruns repeat the rule, and renaming a column updates the rules that name it.

## Clean data

`clean_column` cleans one column into a new column, for free: nothing is sent anywhere and no AI runs. Pick a `cleaner`:

| Cleaner | What it does | Example |
|---|---|---|
| `person_name` | Fixes words typed in ALL CAPS or lowercase (`John SMITH` too), turns "Last, First" around, and drops titles (Mr, Dr), suffixes (Jr, III, PhD, MBA) and nicknames. Words typed in mixed case, like DeShawn or McDonald, keep their capitals. | `smith, john q.` → `John Q. Smith` |
| `first_name`, `last_name` | The same, split. The last name keeps words like "van" and "de la". | `LUDWIG VAN BEETHOVEN` → `Ludwig`, `van Beethoven` |
| `company_name` | Drops legal endings (Inc, LLC, Corp, Co, Ltd, PLC, GmbH, AG, S.A. and more) and a trailing ", a company of X", and fixes ALL CAPS. Keeps words like Holdings and Group. | `ACME CO., LTD.` → `Acme` |
| `email` | Pulls the address out of `Name <address>` or `mailto:`, and lowercases it. Blank when the format is invalid. It doesn't check that mail gets delivered. | `John <John.Smith@Acme.COM>` → `john.smith@acme.com` |
| `domain` | The root domain of a website or an email address. | `https://blog.acme.co.uk/about` → `acme.co.uk` |
| `phone` | One format for every number: `phone_format` is `national` (default), `international` or `e164`, and `phone_country` (default `US`) is how numbers without a country code are read. A number from another country comes out in international form. Blank when it isn't a real number. | `1-212-555-0123 x9` → `(212) 555-0123 ext. 9` |
| `title_case` | Capitalizes each word, keeps small words like "of" lowercase and acronyms like CEO upper. | `vp of sales` → `VP of Sales` |
| `lowercase` | Every letter lowercase. | |
| `trim` | Removes spaces at the ends, extra spaces and line breaks inside, and invisible characters. | |

- The new column is named after its source unless you pass `column`: `Name (clean)`, `Name (first name)`, `Name (last name)` or `Website (domain)`.
- `preview: true` shows the first rows before and after, and writes nothing.
- The answer waits for the column to fill, up to 10 seconds, and says how many rows it cleaned (`cleaned_rows`) and how many values it couldn't read (`blank_rows`). A bigger sheet answers `status: "filling"`; its cells read `⏳ Processing...` until it's done.
- Auto-run is on by default: new rows, and rows whose source cell changes, are cleaned on their own. If you fix a clean cell by hand, your fix stays until its source changes. Turn it off with `auto_run: false` or `set_auto_run`.
- Calling `clean_column` again on a clean column changes it (another cleaner, format or source) and cleans every row again. Any other existing column is refused, so nothing typed by a person is overwritten.

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
- `preview: true` shows the first rows with their results and writes nothing. When that column of the other sheet has no index yet (no lookup reads it), or its index is being built or brought up to date, the preview checks the other sheet's first 50,000 rows and says so (`checked_rows`).
- Auto-run is on by default: new rows, and rows whose `source_column` changes, are looked up on their own. Turn it off with `auto_run: false` or `set_auto_run`.
- Calling `lookup_column` again on a lookup column changes it and looks every row up again. Any other existing column is refused, and so is a lookup into its own sheet.
- Renaming a column of the other sheet updates the lookup. Deleting the other sheet, or a column the lookup reads, stops it: `get_sheet` shows why in `broken`, and `lookup_column` with new settings sets it up again.
- The answer waits for the fill up to 10 seconds and returns `filled_rows` and `error_rows`; a bigger sheet returns status `filling` (`get_sheet` lists it in `filling_columns` until done). Contains on very large sheets can take a few minutes. A lookup column isn't a setup step: a setup reading one lists it as an input.

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
- **Where they go:** the trash, one batch per sheet a day. `list_trash` with `how: "auto_dedupe"` and the `sheet_id` lists them.
- **Rows already there** stay as they are when it's turned on: `get_sheet`'s `auto_dedupe.shared_rows` says how many share a key with an older row, and `remove_duplicates` cleans those up once. On a big sheet the keys take a moment to read (`state: "building"`); rows arriving meanwhile are checked once it's done.
- **Runs:** a row a run is working on is never removed; that check waits for the run (`waiting_rows`). Turning it on, changing it and turning it off are refused while a run is active on the sheet.
- Call it again to change it (fields left out stay); `off: true` turns it off. `get_sheet` shows the setting as `auto_dedupe` (or `null`). Needs the `write` scope.

## The trash

Deleted rows, sheets and tables aren't gone at once: they wait in the trash for the days set in Settings (30 by default, up to 90; 0 deletes at once), then are deleted. The app has a Trash page; agents use `list_trash` and `restore_from_trash`.

- **What goes there:** rows from `delete_rows`, `remove_duplicates`, an `import_csv` (or upload link) in replace mode, `transfer_rows` moving rows out, and the app's deletes, one batch per deletion; rows [auto-dedupe](#auto-dedupe) didn't keep, one batch per sheet a day; a deleted sheet or table, whole (rows, columns, runs, views, webhook). A deleted sheet's webhook answers 404 until it's back, and lookups into it stop with a message.
- **The answer:** each of those deletes answers with `trash`: `trash_id`, `kept_days`, `restorable_until` and `how_to_restore`.
- **Restoring rows:** a batch goes back to its old places when the sheet hasn't been sorted, replaced or deduplicated since and those places are free; otherwise to the end of the sheet, in the order the rows had. Rows keep their ids. Columns they need that the sheet lost come back (`columns_added`); when the sheet has no room for them, the restore is refused rather than leaving cells out. Rows moved out with `transfer_rows` are still in their new sheet, so restoring them keeps both. Auto-run doesn't run restored rows. A run active on the sheet refuses a restore. A batch over 20,000 rows answers `"state": "restoring"` and finishes in the background.
- **Finding rows:** `list_trash` with a batch's `trash_id` reads its rows (`seq`, `row_id`, `old_row_index`, `cells`); `column` and `contains` search them. Pass the `seq`s you want to `restore_from_trash` with that `trash_id`.
- **Restoring a sheet or table:** it comes back as it was, renamed "(restored)" if its name was taken meanwhile. A sheet whose table is in the trash waits for the table, and rows wait for their sheet.
- **Deleting from the trash** is only in the app.

`get_sheet_history` reads a sheet's change log (kept 90 days): what changed and who did it, the app or an access token by name. A line about rows still in the trash has `in_trash: true` and their `trash_id`.

## Undo a run

`undo_run` puts back what a run's cells held before it ran: an AI, HTTP API, enrichment or waterfall run, a first run or a rerun of every row that went wrong. Pass `run_type` and `run_id` (from `list_runs` or `get_sheet`'s column details), or `sheet_id` and `column` for that column's newest run that can still be undone.

- **What comes back:** every cell the run wrote, in all its columns (the result, an HTTP API column's mapped columns, a structured run's typed columns, `(Data)`, status, "Answered by" and step columns). Cells that were empty go empty again, and each row's `out_of_date` state goes back with it.
- **What stays:** a cell changed since the run wrote it, by a person, an agent or a newer run, is left as it is (`skipped`). Cells in rows or columns deleted since are counted as `gone`, also when the rows came back from the trash. Rows a list enrichment added to another sheet stay (`delete_rows` removes them), and so does a column added later from the run's stored answers (`add_enrichment_field`).
- **What it costs:** nothing. Nothing runs again and nothing is billed; what the run cost stays spent. A restored row's stored answer stops being that cell's answer: the cell's answer and sources show the run before it, a column added later from stored answers reads that one, and the undone answer is never reused, so running the column again calls (and bills) again, unless reuse finds an older run's answer. A skipped cell keeps its answer. Clean, formula and lookup columns that read a restored cell work it out again (they're free), and so do the ones reading those; no auto-run that costs or sends requests starts.
- **When:** once the run has stopped (cancel a paused one first), once per run, for 7 days after it started. Newest first: while a newer run that wrote one of its columns can still be undone, an older one is refused (undo the newer one first). While another run fills one of its columns, it waits. `dry_run: true` says whether it can be undone (`can_undo`, `reason`) and how many rows it wrote, and changes nothing.
- **The answer:** `state`, `restored`, `skipped`, `gone` and a `message`. An undo over 20,000 rows answers `"state": "undoing"` and goes on in the background (the sheet is busy meanwhile); `dry_run: true` shows how far it got. The sheet's history lists each undo.

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
- The estimate lists each step: AI steps priced on the sheet's rows, enrichments at treg's prices, HTTP API steps as one request a row, clean and formula steps free. A step reading what an earlier one writes is priced at the most it could take.
- A step whose columns the sheet has already, made the same way (the same kind of column making the same columns, reading the same ones and set up alike: the same prompt, request and fields, enrichment job, cleaner or formula, as when this setup made them), carries them on: it fills only the rows it hasn't done, with the column's own model, speed and "Only run if" rule. AI columns take their empty rows, HTTP API columns their empty, failed or unfinished rows, enrichments the rows not enriched yet; a row the rule kept out runs only if the rule passes on it now. Clean and formula columns follow their columns (or are filled again, free, when their auto-run is off). A step with nothing left to do is done at once, and one whose column has a run working waits for it; a paused run there stops the setup at that step until you resume or stop it. The estimate prices those rows, and `carries_on` lists the steps. That's how to fill new rows on a sheet, or finish a setup that failed or was stopped: call `apply_setup` again with the same `inputs` and `names` (`get_setup_run` with `sheet_id` and `setup_id` shows the `choices` its runs there used).
- Any other column the sheet has under a name the setup makes is refused (`taken`); give the step another name in `names`, keyed by the column the setup makes (an AI step by its `(Output)` or `(Status)` column). Renaming a step that would carry on makes it a new column instead. `models` picks a new AI step's model; by default it keeps the one it was saved with.
- `first_rows` tests it on the top rows (up to 1,000). After a run on every row, the auto-runs saved with the setup are turned on; a test doesn't turn them on.
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
4. `get_run_status` (run type `enrichment`) follows it: `cost_usd` is what its treg calls cost so far, and `enrichment.pause_reason` says why it paused (its run limit, the daily limit, the treg balance, a missing key, treg unreachable). `control_run` resumes it once that's fixed, with `spend_limit_usd` to raise a run limit and `concurrency` to change how many rows run at once. `get_run_results` gives each row's cost and the provider that found it.

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
- A rerun replaces the rows each source row added before; a rerun that answers with no results removes them.
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

## Big CSV files

Everything an assistant sends or receives passes through its context, so a CSV pasted into chat is expensive: a 4 MB lead list is about a million tokens, and a file of a few hundred MB can't go through chat at all. For files, the assistant asks Cubex for a one-time link and moves the file with `curl`. Only a short summary goes through the chat.

- **Import.** Ask "Import ~/Downloads/leads.csv into a new table called Leads." The assistant calls `create_upload_link`, then runs `curl -sS -T leads.csv '<link>'`, which prints the result: rows imported and new columns. Files up to `MAX_CSV_UPLOAD_MB` (500 MB by default) work, the same as an upload in the app. The upload has to come from a file, not a pipe: Cubex uses the file's size to tell a finished upload from one that was cut off.
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

**Runs that stop themselves.** An AI or HTTP API run doesn't write an error into every row when its provider is down. After 5 rows in a row fail on the provider's or the account's side (no answer, a server error, a rate limit after its retries, a rejected key, no credits, a model that's gone), it pauses, and the rows not run yet stay waiting. `get_run_status` then shows `pause_reason: "provider_errors"` and a `pause_message` with the last error; `control_run` resume goes on once it's fixed. An HTTP API column's auto-run tries again by itself a few minutes later. Two more reasons work the same way: `storage` (results couldn't be saved, usually a full disk; a resume is refused until there's space) and `stalled` (its worker stopped several times). Every AI call ends within 10 minutes, its answer included; a row that takes longer fails as timed out.

## REST API

The same data is available as a plain HTTP API under `/api/v1`, with the same tokens and scopes. Send `Authorization: Bearer cubex_pat_...` and JSON bodies (`Content-Type: application/json`). `GET /api/v1/me` checks a token and lists its scopes and its spend cap (`token.spend`: `spend_cap_usd`, `spent_usd`, `left_usd`).

All paths below are relative to `/api/v1`.

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
| `POST /sheets/:id/clean-columns` | `{"source_column": "Name", "cleaner": "first_name"}`, plus optional `column`, `phone_format`, `phone_country`, `auto_run` and `preview`. Same as `clean_column` (see [Clean data](#clean-data)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `PATCH /sheets/:id/columns/:name` | `{"name": "New name"}` to rename (URL-encode the old name), `{"description": "…"}` to describe (`""` removes it), or both: the description is checked first, so a bad one changes nothing. |
| `DELETE /sheets/:id/columns/:name` | |
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
| `POST /sheets/:id/setups/:setupId/apply` | `{"inputs": {"Website": "Company URL"}, "names": {}, "models": {}, "first_rows": 10, "estimate_only": true}`. Same as `apply_setup`, but `estimate_only` defaults to `false` here. `200` with the estimate, `201` with the `setup_run`; a missing input or a name taken answers `missing` or `taken`. `run` scope (and `secrets` for saved keys). |
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
| `POST /sheets/:id/rows/query` | `{"where": [{"operator": "has_error"}], "columns": ["Email"], "limit": 100, "cursor": 0, "return_mode": "rows", "include_status": true}`. `where` is the same as in MCP (see [Finding rows](#finding-rows)): text, number and list operators, OR groups, and run states. Values are strings. `return_mode` is `rows`, `ids` or `count`; `include_status` works with `rows`. `columns` can take a value out of a JSON cell ([Values inside JSON cells](#values-inside-json-cells)), and `group_by` with `aggregates` answers groups instead of rows ([Counting and summing](#counting-and-summing)). `view` reads through a saved view (see [Saved views](#saved-views)). To page a filtered query, send back `expected_data_version` and `expected_row_generation` from the previous page; you get a 409 if the sheet changed in between. |
| `POST /sheets/:id/rows` | `{"rows": [{"data": {"Email": "a@b.com"}}]}`, up to 1,000 rows. Note the `data` wrapper (MCP's `append_rows` takes the objects directly). |
| `PATCH /rows/:rowId` | `{"data": {"Status": "Done", "Notes": null}}`. `null` clears a cell. |
| `POST /sheets/:id/rows/update` | `{"updates": [{"row_id": "...", "data": {"Status": "Done"}}]}`, up to 1,000. |
| `POST /sheets/:id/rows/delete` | `{"row_ids": ["..."]}`, up to 1,000. They go to the trash: the answer's `trash` gives the `trash_id`. |
| `POST /sheets/:id/import` | Multipart form: the CSV in a field named `file`, plus `replace=true` to replace the rows instead of appending (the replaced rows go to the trash). |
| `GET /sheets/:id/export` | The whole sheet as CSV, streamed (any size). `?view=<name or id>` exports a saved view: its rows and visible columns. |
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
- Search fees are usually most of a web run's cost, so you can choose how searches run (each needs `web_search: true`):
  - `search_engine`: `auto` (the default: the model's own search if it has one, otherwise Exa), `native` (the model's own search, billed by its provider at its list price: about $0.01 a search on OpenAI and Anthropic, $0.025 on GPT-4.1, $0.014 on Google, $0.005 on xAI), `exa` ($0.007 a search), `parallel` ($0.005, or $0.001 in `turbo` or `fast` mode) or `perplexity` ($0.005). Prices as of October 2026; the estimate shows the live price of what will run.
  - `search_mode` (with `search_engine` `exa` or `parallel` only; deeper modes search more thoroughly, take longer and cost more): for `exa`, `instant`, `fast` or `auto` (default) at $0.007, `deep-lite` or `deep` at $0.012, `deep-reasoning` at $0.015; for `parallel`, `turbo` (English and Japanese only) or `fast` at $0.001, `basic` (default) or `advanced` at $0.005.
  - `max_searches_per_row`: a hard limit from 1 to 10. Exa, Parallel and Perplexity enforce it, and so does Anthropic models' own search; a row that reaches it is made to answer. OpenAI's, Google's and xAI's own search can't be limited: with `auto`, Cubex then uses Exa and says so (`switched: true`); with `native`, the run is refused.
- The estimate names the engine the run will really use and prices that one. Its `web_search` block has `engine` (what the run sends to OpenRouter), `runs_on` (what runs the searches), `mode` (the one billed: the engine's default when you chose none), `price_per_search_usd`, `switched`, the searches it expects per row, and what your past runs with the same settings really cost per row.
- Every row records what it searched for and what it cost. `GET /ai-runs/:id/results` (MCP `get_run_results`) returns `cost_usd`, `searches` (how many ran) and `search_queries` (`[{query, ran}]`, where `ran: false` is a search the limit stopped) for each row, and the run's status adds up `cost_usd` and `searches`. The `(Data)` cell shows the same, cost first: `📊 $0.0018 · 1 search: "stripe ceo" · 5 sources: …`. With a model's own search (`runs_on: native`), the searches and their words show up only when the provider reports them; the cost is always OpenRouter's own figure.
- `run_if`: run only the rows that pass a rule. See [Only run if](#only-run-if).
- Boolean options also take the text `"true"` or `"false"`.
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

- `{{name}}` takes a column's value or a saved API key (saved keys need the `secrets` scope). A name that matches neither is refused before anything is sent. Once a column the request read is deleted, a saved key with its name never stands in for it: a rerun is refused until you edit the column or add the column back.
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

**Retrying safely:** send an `Idempotency-Key` header (or `idempotency_key` in the body). Repeating a start with the same key and arguments returns the original `run_id` instead of starting (and paying for) a second run.

| Endpoint | Body or query |
|---|---|
| `POST /sheets/:id/run-conditions/check` | `{"rule": "{{Tier}} is \"A\""}`: how many rows pass, and the first rows with their verdict. `read` scope. |
| `POST /sheets/:id/run-conditions/generate` | `{"text": "tier A companies", "model": "..."}`: writes a rule with one AI call (`model` optional). `run` scope. |
| `GET /runs` | Recent runs, newest first. `?sheet_id=...&filter=active` (`active`, `terminal` or `all`) `&limit=20` (up to 50). |
| `GET /ai-runs/:id` · `GET /http-runs/:id` | Status and progress. `completed` means every row was processed, not that every row worked: check `failed_rows`. A structured AI run also lists its `output_columns`, and a run with web search or fetch names its `data_column` (the sources). An AI run reports what its rows cost so far (`cost_usd`) and, with web search, the searches that ran (`searches`) and its `web_search` settings. |
| `GET /ai-runs/:id/results` (same for `http-runs`) | Per-row results and errors. `?status=failed` (`failed`, `completed` or `all`, default `all`), paged with `limit` and `cursor` like rows. AI rows also carry `cost_usd`, and with web search `searches` and `search_queries`. |
| `POST /ai-runs/:id/pause`, `/resume`, `/cancel` (same for `http-runs`) | |
| `GET /ai-runs/:id/undo` · `POST /ai-runs/:id/undo` (same for `http-runs`) | GET says whether the run can be undone (`can_undo`, `reason`), how many rows it wrote, and an undo's `state`, `restored`, `skipped` and `gone`; `read` scope. POST undoes it: `200` once done, `202` while a big undo goes on in the background (GET it for the counts). Nothing runs again or is billed. `write` scope. See [Undo a run](#undo-a-run). |
| `GET /sheets/:id/undo?column=...` | The column's newest run that can still be undone, as `GET /ai-runs/:id/undo` (or `http-runs`) answers it, or `null`. `read` scope. |
| `POST /sheets/:id/runs/stop` | Stops every AI, HTTP and enrichment run on the sheet and every setup being used on it, at once (MCP `control_run` with `cancel_all`). Returns `stopped_runs`, `stopped_setup_runs`, `auto_run_paused` (columns whose auto-run batch it stopped: paused until you resume them), `auto_run_on` (auto-runs still on, where new rows start runs), `still_filling` (free fills, which finish) and a `message`. Calls already sent finish and are billed. `run` scope. |
| `POST /ai-runs/:id/rerun` | `{"mode": "errored"}`, `{"row_ids": [...]}` or `{"first_rows": 10}`. One of them is required. Modes: `errored` (failed rows), `empty`, `missing` (empty, failed or unfinished), `out_of_date` (results whose input cells changed since), `empty_or_out_of_date`, `all`. Starts a new run, which costs credits again. Add `"concurrency"` (1 to 100) to change how many rows run at once; rows that failed on OpenRouter's in-flight credit budget need a lower one. `first_rows` reruns only among the sheet's first rows (up to 1,000, not with `row_ids`): all of them, or those `mode` picks. A structured (`output_columns`) run refills all its columns on those rows; its modes read the `(Status)` column. |
| `POST /http-runs/:id/rerun` | `{"mode": "missing"}` or `{"row_ids": [...]}`. Modes are the AI rerun's (`errored`, `empty`, `missing`, `out_of_date`, `empty_or_out_of_date`, `all`). Without either, every row runs again. `"first_rows": 10` takes only the sheet's first rows (not with `row_ids`, and not on an enrichment or waterfall run). An enrichment or waterfall run needs `row_ids` or `mode`: `errored`, `empty` (not run yet), `missing` (no result), `out_of_date`, `empty_or_out_of_date` or `all`, and takes `spend_limit_usd`; an enrichment run also takes `concurrency` (rows at once, 1 to 100; default: the run's own). Only a waterfall column's newest run can be rerun, with the column's setup. |
| `POST /http-runs/:id/resume` | An enrichment or waterfall run takes `{"spend_limit_usd": 40}` to raise the limit that paused it. An enrichment run also takes `concurrency` (rows at once, 1 to 100) to change its speed. |

Both reruns also take `webhook_id`, a [run webhook](run-webhooks.md) to tell when the new run finishes.

An enrichment is an HTTP run: `GET /http-runs/:id` adds `cost_usd`, `daily_limit` and `enrichment` (the tool, its limits, `pause_reason`, and a list job's progress), and `GET /http-runs/:id/results` adds each row's `cost_usd` and `found_by` (and `reused_answer_from` on a row filled from an earlier found answer), plus its stored `answer` with `?answers=true` (10 rows a page).

A waterfall is an HTTP run too: `GET /http-runs/:id` adds `cost_usd` (treg and AI) and `waterfall` (`result_type`, `spent`, `run_limit_usd`, `pause_reason` and per step its counts and cost), and `GET /http-runs/:id/results` adds each row's `answered_by`, `cost_usd` and `trace`, as `get_run_status` and `get_run_results` do (see [Waterfalls](#waterfalls)).

### Run webhooks

URLs Cubex tells, with a signed POST, when a run finishes. Reading needs `read`; adding, changing, deleting, a new secret and a test need `run` (they decide where Cubex sends requests, as an HTTP API column does). See [Run webhooks](run-webhooks.md) for the notice and how to check its signature.

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

### Trash and history

| Endpoint | Body or query |
|---|---|
| `GET /trash` | Same as `list_trash` without an id: `?q=` (a table, sheet or token name), `kind` (`rows`, `sheet`, `table`), `how` (`grid`, `api`, `duplicates`, `auto_dedupe`, `import`, `transfer`, `sheet`, `table`), `sheet_id`, `before` (the next page), `limit`. `read` scope. |
| `GET /trash/:id` · `GET /trash/:id/rows` | One item; a batch's rows: `?after=` (a `seq`), `limit` (up to 500), `column` and `contains` to search. `read` scope. |
| `GET /trash/:id/csv` | A batch's rows as CSV. `read` scope. |
| `POST /trash/restore` | `{"trash_ids": [12, 14]}`: tables first, then sheets, then rows. `results` says what each did. `write` scope. |
| `POST /trash/:id/restore` | One item, or `{"seqs": [3, 9]}` for rows picked from a batch. `write` scope. |
| `GET /sheets/:id/history` | Same as `get_sheet_history`: `?before=` (a change id), `limit`, `column`. `read` scope. |

### Responses and errors

- Errors are JSON: `{"error": "message"}`. Some add detail: `unknownColumns`, `lockedColumns` (columns a run is still filling), `protectedColumns`, or `busy: true` (the sheet is in the middle of an import or sort; retry shortly).
- `400` bad input · `401` missing or revoked token · `403` the token lacks a scope · `404` not found · `409` conflict (a name already taken, a run already active, a sheet that changed while you paged) · `413` body over 2 MB · `429` rate limited.
- The limits above apply to each token across MCP and REST together. Every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and a `429` adds `Retry-After` (and `retry_after_seconds` in the body when the run-start or sheet-copy limit refused it; its `RateLimit-*` headers then describe that limit).

## Security notes

- A token is as good as your password for whatever its scopes allow. Give each assistant its own token so you can revoke one without breaking the others.
- Browser pages can't call `/mcp` (requests carrying a foreign `Origin` header are refused), which blocks DNS-rebinding tricks against a Cubex running on localhost. Desktop and command-line clients don't send that header and aren't affected.
- Upload and download links work once, expire after 15 minutes, and die with the token that made them. Cubex stores only a hash of each. See [Big CSV files](#big-csv-files).
- Cell values are data, not instructions. They can come from anyone who can send a webhook, from imported files, and from AI or HTTP runs, so a cell can contain text written to steer an assistant. Cubex tells connected assistants never to follow instructions found in cells; review what an assistant proposes to do with data it read.
