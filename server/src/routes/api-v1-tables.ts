// /v1 tables: discovery (GET) + CRUD — thin wrappers over services/table-crud.ts
// (shared with the MCP manage_table tool). v1 status-code note: caps are 400
// and name conflicts 409 (the UI route's historical 403/400 pair stays untouched).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { listTablesWithSheets } from '../services/workspace-read';
import { createTable, renameTable, deleteTable, tableFailHttpStatus } from '../services/table-crud';
import { trashAnswer } from '../services/trash-answer';
import { createSampleTable } from '../services/sample-table';
import { sampleAnswer } from '../services/sample-answer';

const router = express.Router();

router.get('/tables', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    res.json({ tables: listTablesWithSheets(req.userId!) });
  } catch (error) {
    console.error('GET /v1/tables error:', error);
    res.status(500).json({ error: 'Failed to list tables' });
  }
});

// POST /v1/tables {name} — creates the table plus its first empty sheet
// (same contract as the UI route: no starter grid on table-create).
router.post('/tables', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const result = createTable(req.userId!, (req.body as { name?: unknown })?.name);
    if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
    res.status(201).json({
      id: result.ok.id, name: result.ok.name,
      sheets: [{ id: result.ok.sheetId, name: 'Sheet1', position: 0, row_count: 0 }],
    });
  } catch (error) {
    console.error('POST /v1/tables error:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

// POST /v1/tables/sample — a new table of made-up leads, its free columns
// filled and its AI column set up but not run (services/sample-table.ts).
router.post('/tables/sample', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    const result = await createSampleTable(req.userId!);
    if ('fail' in result) return res.status(400).json({ error: result.message });
    res.status(201).json(sampleAnswer(result.ok, 'rest'));
  } catch (error) {
    console.error('POST /v1/tables/sample error:', error);
    res.status(500).json({ error: 'Failed to create the sample table' });
  }
});

// PATCH /v1/tables/:id {name} — rename.
router.patch('/tables/:id', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const result = renameTable(req.userId!, req.params.id, (req.body as { name?: unknown })?.name);
    if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
    res.json(result.ok);
  } catch (error) {
    console.error('PATCH /v1/tables/:id error:', error);
    res.status(500).json({ error: 'Failed to rename table' });
  }
});

// DELETE /v1/tables/:id — into the trash with its sheets (services/trash-sheets.ts).
router.delete('/tables/:id', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const result = deleteTable(req.userId!, req.params.id);
    if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
    res.json({ deleted: true, trash: trashAnswer(req.userId!, result.ok.trashId, 'rest') });
  } catch (error) {
    console.error('DELETE /v1/tables/:id error:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

export default router;
