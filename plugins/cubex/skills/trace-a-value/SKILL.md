---
name: trace-a-value
description: "Explain where a value in a Cubex sheet came from: the column, run, prompt, API, enrichment provider, formula, cleaner, webhook or other sheet that produced it, and what it cost. Use it whenever the user asks why a cell holds a value, where a value came from, how a column is filled, or whether to trust a value."
---

# Trace where a value came from

## 1. Find the cell

- Find the row with `read_rows` and a `where` on a column that identifies it, such as `[{"column": "Email", "operator": "eq", "value": "jo@acme.com"}]`, with `columns` limited to what you need. Keep the row's `id` and `index`.
- `include_status: true` returns a run column's cell as `{status, value, error}`.

## 2. Find what fills the column

`get_sheet` with `columns: ["<the column>"]` shows that column's `column_details` in full. By `kind`:

- `plain`: typed by a person, imported from a CSV, or written by an agent. Cubex keeps no history of who typed a cell.
- `webhook`: it arrived with a webhook delivery: `fill.webhook` names the webhook, and a `field` column's `json_path` says where in the payload.
- `clean`: the cleaner in `fill.cleaner` applied to the column in `reads`. Read that source cell in the same row.
- `formula`: `fill.formula` worked out from the columns in `reads`.
- `lookup`: this row's `reads[0]` matched against `fill.match_column` in the sheet `fill.other_sheet`, returning `fill.return_column` (or yes/no, a count, the matching rows). Read the matching row there.
- `ai`, `http` or `enrichment`: a run filled it. An output column names its main column in `filled_by`; the main column's `fill` has the newest `run_id`, the prompt, model, URL or enrichment tool.
- `waterfall`: steps tried in turn until one answered. The result column's `fill` lists the steps and has the newest `run_id`; the "answered by" column (`role: answered_by`) names the step that answered each row. A `lookup` step took its value from another sheet (`other_sheet`, `match_column`, `return_column`): trace it there, in the first row whose `match_column` matches.

## 3. Read that run's answer for the row

`get_run_results` with the `run_type`, the `run_id` and `status_filter: "all"` (it lists only failed rows by default) returns rows in sheet order with their `row_id`; page with `cursor` to the row.

- AI: the value, `cost_usd`, and with web search its searches (`search_queries`). The row's "(Data)" column lists the sources the model used.
- HTTP API: `extracted_fields`, the values picked out of the response.
- Enrichment: `found_by` (the provider that found it), `cost_usd`, and `reused_answer_from` when it came free from an earlier found answer. `include_answers: true` shows the stored answer.
- Waterfall (`run_type: "waterfall"`): `answered_by`, `cost_usd` (treg and AI) and `trace`: every step the row reached, with what it did (answered, rejected by its check, not_found, no_inputs, error, budget) and what it cost.

If the value is older than the newest run, `list_runs` with the `sheet_id` lists the sheet's runs, newest first.

## 4. Answer

Say plainly: what kind of column it is, what produced the value (prompt and model, API, provider, formula, cleaner, lookup, webhook), from which input cells, which run, and what it cost. Point out anything that lowers trust: a guessed or catch-all email, an AI answer without sources, an input cell that changed since the run.
