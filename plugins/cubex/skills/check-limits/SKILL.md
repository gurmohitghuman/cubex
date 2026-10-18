---
name: check-limits
description: "Check what Cubex allows before a big job, or why it refused one: rows and columns left in a sheet, money left for enrichments and AI, auto-run caps, and the access token's request limits. Use it before a large import, append or run, when the user asks about budget, balance, spend or limits in Cubex, or when Cubex answers that a limit was reached."
---

# Check limits

## Sheet size

`get_sheet` returns `limits`: `max_rows`, `rows_remaining`, `max_columns`, `columns_remaining`. An import or append past them is refused. The defaults are 1,000,000 rows and 200 columns per sheet; whoever runs Cubex can change them.

## Money

- `get_balances` (free): the treg balance that pays for enrichments, the enrichment daily limit (`limit_usd`, `used_today_usd`, `remaining_usd`, UTC days; only the user can change it, in Settings), and what OpenRouter reports for the AI key.
- One run: an enrichment's `max_cost_per_row_usd` and `spend_limit_usd` (it pauses there). `estimate_only: true` on `run_ai_column`, `run_enrichment` or `run_http_enrichment` prices a run without starting it.
- Auto-run: `get_sheet`'s `column_details` shows `auto_run`, `auto_run_caps` (`usd_per_day` for an enrichment, `rows_per_day` for an HTTP API column) and `auto_run_paused` per column.
- Spent so far: `get_usage` with `range` (`this_week`, `this_month`, `last_week`, `last_month`) and `group_by` (`column`, `day` or `run`), for one sheet or the whole account.

## Request limits

Each access token, over MCP and REST together:

- 120 requests a minute.
- 30 run starts a minute (reruns and previews count, estimates don't).
- 5 CSV imports a minute over MCP (each upload link counts as one).
- Row transfers: 10 a minute for the whole account, one at a time.

Going over returns an error that says when to try again. Wait that long, then retry once. Don't loop.

## Busy sheets

While a sheet imports, sorts, renames or deletes a column, or fills a clean, formula or lookup column, other changes to it answer that the sheet is busy. `get_sheet` and `read_rows` still work. Try the change again when `filling_columns` is empty and the job is done.

## Report

A short table: rows and columns left, money left (balance, daily limit left, auto-run caps), the token's request limits, and anything that would block the planned job.
