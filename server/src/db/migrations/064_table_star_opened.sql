-- The home's Favorites and Recent tabs (client DashboardPage; services/table-crud.ts). starred: 1 when the user
-- starred the table (the app, PATCH /v1/tables/:id, MCP manage_table's star). last_opened_at: when the user last
-- opened the table in the app, NULL until then. The home, GET /v1/tables and list_tables show both. Neither moves
-- updated_at: starring or opening a table changes nothing in it.
ALTER TABLE tables ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tables ADD COLUMN last_opened_at TEXT;
