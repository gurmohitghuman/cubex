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
| `run` | Also start, pause, resume, stop and re-run AI, HTTP and enrichment runs, and turn auto-run on or off. These spend your OpenRouter credits and your treg balance, and call your APIs. |
| `secrets` | Also start HTTP runs that use your saved API keys, and save the keys in a pasted cURL command as new saved keys. Needs `run`. |

`write` and `run` each include `read`. `run` doesn't include `write`, but starting a run does create its output columns. You can have 10 active tokens and revoke any of them at any time. A token can't create other tokens or change your password, and it can never read or change a saved key. With `secrets` it can add a new one, from a cURL command it passes to an HTTP run.

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
- "Add the people at each company in Accounts to a new sheet called People, 10 per company. Try 5 companies first and show me which fields come back."
- "In Leads, split Name into first and last name, turn Website into a domain and fix the phone numbers. Use the free cleaners."
- "In Leads, the Response column holds each API reply. Add a Work email column with the email whose type is work, using a formula."
- "Keep finding work emails for new rows in Leads automatically, up to $5 a day."
- "In Leads, score each company's fit with AI. Then find work emails only where the score is 8 or more, and add those people to Smartlead only where the email is valid."

## Tools

| Tool | What it does |
|---|---|
| `list_tables` | Tables and their sheets. Start here to turn names into ids. |
| `get_sheet` | A sheet's columns, row count, and how many rows and columns are left. Lists its clean and formula columns too. |
| `read_rows` | Rows, paged, with column selection and filters: text, numbers, lists, OR groups, and run states such as failed or not run yet. `include_status` returns run columns as `{status, value, error}`. See [Finding rows](#finding-rows). |
| `export_csv` | A sheet (or a filtered part of it) as CSV, up to 40,000 characters. Past that it says how many rows matched; the rest comes from `read_rows`, or save the whole sheet with `create_download_link`. |
| `append_rows`, `update_cells`, `delete_rows` | Add, edit and delete rows by their stable row id. |
| `add_column`, `rename_column`, `delete_column` | Manage columns. |
| `sort_sheet` | Permanently reorders the rows by a column. |
| `manage_table`, `manage_sheet` | Create, rename, delete and reorder tables and sheet tabs. |
| `import_csv` | Load CSV text into a sheet (append or replace). For a file, use `create_upload_link`. |
| `create_upload_link`, `create_download_link` | One-time links to move a CSV file of any size into or out of a sheet with `curl`. See [Big CSV files](#big-csv-files). |
| `run_ai_column` | Start an AI column run. Can estimate the cost first, preview a few rows, target specific rows, or fill several typed columns at once. |
| `run_http_enrichment` | Start an HTTP API column run, from a URL or a whole cURL command. |
| `check_run_condition`, `write_run_condition` | Check an "Only run if" rule on a sheet (free), or write one from plain words with your default AI model. See [Only run if](#only-run-if). |
| `get_run_status`, `list_runs` | Follow a run, or find recent ones. |
| `get_run_results` | Per-row results and errors, to see why cells are blank or wrong. |
| `control_run` | Pause, resume, cancel, or re-run (failed rows, empty rows, all, or only the sheet's first rows with `first_rows`). `cancel_all` with a `sheet_id` stops every run and setup on that sheet at once. |
| `list_models`, `set_default_model` | Find OpenRouter models and set the default. |
| `get_balances` | What the account can spend: the treg balance, the enrichment daily limit, and what OpenRouter reports for the saved key (its account balance only reaches a management key, so often just the key's own limit). Costs nothing. |
| `clean_column` | Free cleaning into a new column: names, first and last names, company names, emails, domains, phone numbers, Title Case, lowercase and spaces. No AI and no credits. See [Clean data](#clean-data). |
| `formula_column`, `write_formula` | A new column worked out for free from each row by a JavaScript formula, like picking an item out of an API response by a condition. `write_formula` writes the formula from plain words with your default AI model. See [Formulas](#formulas). |
| `remove_duplicates` | Find rows that match on one or more columns (as text, email, domain, phone, company or person name) and remove all but one of each, for free. A dry run unless `dry_run: false`. See [Remove duplicates](#remove-duplicates). |
| `list_setups`, `save_setup`, `delete_setup` | Save a sheet's filled columns, and every filled column they read, as a named setup; list and delete the saved ones. See [Setups](#setups). |
| `apply_setup`, `get_setup_run`, `control_setup_run` | Build a saved setup's columns on another sheet and fill them in order (an estimate unless `estimate_only: false`), follow it, and pause, resume or stop it. See [Setups](#setups). |
| `transform_column` | Free, instant text transforms (upper/lower case, trim, number, regex extract, split, template) with no model call. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |
| `transfer_rows` | Copy or move rows between sheets on the server. Needs `MCP_EFFICIENT_ROWS_ENABLED=1`. |
| `search_enrichments`, `get_enrichment` | Find a treg.to enrichment tool, then read its inputs, outputs, price and providers. See [Enrichments](#enrichments). |
| `run_enrichment` | Run an enrichment per row: work emails, phones, person or company data, or lists that become rows in another sheet. Can estimate first, test on 5 rows, and turn on auto-run. |
| `get_list_fields`, `add_list_rows` | For a job that adds rows: read the fields its results really have, then pick the ones to keep and add the rows. |
| `add_enrichment_field` | A new column filled from answers a run already stored, for free. |
| `set_auto_run` | Turn auto-run on or off for an enrichment, HTTP API, clean or formula column, or pause and resume it. |

Deletes are permanent; there's no undo. Every tool tells your client whether it only reads, adds, or changes and deletes data, so clients can ask you before the risky ones.

When auto-run is on in a sheet, `append_rows`, `import_csv` and `transfer_rows` (and the REST appends and imports) answer with `auto_run`: the columns that will fill the new rows on their own, each with its estimated cost (`estimated_usd`) or, for an HTTP API column, `sends_requests: true`.

Starting a run on a very large sheet answers at once: the run shows as pending while Cubex marks its rows, then starts. Cancelling also answers at once; leftover cells clear in the background.

## Finding rows

`read_rows`, `export_csv`, `create_download_link`, `transfer_rows` and `transform_column` take `where`: a list of conditions a row must all pass. An item can also be an OR group, `{"or": [...]}`, which passes when any of its conditions does.

```json
[
  {"column": "Industry", "operator": "any_of", "values": ["SaaS", "Fintech"]},
  {"or": [{"column": "Email", "operator": "empty"}, {"column": "Phone", "operator": "empty"}]}
]
```

- **Text:** `eq`, `neq`, `contains`, `not_contains`, `empty` and `not_empty`. `any_of` and `not_any_of` take `values`, a list. They ignore case and spaces at either end.
- **Numbers:** `gt`, `gte`, `lt` and `lte`. The cell has to hold a number (`1,000` counts, `1,5` doesn't); other cells never pass.
- **Run state**, on AI, HTTP API and enrichment columns: `has_error`, `has_result`, `not_run`, `condition_not_met` and `running`. They read the words runs write into cells (`❌`, `⏭️ Condition not met`, `⏳`, `➕`), so you don't have to. Leave `column` out to match any run column: `[{"operator": "has_error"}]` finds every row where a run failed. An output column reads the state from its run's status column, so `has_error` on Email finds the rows where the enrichment that fills Email failed.

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

Other columns come back as text, the same as without it.

In the app, each column's menu has the same filters, one per column: text, number and list conditions on any column, and on a run column **Rows with errors** plus the other run states.

## Only run if

`run_ai_column`, `run_http_enrichment`, `run_enrichment` and `set_auto_run` take `run_if`, a rule a row must pass to run:

```
({{Industry}} is "SaaS" OR {{Industry}} is "Fintech") AND {{Employees}} > 50
```

Checks are `is`, `is not`, `contains`, `does not contain`, `is empty`, `is not empty`, `>`, `<`, `>=` and `<=`, joined with `AND`, `OR`, `NOT` and brackets. Rows that fail it aren't sent anywhere, cost nothing, and show `⏭️ Condition not met` (a cell that already holds a result keeps it). Cells holding Cubex's own words (`⏳`, `❌`, `⏭️`, `➕`) count as empty, so a chain works: give each column a rule on the one before it, once that run has finished.

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
- A dry run needs the `read` scope; `dry_run: false` needs `write`. Removed rows are deleted for good, with their AI and HTTP results. The whole sheet is checked; filters don't apply.
- Refused while a run is active on the sheet: stop or finish it first. Rows appended while a removal works are left alone.

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
- `list_setups` lists them; pass `setup_id` for one in full. `delete_setup` deletes one for good; sheets it was used on keep their columns. A setup is a copy, never a link.
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

**Status cells are Cubex's words, not data.** The status column says per row: `✅ Found` (the outputs are filled), `⏭️ Not found`, `⏭️ Budget ran out` (the per-row cap stopped the waterfall before a provider found it), other `⏭️ …` skips with their reason, `❌ …` failures with their reason, and `⏳ Processing...` while it runs. Verified work email writes `✅ Valid`, `✅ Catch-all` or `✅ Risky`; on a row it rejected (`⏭️ Only a catch-all address (not accepted)` and the like) it still fills Email status and Checked by, never Email. Jobs that add rows write `➕ Adding N rows…`, `➕ N results, waiting for fields`, `➕ N rows waiting for room in <sheet>`, `✅ N rows added` (with `, M already there` when duplicates were skipped), `✅ Already there` and `❌ Rows not added: <reason>`. Output columns are empty on rows that found nothing, and so is a column added from stored answers where an answer had no value (an HTTP API column's says `⏭️ No data`). An empty status means the row hasn't run; rows missing an input are skipped and stay empty.

**Jobs that add rows** (`adds_rows: true`): treg returns each provider's own fields, so a list job asks one provider and you keep the fields its real results have.

1. `run_enrichment` with `test: true` and `list: {new_sheet_name or destination_sheet_id, provider, results_per_row, copy_columns}` runs 5 rows; their results wait for fields.
2. `get_run_status` shows them in `enrichment.list.waiting_for_fields`; `get_list_fields` lists the fields (path, label, how many results have it, a sample).
3. `add_list_rows` picks the fields (and `dedupe_path` to skip results added before) and adds those rows, for free.
4. `control_run` rerun with mode `empty` runs the rest of the rows with the same fields.

`results_per_row` is the price dial: providers that charge per result charge for each. Deleting a sheet whose results aren't rows yet drops them: `manage_sheet` and `manage_table` deletes (and the REST deletes) say how many in `list_results_dropped`.

**Auto-run** (`set_auto_run`, or `auto_run` on `run_enrichment`) keeps an enrichment or HTTP API column filling new rows, and rows whose inputs get filled, at most once a row. Rows already in the sheet when you turn it on are left alone. An enrichment auto-run has a daily cap (default $5, never above the daily limit); an HTTP API auto-run has a daily row cap (default 500) and **sends real requests**, for example adding leads to a sequencer. With a webhook on the sheet, anyone with its URL can add rows that spend.

**More from stored answers.** `get_run_results` with `include_answers: true` shows each row's stored answer (10 rows a page, rows that answered unless you pass `status_filter`; `answer_cut` lists parts left out of a very big answer; a run that used saved API keys needs the `secrets` scope). `add_enrichment_field` turns any value in it (a JSONPath such as `$.output.company.linkedin_url`) into a new column, filled from the answers already stored with no new calls. It fills in the background: `get_sheet` lists it in `filling_columns`, and reads show its cells as `⏳ Processing...` until it's done. Cubex removes the provider's raw data (`raw`) from a row's older answers when the row is enriched again, and from answers of runs that ended over 90 days ago when you prune them in Settings; the result fields stay. A value that was only in removed raw data can't become a column, and `add_enrichment_field` says so.

## Big CSV files

Everything an assistant sends or receives passes through its context, so a CSV pasted into chat is expensive: a 4 MB lead list is about a million tokens, and a file of a few hundred MB can't go through chat at all. For files, the assistant asks Cubex for a one-time link and moves the file with `curl`. Only a short summary goes through the chat.

- **Import.** Ask "Import ~/Downloads/leads.csv into a new table called Leads." The assistant calls `create_upload_link`, then runs `curl -sS -T leads.csv '<link>'`, which prints the result: rows imported and new columns. Files up to `MAX_CSV_UPLOAD_MB` (500 MB by default) work, the same as an upload in the app. The upload has to come from a file, not a pipe: Cubex uses the file's size to tell a finished upload from one that was cut off.
- **Export.** Ask "Save the Qualified rows of Leads to qualified.csv." The assistant calls `create_download_link`, then runs `curl -sS -f -o qualified.csv '<link>'`. It can also give you the link to open in your browser.

This works from any computer that can reach Cubex, as long as the assistant can run commands (Claude Code, Codex). With other assistants, such as claude.ai or Claude Desktop, ask for a download link and open it yourself; to import, open the sheet in Cubex and click **Import**.

What keeps the links safe:

- A link works once and stops working after 15 minutes, or as soon as the token that made it is revoked.
- It does one thing for one sheet, and only what its token could already do. An upload link needs a token with `write`; any token can make a download link. A token without `write` is told so, and what to do instead.
- Until it's used, anyone who has the link can use it, so treat it like a password. Cubex stores only a hash of it.
- Don't paste a download link into an app that previews links, such as Slack, Discord or iMessage: the preview would download the file and use the link up.

A million rows take about half a minute to import. If `curl` stops waiting, the import still finishes, so check the sheet before trying again. Links point at the address the assistant reached Cubex on, or at `PUBLIC_URL` when you set it. Behind Cloudflare's proxy, the free plan refuses uploads over 100 MB.

## Limits

Agents can get stuck in loops, so each token has its own budget:

- 120 requests a minute.
- 30 run starts a minute (reruns and previews count; estimates don't).
- Through MCP: 5 CSV imports a minute. Each upload link counts as one.

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
| `GET /sheets/:id` | Columns, row count, `data_version`, `row_generation`, its clean columns, and what's running on it now: `active_runs` (AI, HTTP and enrichment runs) and `active_setup_runs`. |
| `POST /sheets/:id/columns` | `{"name": "Status"}` |
| `POST /sheets/:id/formula-columns` | `{"column": "Work email", "formula": "{{Response}}?.emails?.find(e => e.type == \"work\")?.value"}`, plus optional `description`, `auto_run` and `preview`. Same as `formula_column` (see [Formulas](#formulas)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `POST /sheets/:id/formula-columns/write` | `{"words": "the work email from Response"}`, plus optional `model`. Same as `write_formula`. `run` scope. |
| `POST /sheets/:id/remove-duplicates` | `{"columns": ["Email"], "keep": "first", "dry_run": false}`. Same as `remove_duplicates` (see [Remove duplicates](#remove-duplicates)): a dry run unless `dry_run` is `false`. `read` scope for a dry run, `write` to remove. |
| `POST /sheets/:id/clean-columns` | `{"source_column": "Name", "cleaner": "first_name"}`, plus optional `column`, `phone_format`, `phone_country`, `auto_run` and `preview`. Same as `clean_column` (see [Clean data](#clean-data)). `201` for a new column, `200` for a changed one or a preview. `write` scope. |
| `PATCH /sheets/:id/columns/:name` | `{"name": "New name"}` (URL-encode the old name) |
| `DELETE /sheets/:id/columns/:name` | |
| `PUT /sheets/:id/columns/order` | `{"order": ["Email", "Company", "Status"]}` (every column, once) |
| `POST /sheets/:id/sort` | `{"column": "Score", "direction": "desc"}`. Permanently reorders the rows. |

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

### Rows

Rows are addressed by their stable `id`, which survives sorts and imports.

| Endpoint | Body or query |
|---|---|
| `GET /sheets/:id/rows` | `?limit=100&cursor=...`. Returns `{rows: [{id, index, data}], next_cursor}`. `limit` is 1 to 500 (default 100). Pass `next_cursor` back as `cursor` until it's `null`. Add `&include_status=true` for run columns as `{status, value, error}`. |
| `POST /sheets/:id/rows/query` | `{"where": [{"operator": "has_error"}], "columns": ["Email"], "limit": 100, "cursor": 0, "return_mode": "rows", "include_status": true}`. `where` is the same as in MCP (see [Finding rows](#finding-rows)): text, number and list operators, OR groups, and run states. Values are strings. `return_mode` is `rows`, `ids` or `count`; `include_status` works with `rows`. To page a filtered query, send back `expected_data_version` and `expected_row_generation` from the previous page; you get a 409 if the sheet changed in between. |
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

**Retrying safely:** send an `Idempotency-Key` header (or `idempotency_key` in the body). Repeating a start with the same key and arguments returns the original `run_id` instead of starting (and paying for) a second run.

| Endpoint | Body or query |
|---|---|
| `POST /sheets/:id/run-conditions/check` | `{"rule": "{{Tier}} is \"A\""}`: how many rows pass, and the first rows with their verdict. `read` scope. |
| `POST /sheets/:id/run-conditions/generate` | `{"text": "tier A companies", "model": "..."}`: writes a rule with one AI call (`model` optional). `run` scope. |
| `GET /runs` | Recent runs, newest first. `?sheet_id=...&filter=active` (`active`, `terminal` or `all`) `&limit=20` (up to 50). |
| `GET /ai-runs/:id` · `GET /http-runs/:id` | Status and progress. `completed` means every row was processed, not that every row worked: check `failed_rows`. A structured AI run also lists its `output_columns`, and a run with web search or fetch names its `data_column` (the sources). An AI run reports what its rows cost so far (`cost_usd`) and, with web search, the searches that ran (`searches`) and its `web_search` settings. |
| `GET /ai-runs/:id/results` (same for `http-runs`) | Per-row results and errors. `?status=failed` (`failed`, `completed` or `all`, default `all`), paged with `limit` and `cursor` like rows. AI rows also carry `cost_usd`, and with web search `searches` and `search_queries`. |
| `POST /ai-runs/:id/pause`, `/resume`, `/cancel` (same for `http-runs`) | |
| `POST /sheets/:id/runs/stop` | Stops every AI, HTTP and enrichment run on the sheet and every setup being used on it, at once (MCP `control_run` with `cancel_all`). Returns `stopped_runs`, `stopped_setup_runs`, `auto_run_paused` (columns whose auto-run batch it stopped: paused until you resume them), `auto_run_on` (auto-runs still on, where new rows start runs), `still_filling` (free fills, which finish) and a `message`. Calls already sent finish and are billed. `run` scope. |
| `POST /ai-runs/:id/rerun` | `{"mode": "errored"}`, `{"row_ids": [...]}` or `{"first_rows": 10}`. One of them is required. Modes: `errored` (failed rows), `empty`, `missing` (empty, failed or unfinished), `all`. Starts a new run, which costs credits again. Add `"concurrency"` (1 to 100) to change how many rows run at once; rows that failed on OpenRouter's in-flight credit budget need a lower one. `first_rows` reruns only among the sheet's first rows (up to 1,000, not with `row_ids`): all of them, or those `mode` picks. A structured (`output_columns`) run refills all its columns on those rows; its modes read the `(Status)` column. |
| `POST /http-runs/:id/rerun` | `{"mode": "missing"}` or `{"row_ids": [...]}`. Without either, every row runs again. `"first_rows": 10` takes only the sheet's first rows (not with `row_ids`, and not on an enrichment run). An enrichment run needs `row_ids` or `mode`: `errored`, `empty` (not enriched yet), `missing` (no result) or `all`, and takes `spend_limit_usd` and `concurrency` (rows at once, 1 to 100; default: the run's own). |
| `POST /http-runs/:id/resume` | An enrichment run takes `{"spend_limit_usd": 40}` to raise the limit that paused it, and `concurrency` (rows at once, 1 to 100) to change its speed. |

An enrichment is an HTTP run: `GET /http-runs/:id` adds `cost_usd`, `daily_limit` and `enrichment` (the tool, its limits, `pause_reason`, and a list job's progress), and `GET /http-runs/:id/results` adds each row's `cost_usd` and `found_by`, plus its stored `answer` with `?answers=true` (10 rows a page).

### Enrichments

| Endpoint | Body or query |
|---|---|
| `GET /balances` | Same as `get_balances`. |
| `GET /enrichments` | `?q=work email`. Without `q`, the popular jobs. |
| `GET /enrichments/:toolId` | A tool's inputs, outputs, price and providers. |
| `POST /sheets/:id/enrichment-runs` | `run_enrichment`'s arguments (above). `202` with the `run_id`, plus `chained_auto_run` when auto-runs in the sheet read what the run writes (they fill those rows after it; HTTP ones send real requests); an estimate or a replay answers `200`. |
| `GET /sheets/:id/enrichment-list-fields` | `?column=People`: the fields a list job's results have. |
| `POST /sheets/:id/enrichment-list-fields` | `{"column": "People", "fields": [{"path": "$.first_name", "column_name": "First name"}], "dedupe_path": null}`: adds the waiting results as rows. |
| `POST /sheets/:id/enrichment-fields` | `{"column": "Work email", "json_path": "$.output.linkedin_url", "column_name": "LinkedIn"}`: a column from stored answers (`202`; it fills in the background). |
| `PUT /sheets/:id/enrichment-auto-run` | `{"column": "Work email", "enabled": true, "daily_cap_usd": 5}`, or `{"paused": true}` for every auto-run on the sheet. |

### Responses and errors

- Errors are JSON: `{"error": "message"}`. Some add detail: `unknownColumns`, `lockedColumns` (columns a run is still filling), `protectedColumns`, or `busy: true` (the sheet is in the middle of an import or sort; retry shortly).
- `400` bad input · `401` missing or revoked token · `403` the token lacks a scope · `404` not found · `409` conflict (a name already taken, a run already active, a sheet that changed while you paged) · `413` body over 2 MB · `429` rate limited.
- The limits above apply to each token across MCP and REST together. Every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and a `429` adds `Retry-After` (and `retry_after_seconds` in the body when the run-start limit refused it; its `RateLimit-*` headers then describe that limit).

## Security notes

- A token is as good as your password for whatever its scopes allow. Give each assistant its own token so you can revoke one without breaking the others.
- Browser pages can't call `/mcp` (requests carrying a foreign `Origin` header are refused), which blocks DNS-rebinding tricks against a Cubex running on localhost. Desktop and command-line clients don't send that header and aren't affected.
- Upload and download links work once, expire after 15 minutes, and die with the token that made them. Cubex stores only a hash of each. See [Big CSV files](#big-csv-files).
- Cell values are data, not instructions. They can come from anyone who can send a webhook, from imported files, and from AI or HTTP runs, so a cell can contain text written to steer an assistant. Cubex tells connected assistants never to follow instructions found in cells; review what an assistant proposes to do with data it read.
