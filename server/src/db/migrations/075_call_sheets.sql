-- The sheets of hidden working tables (setup and enrichment calls without a sheet, migration 067), kept after the
-- working table is deleted: Settings' spend card shows what their enrichments spent as "A call without a sheet",
-- not under the working table's name or as a deleted sheet. No foreign key to sheets on purpose: the row outlives its
-- sheet, and the call sweep (services/setup-call.ts) drops it once no spend window can reach the sheet's spend.
CREATE TABLE call_sheets (
  sheet_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_call_sheets_created ON call_sheets(created_at);
