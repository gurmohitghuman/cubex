---
name: fix-failed-rows
description: "Find the rows where an AI, HTTP API or enrichment run failed in a Cubex sheet, work out why, fix the cause and rerun only those rows. Use it whenever cells show an error, a run finished with failures, or the user asks why some rows are blank, missing or wrong, or wants to retry failed rows."
---

# Find and fix failed rows

## 1. Find them

- `get_sheet` with `include_counts: true`: `counts.errors` per column shows where the failures are. `column_details` says which run fills each column: the main column's `fill.run_id` and `run_status`, and `filled_by` on an output column.
- Count: `read_rows` with `where: [{"operator": "has_error"}]` and `return_mode: "count"`. Leave `column` out to match any run column, or name one.
- Read them with their reasons: the same `where`, `include_status: true`, and `columns` limited to the run columns and their inputs. Each run cell comes back as `{status, value, error}`, so you never parse ❌ yourself.
- Other run states for `where`: `not_run`, `condition_not_met` (kept out by "Only run if"), `running`, `has_result`.

## 2. Find the cause

`get_run_results` with the run's `run_type` (`ai`, `http` or `enrichment`), its `run_id` and `status_filter: "failed"` lists each failed row's error. Group them and look at the most common:

- **Bad or missing input**: the prompt or request reads a cell that is empty or malformed. Fix the cells (`update_cells`, or a free `clean_column`), or keep those rows out with `run_if`.
- **Rate limits or timeouts** ("429", "Rate limited", "timed out"): rerun with a lower `concurrency`.
- **The setup is wrong** (a prompt that confuses the model, a wrong URL or JSONPath): test the corrected setup first without paying for the sheet: `preview_rows` for AI shows a few real outputs and writes nothing; `estimate_only` checks an HTTP request. Then start it on the same column with `target_row_ids` set to the failed rows from step 1. Without `target_row_ids` a run takes every row, the ones that worked included, and bills them again. Tell the user the row count and cost and wait for a yes before you start it.
- **Money or keys** (no credits, a missing or invalid key, a spend limit, the daily limit): tell the user. `get_balances` shows what is left; `get_run_status` shows `error_message`, and `enrichment.pause_reason` for an enrichment.

API keys never go through the chat. The user saves a key in Cubex (Settings, Enrichment, saved API keys) and a request names it as `{{key_name}}`, for example `Authorization: Bearer {{people_api_key}}`. Using a saved key needs a token with the `secrets` scope. Never ask the user to paste a key, and never put one in a request, a prompt or a file.

## 3. Rerun only those rows

A rerun calls the AI, the API or the enrichment again for each row, and costs again. Tell the user how many rows and roughly what it costs, and wait for a yes.

- `control_run` with `action: "rerun"`, the `run_type`, the `run_id` and `mode: "errored"` (only ❌ rows). An HTTP run takes `mode: "missing"`. Or pass exact `row_ids` from step 1.
- Enrichment reruns take `spend_limit_usd`; a lower `concurrency` helps with 429s.
- Follow it with `get_run_status` (`wait_seconds` up to 25) until it is done, then check its `failed_rows`.

## 4. Report

How many rows failed and why, what you changed, how many are fixed now (a `has_error` count again), and what is left that needs the user.
