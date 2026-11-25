-- Scheduled reruns (services/run-schedule*.ts): a sheet's run columns (or a table's, sheet by sheet) run again on a
-- cadence, each firing an ordinary column run (services/column-run.ts) as the token or user that made the schedule.
-- columns: JSON names, NULL for every run column. next_at: UTC, when the sweep fires it next (a firing missed while
-- Cubex was stopped fires once at the next start). last_run_ids: JSON, the column runs the last firing started.
CREATE TABLE run_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT REFERENCES sheets(id) ON DELETE CASCADE,
  table_id TEXT REFERENCES tables(id) ON DELETE CASCADE,
  columns TEXT,
  rows TEXT NOT NULL CHECK (rows IN ('empty', 'errored', 'out_of_date', 'all')),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'monthly', 'hours')),
  at_time TEXT,
  time_zone TEXT NOT NULL,
  weekday INTEGER,
  month_day INTEGER,
  every_hours INTEGER,
  max_cost_usd REAL,
  allow_unpriced INTEGER NOT NULL DEFAULT 0,
  allow_secrets INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_fired_at TEXT,
  last_run_ids TEXT,
  last_error TEXT,
  access_token_id TEXT REFERENCES access_tokens(id) ON DELETE SET NULL,
  token_name TEXT,
  via TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((sheet_id IS NULL) <> (table_id IS NULL))
);
CREATE INDEX idx_run_schedules_due ON run_schedules(next_at) WHERE paused = 0;
CREATE INDEX idx_run_schedules_sheet ON run_schedules(sheet_id);
CREATE INDEX idx_run_schedules_table ON run_schedules(table_id);
