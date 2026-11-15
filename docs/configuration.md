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
| `REQUEST_BODY_TIMEOUT_MS` | `120000` | How long any request has to send its body once its headers are in. Past that it gets `408` and the connection closes. A CSV upload gets longer (next row). The largest deadline is `2147483647` (about 24.8 days); a longer one counts as that. |
| `UPLOAD_MIN_KB_PER_SECOND` | `128` | The slowest a CSV upload may arrive (in the app, through the API or an upload link): it gets `REQUEST_BODY_TIMEOUT_MS` plus one second per this many KB of its size. At `128`, a 500 MB file has about 70 minutes. |
| `RESPONSE_STALL_TIMEOUT_MS` | `60000` | How long an answer may wait with none of it moving to the client. Past that, the answer and its connection close. Any byte moving resets it, but Cubex sees bytes move only as the system takes them into its network buffers, which can hold several MB, so a download read slowly but steadily can still be cut. Measured on Linux at `60000`: over TCP on the same machine, as from a proxy in front of Cubex ([Self-hosting](self-hosting.md#4-turn-on-https-with-caddy)), a download read slower than about 20 to 40 KB/s can be cut; over a Unix socket, slower than about 2.5 to 5 KB/s. Other setups weren't measured. A larger value lowers these in proportion: at `300000`, about 4 to 8 KB/s behind the proxy. An answer with nothing to send yet (a run's progress stream, a request still being worked on) isn't timed. The largest value is `2147483647` (about 24.8 days); a longer one counts as that. |
| `RESPONSE_MIN_KB_PER_SECOND` | `16` | Only on Windows, or wherever the system can't show progress inside one write: there, the write still going out gets one more second per this many KB of its size before `RESPONSE_STALL_TIMEOUT_MS` cuts it off. At `16`, a 1 MB write has one more minute; a CSV export goes out in writes of at most 1 MB. 0 or less counts as `16`. |
| `WEBHOOK_BODY_TIMEOUT_MS` | `30000` | How long an incoming webhook event has to send its body once its headers are in. Past that it gets `408` and adds nothing. |
| `HTTP_MAX_CONCURRENCY` | `100` | Most concurrent requests one HTTP run makes. |
| `SIDEQUEST_MAX_CONCURRENT_JOBS` | `4` | AI and HTTP runs that execute at once; more wait in line. |
| `ENRICH_DEFAULT_CONCURRENCY` | `5` | Requests one enrichment run sends to treg at once. |
| `ENRICH_STORED_RAW_MAX_BYTES` | `16384` | How much of each provider's raw answer is kept, in bytes, for the answer panel and **Add as column**. |
| `TREG_BASE_URL` | `https://treg.to` | Where enrichment calls go. Only for testing or a self-hosted treg. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Where AI calls go. Only for testing. |
| `RELEASE_CHECK_URL` | GitHub's releases API for Cubex | Where the daily release check asks for the latest release. Only for testing. |
| `LOGIN_RATE_MAX` | `10` | Failed sign-ins allowed per 15 minutes from browsers that have never signed in, together, and for each browser that has, on its own. |
| `RUN_BREAKER_FAILURES` | `5` | AI and HTTP API rows failing in a row on the provider's side (no answer, a server error, a rejected key, no credits) before the run pauses itself. |
| `AI_CALL_DEADLINE_MS` | `600000` | Longest one AI call may take, answer included, before its row fails as timed out. |
| `DISK_LOW_MB` | `200` | Free space on the data folder below which the health check says `low` and stalled runs aren't started again. |
| `CUBEX_START_TIMEOUT` | `600` | Seconds `cubex start` waits for Cubex to answer (30 to 86400). A big database takes a while to check, and to upgrade after an update. A server that keeps crashing fails sooner. |
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
| `backups/` | The copy of `cubex.db` and `jobs.db` the last update kept (`before-update`), for `cubex rollback`, and the data each rollback replaced (`replaced-<time>`). Safe to delete; the next update makes a new copy. |

Back up the whole directory together. **If `.encryption-key` is lost, saved keys can't be decrypted** and have to be entered again. To take a consistent snapshot while Cubex is running, use `scripts/backup-cubex-db.sh` (with the installer: `~/.cubex/app/scripts/backup-cubex-db.sh ~/.cubex/data/cubex.db`). The server guide shows how to [run it every night](self-hosting.md#6-back-up-every-night). The script needs bash, so on Windows run `cubex stop`, copy the `data` folder, then `cubex start`.

## What Cubex connects to

Your data stays in one SQLite file on your machine. The server only calls out to:

- **OpenRouter**, for AI columns, including its price list for web search engines and which models fetch web pages on their own (for an AI run's estimate), and to read what your key can still spend (Settings, `get_balances`, and an AI run's estimate and preview). An AI run with web fetch limits (tokens per page, pages per row) reads pages through Exa, by way of OpenRouter: if an admin of your OpenRouter workspace limited the web fetch engines on its Server Tools page, allow Exa there, or such a run pauses (`pause_reason: "web_engine"`).
- **The APIs you put in HTTP columns.**
- **Your run webhook URLs**, when a run finishes (Settings, Run webhooks): the run's id, kind, sheet, status and time, nothing from your rows.
- **[treg.to](https://treg.to)**, for enrichments: its catalog of jobs when you open **Enrichment**, and your rows' values only once you've saved a treg key and run an enrichment.
- **GitHub**, once a day, for the latest Cubex release, so **Settings → Account → Version** can say when a new one is out: one request to GitHub's releases API that sends nothing about you or your data. It is on by default; turn it off there with **Check for new releases**. **Check now** there asks at once, but at most once a minute: sooner, it shows what the last check found. Turned off, Cubex never asks, and the section shows only the version you run.

The web page also loads its fonts from Google Fonts.
