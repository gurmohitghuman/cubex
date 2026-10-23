# Settings and your data

## Settings

Everything is optional. Settings live in `~/.cubex/config.env` (on Windows, `%LOCALAPPDATA%\cubex\config.env`), one `KEY=value` per line; after a change, run `cubex restart`. (With Docker, Coolify or a source checkout, they live elsewhere: see [Other ways to run Cubex](other-ways-to-run.md).)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3002` | Port Cubex listens on. |
| `HOST` | `127.0.0.1` | Who can open Cubex. `127.0.0.1`: only this computer. `0.0.0.0`: any device that can reach it. |
| `DB_PATH` | `~/.cubex/data/cubex.db` | The database. Its directory also holds `jobs.db` and the generated secrets. |
| `INITIAL_PASSWORD` | (none) | Creates the account with this password on first boot, so a public install can't be claimed by whoever finds it first. Ignored once the account exists. |
| `PUBLIC_URL` | (none) | The address webhook senders and agents' file links use, if it differs from the one you browse on. |
| `MAX_ROWS_PER_SHEET` | `1000000` | Rows per sheet. |
| `MAX_COLUMNS_PER_SHEET` | `200` | Columns per sheet. |
| `MAX_CSV_UPLOAD_MB` | `500` | Largest CSV you can import. |
| `HTTP_MAX_CONCURRENCY` | `100` | Most concurrent requests one HTTP run makes. |
| `SIDEQUEST_MAX_CONCURRENT_JOBS` | `4` | AI and HTTP runs that execute at once; more wait in line. |
| `ENRICH_DEFAULT_CONCURRENCY` | `5` | Requests one enrichment run sends to treg at once. |
| `ENRICH_STORED_RAW_MAX_BYTES` | `16384` | How much of each provider's raw answer is kept, in bytes, for the answer panel and **Add as column**. |
| `TREG_BASE_URL` | `https://treg.to` | Where enrichment calls go. Only for testing or a self-hosted treg. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Where AI calls go. Only for testing. |
| `LOGIN_RATE_MAX` | `10` | Failed sign-ins allowed per 15 minutes, for the whole instance. |
| `RUN_BREAKER_FAILURES` | `5` | AI and HTTP API rows failing in a row on the provider's side (no answer, a server error, a rejected key, no credits) before the run pauses itself. |
| `AI_CALL_DEADLINE_MS` | `600000` | Longest one AI call may take, answer included, before its row fails as timed out. |
| `DISK_LOW_MB` | `200` | Free space on the data folder below which the health check says `low` and stalled runs aren't started again. |
| `MCP_EFFICIENT_ROWS_ENABLED` | off | Set to `1` to give agents the `transfer_rows` and `transform_column` tools. |
| `JWT_SECRET`, `APP_ENCRYPTION_KEY` | generated | Created on first boot. Set them only to manage them yourself. |

There are no limits on tables or sheets. A million rows per sheet runs comfortably on an ordinary server: the grid loads rows as you scroll, and the big jobs (import, sort, renaming or deleting a column, AI and HTTP runs) work through the sheet in small batches, so memory stays low and Cubex keeps answering while they run. The measured numbers are in [Performance](performance.md).

## Your data and backups

Everything Cubex keeps lives in one directory, `~/.cubex/data` (on Windows, `%LOCALAPPDATA%\cubex\data`):

| File | What it is |
|---|---|
| `cubex.db` | Your tables, settings and encrypted keys. |
| `jobs.db` | The run queue, so runs survive a restart. |
| `.jwt-secret` | Signs sign-in sessions. |
| `.encryption-key` | Encrypts your OpenRouter key, treg key, saved API keys, webhook URLs and run webhook secrets. |
| `uploads/` | CSV files while they import. Emptied when Cubex starts; no need to back it up. |

Back up the whole directory together. **If `.encryption-key` is lost, saved keys can't be decrypted** and have to be entered again. To take a consistent snapshot while Cubex is running, use `scripts/backup-cubex-db.sh` (with the installer: `~/.cubex/app/scripts/backup-cubex-db.sh ~/.cubex/data/cubex.db`). The server guide shows how to [run it every night](self-hosting.md#6-back-up-every-night). The script needs bash, so on Windows run `cubex stop`, copy the `data` folder, then `cubex start`.

## What Cubex connects to

Your data stays in one SQLite file on your machine. The server only calls out to:

- **OpenRouter**, for AI columns, including its price list for web search engines, and to read what your key can still spend (Settings, `get_balances`, and an AI run's estimate and preview).
- **The APIs you put in HTTP columns.**
- **Your run webhook URLs**, when a run finishes (Settings, Run webhooks): the run's id, kind, sheet, status and time, nothing from your rows.
- **[treg.to](https://treg.to)**, for enrichments: its catalog of jobs when you open **Enrichment**, and your rows' values only once you've saved a treg key and run an enrichment.

The web page also loads its fonts from Google Fonts.
