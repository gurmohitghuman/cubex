---
name: enrich-with-cost-control
description: "Enrich rows in Cubex without overspending: AI columns, HTTP API columns, and paid enrichments such as work emails, phone numbers and company data. Use it whenever the user wants to add data to a Cubex sheet that costs money or calls an outside service: it picks the cheapest tool, estimates first, tests on a few rows and stays inside the limits."
---

# Enrich with cost control

Runs cost money. An AI column calls the model once per row (plus search fees with web search), an enrichment buys data per row, an HTTP API column calls the user's own API once per row. Never start a full run before the user has seen the cost and said yes.

## 1. Pick the cheapest tool that works

- Free first: `clean_column`, `formula_column`, `lookup_column` (values from another sheet) and `remove_duplicates` cost nothing. Don't pay AI for what they do.
- Remove duplicate rows before paying for the same row twice.
- Keep rows out with `run_if`, a rule such as `{{Website}} is not empty AND {{Country}} is "US"`: rows that fail it cost nothing. `check_run_condition` (free) says how many rows pass and shows a few.

## 2. Check the budget

`get_balances` (free): the treg balance that pays for enrichments, the enrichment `daily_limit` (`limit_usd`, `used_today_usd`, `remaining_usd`, UTC days) and what OpenRouter reports for the AI key. Only the user can change the daily limit, in Settings.

## 3. Estimate

- **AI**: `run_ai_column` with `estimate_only: true` gives `rows_to_process` and `estimated_cost_usd` (low and high), web fees included. Then `preview_rows: 5` runs 5 real rows and returns their outputs and the measured cost, creating nothing.
- **Enrichment**: `search_enrichments`, then `get_enrichment` for the tool's inputs, outputs, providers and price, then `run_enrichment` with `estimate_only: true`: the rows it would take, the cost range, the per-row cap and run limit it would use, and `daily_limit`.
- **HTTP API**: `run_http_enrichment` with `estimate_only: true` checks the request and the rows without sending anything. It costs whatever the user's API charges. API keys never go through the chat. The user saves a key in Cubex (Settings, Enrichment, saved API keys) and a request names it as `{{key_name}}`, for example `Authorization: Bearer {{people_api_key}}`. Using a saved key needs a token with the `secrets` scope. Never ask the user to paste a key, and never put one in a request, a prompt or a file.

Tell the user: how many rows, the cost range, what it buys, and how much of the daily limit is left.

## 4. Test, then run

- Enrichment: `test: true` runs the first 5 rows. Show them with `get_run_results` before going on. For the rest, `control_run` with `action: "rerun"` and `mode: "empty"` runs the rows not enriched yet.
- Set limits on a full enrichment: `max_cost_per_row_usd` (each row's cap) and `spend_limit_usd` (the run pauses there).
- Keep `concurrency` modest; lower it if the provider answers 429.
- Follow with `get_run_status` (`wait_seconds` up to 25). Report `cost_usd` and failed rows. A paused enrichment says why in `enrichment.pause_reason`; resume with `control_run` and raise `spend_limit_usd` only when the user agrees.

## 5. Auto-run

Auto-run (`set_auto_run`, or `auto_run` on `run_enrichment`) fills new rows on its own and spends without asking. Turn it on only when the user asks for it, with a daily cap (`daily_cap_usd`). A sheet with a webhook gets rows from outside, so each one can cost money.

## After

`get_usage` shows what runs cost, by column, day or run (`range: "this_week"`, `"this_month"`, ...). Offer `set_description` on the new columns, saying what filled them.
