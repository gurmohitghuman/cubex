---
name: clean-and-dedupe
description: "Clean a list in Cubex and remove duplicate rows, for free (no AI, no credits). Use it whenever the user wants to tidy or standardize names, company names, emails, domains or phone numbers, split first and last names, fix case or spaces, or find and remove duplicate rows in a Cubex sheet."
---

# Clean and dedupe a list

Everything here is free: no AI call, nothing sent anywhere. Never use an AI column for a job a cleaner or a formula does.

## 1. Look first

- `get_sheet` with `include_counts: true`: what each column is and how full it is. On a big sheet, name the columns in `columns`.
- `read_rows` with `group_by: ["Country"]` and `aggregates: [{"op": "count"}]`: a column's values with how many rows hold each, to spot junk and variants ("USA", "U.S.", "United States").
- A sample: `read_rows` with `limit: 20` and the `columns` you care about.

## 2. Clean into new columns

`clean_column` writes a new column (named after its source, such as `Name (clean)`) and never changes the source. Pick a `cleaner`:

| Cleaner | Does |
|---|---|
| `person_name` | Fixes ALL CAPS and lowercase, turns "Last, First" around, drops titles and suffixes |
| `first_name`, `last_name` | The same, split |
| `company_name` | Drops Inc, LLC, Ltd, GmbH and other legal endings, fixes ALL CAPS |
| `email` | Pulls the address out of `Name <address>`, lowercases it, blank when invalid |
| `domain` | The root domain of a website or an email address |
| `phone` | One format: `phone_format` national, international or e164; `phone_country` for numbers without a country code |
| `title_case`, `lowercase`, `trim` | Case and spaces |

- Pass `preview: true` first and show the user a few before and after values.
- Auto-run is on by default, so new and edited rows get cleaned on their own.
- For what the cleaners don't do (join two columns, split on a character, pick a value out of a JSON cell), use `formula_column`: one JavaScript expression reading cells as `{{Column}}`, also free. `write_formula` writes one from plain words.

## 3. Remove duplicates

1. Choose the key with the user. `columns` takes names or `{"column": ..., "match": ...}` with `match` one of `text` (default), `email`, `domain` (one row per company), `phone`, `company` or `person_name`, or several columns that must all match.
2. `remove_duplicates` is a dry run unless `dry_run` is `false`. Show the user the result: how many rows would go, the sample groups and the largest group, so they see what "duplicate" means here.
3. `keep`: `first` (default, the highest row), `last`, or `most_complete` (the row with the most filled cells).
4. Only after the user says yes, call it again with `dry_run: false`. Removed rows go to the trash (the answer says how to restore them); their run results go. It is refused while a run is active on the sheet.

A row with any key value empty, or holding a run status such as "⏭️ Not found", is never removed.

## 4. Keep it deduplicated

When new rows keep arriving (a webhook, regular imports, an agent appending rows), offer `set_auto_dedupe`: one key column with its `match`, and `keep` `oldest` (a new row with a key already there is not kept) or `newest` (it replaces the older rows). It checks rows as they arrive and rows given a new key, never the rows already there, so run `remove_duplicates` once first. The key must be a column rows arrive with, not a filled one: to match on a cleaned value, pick the raw column and the match (a website column as `domain`). `append_rows` and `import_csv` answers say which rows weren't kept; `list_trash` with `how: "auto_dedupe"` lists them.

## 5. Report

Say what changed: the new columns and how many cells each cleaned or left blank (in the answer, or `get_sheet`'s `clean_columns`), and how many duplicate rows were removed. Offer `set_description` on the new columns.
