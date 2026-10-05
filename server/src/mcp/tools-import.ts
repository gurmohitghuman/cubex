// import_csv — CSV text (tool args are JSON; no multipart over MCP, and the
// /mcp body cap bounds the payload at 2MB) through the SAME parse + commit
// pipeline as the /v1 and UI import routes. Larger files stay a UI/API job.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../lib/db';
import { scanCsvText, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv } from '../services/csv-import';
import { makeRateWindow, tooManyMessage } from '../lib/rate-window';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { CELL_MAX_BASIC } from '../lib/constants';

// At most 5 imports a minute per access token: each one can parse a large CSV
// and write thousands of rows (holding SQLite's single writer that the UI's
// autosave also needs), and agents can loop.
const importWindow = makeRateWindow(5);

export function registerImportTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'import_csv',
    {
      description:
        'Import CSV text into a sheet. The header row names the columns; new columns are created, and columns matching existing names (exactly) append into them. mode "append" adds rows after the existing ones; mode "replace" DELETES all existing rows first (permanent). Fails on columns an active run owns. Max ~2MB of CSV per call — for bigger data, batch with append_rows.',
      inputSchema: {
        sheet_id: z.string(),
        csv: z.string().min(1).describe('Raw CSV content including the header row'),
        mode: z.enum(['append', 'replace']).optional().describe('Default append'),
      },
    },
    async ({ sheet_id, csv, mode }) => {
      const denied = missingScope(ctx, 'write');
      if (denied) return denied;
      const slot = importWindow(ctx.tokenId);
      if (!slot.allowed) return err(tooManyMessage('CSV imports', slot));
      if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheet_id, ctx.userId)) {
        return err('Sheet not found');
      }

      let scanned;
      try {
        scanned = await scanCsvText(csv);
      } catch (parseErr) {
        return err(parseErr instanceof CsvHeaderCollisionError
          ? parseErr.message
          : 'CSV could not be parsed. Check it is valid CSV text with a header row.');
      }

      const replace = mode === 'replace';
      const result = await importCsv(sheet_id, ctx.userId, scanned, replace, { bumpDataVersion: true, seedEmptyRow: false });
      if ('fail' in result) {
        if (result.fail === 'locked') {
          return err(`Cannot import into column(s) an active run owns: ${result.columns.join(', ')}. Stop the run first.`);
        }
        return err(result.error);
      }
      return ok({
        rows_imported: result.ok.rowsImported,
        starting_row: result.ok.startingRow,
        new_columns: result.ok.newColumns,
        replaced: replace,
        // Only present when it happened, so a normal import isn't noisier.
        ...(result.ok.droppedSeedRows ? { dropped_blank_starter_rows: true } : {}),
        ...(result.ok.truncatedCells > 0 ? {
          truncated_cells: result.ok.truncatedCells,
          note: `${result.ok.truncatedCells} cell(s) were longer than ${CELL_MAX_BASIC} characters and were cut to fit.`,
        } : {}),
      });
    },
  );
}
