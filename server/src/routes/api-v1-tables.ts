// /v1 tables: discovery (GET) + CRUD — thin wrappers over services/table-crud.ts
// (shared with the MCP manage_table tool). v1 status-code note: caps are 400
// and name conflicts 409 (the UI route's historical 403/400 pair stays untouched).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { listTablesWithSheets } from '../services/workspace-read';
import {
  createTable, renameTable, deleteTable, setTableStarred, tableFailHttpStatus, type TableCrudFail,
} from '../services/table-crud';
import { getTableForClient } from '../lib/sheet-crud-helpers';
import { db } from '../lib/db';
import { trashAnswer } from '../services/trash-answer';
import { createSampleTable } from '../services/sample-table';
import { sampleAnswer } from '../services/sample-answer';
import { webhookFlagProblem, webhookForNewSheet } from '../services/sheet-webhook';
import { linkBase } from '../lib/file-links';

const router = express.Router();

// A refusal inside PATCH's transaction: thrown so the transaction rolls back, then answered.
class Refused { constructor(readonly fail: TableCrudFail) {} }

router.get('/tables', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    res.json({ tables: await listTablesWithSheets(req.userId!) });
  } catch (error) {
    console.error('GET /v1/tables error:', error);
    res.status(500).json({ error: 'Failed to list tables' });
  }
});

// POST /v1/tables {name, webhook?}: creates the table plus its first empty sheet
// (same contract as the UI route: no starter grid on table-create). webhook: true
// also gives that sheet its incoming webhook, with the URL in the answer.
router.post('/tables', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const { name, webhook } = (req.body ?? {}) as { name?: unknown; webhook?: unknown };
    const flag = webhookFlagProblem(webhook);
    if (flag) return res.status(400).json({ error: flag });
    const result = createTable(req.userId!, name);
    if ('fail' in result) return res.status(tableFailHttpStatus(result)).json({ error: result.message });
    res.status(201).json({
      id: result.ok.id, name: result.ok.name,
      sheets: [{ id: result.ok.sheetId, name: 'Sheet1', position: 0, row_count: 0 }],
      ...(webhook === true ? webhookForNewSheet(req.userId!, result.ok.sheetId, linkBase(req)) : {}),
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

// PATCH /v1/tables/:id {name?, starred?}: rename, star (the home's Favorites) or both. A starred that isn't true
// or false changes nothing, and either change refused leaves the other undone. Answers {id, name, starred}.
router.patch('/tables/:id', requireScope('write'), (req: TokenAuthRequest, res) => {
  try {
    const { name, starred } = (req.body ?? {}) as { name?: unknown; starred?: unknown };
    if (name === undefined && starred === undefined) {
      return res.status(400).json({ error: 'Send name to rename the table, starred (true or false) to star it, '
        + 'or both.' });
    }
    if (starred !== undefined && typeof starred !== 'boolean') {
      return res.status(400).json({ error: 'starred must be true or false.' });
    }
    // Both in one transaction (each its own savepoint inside it): either refused, the table stays as it was.
    try {
      db.transaction(() => {
        if (name !== undefined) {
          const renamed = renameTable(req.userId!, req.params.id, name);
          if ('fail' in renamed) throw new Refused(renamed);
        }
        if (starred !== undefined) {
          const out = setTableStarred(req.userId!, req.params.id, starred);
          if ('fail' in out) throw new Refused(out);
        }
      }).immediate();
    } catch (e) {
      if (e instanceof Refused) return res.status(tableFailHttpStatus(e.fail)).json({ error: e.fail.message });
      throw e;
    }
    const t = getTableForClient(req.params.id, req.userId!);
    if (!t) return res.status(404).json({ error: 'Table not found' });
    res.json({ id: t.id, name: t.name, starred: t.starred });
  } catch (error) {
    console.error('PATCH /v1/tables/:id error:', error);
    res.status(500).json({ error: 'Failed to change the table' });
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
