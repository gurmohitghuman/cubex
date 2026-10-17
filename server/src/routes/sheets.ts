import express from 'express';
import readRoutes from './sheets-read';
import dataRoutes from './sheets-data';
import crudRoutes from './sheets-crud';
import csvImportRoutes from './sheets-csv-import';
import csvExportRoutes from './sheets-csv-export';
import columnsMutateRoutes from './sheets-columns-mutate';
import columnsDeleteRoutes from './sheets-columns-delete';
import columnsReorderRoutes from './sheets-columns-reorder';
import columnsOrderRoutes from './sheets-columns-order';
import rowsMutateRoutes from './sheets-rows-mutate';
import sortRoutes from './sheets-sort';
import webhooksRoutes from './sheets-webhooks';
import webhookDeliveriesRoutes from './sheets-webhook-deliveries';
import changesRoutes from './sheets-changes';
import cleanRoutes from './sheets-clean';
import formulaRoutes from './sheets-formula';
import setupRoutes from './sheets-setups';
import dedupeRoutes from './sheets-dedupe';
import runsStopRoutes from './sheets-runs-stop';
import { refuseChangesWhileBusy } from '../lib/sheet-busy';

// Composed sheets router. Each sub-router handles a related cluster of endpoints,
// which keeps each file small.
//
// Note on registration order: PUT /:id/columns/reorder (columns-reorder.ts) and
// PUT /:id/columns/:columnName (columns-order.ts). Express matches in registration
// order, so the reorder router MUST be mounted BEFORE the rename router below, or
// "reorder" would be captured as a :columnName. Adding new column routes that
// share the /:id/columns/ prefix needs the same care. The webhook routes use
// distinct /:id/webhook* and /:id/changes prefixes, so no collision.
const router = express.Router();
// A sheet that is busy sorting, importing or rewriting a column takes no other
// change until it finishes; appending rows is safe, and a clean or formula
// column's preview (and writing a formula with AI) only reads (lib/sheet-busy.ts),
// as saving a setup does. Stopping every run is allowed: a run still writing
// its placeholders is what holds the sheet.
router.use('/:id', refuseChangesWhileBusy([
  '/rows', '/clean-columns/preview', '/formula-columns/preview', '/formula-columns/write', '/setups/plan', '/setups',
  '/runs/stop',
  // Using a setup: its estimate only reads, and its start checks the sheet itself (services/setup-apply.ts).
  /^\/setups\/[^/]+\/apply$/,
]));
router.use(readRoutes);
router.use(dataRoutes);
router.use(rowsMutateRoutes);
router.use(crudRoutes);
router.use(csvImportRoutes);
router.use(csvExportRoutes);
router.use(sortRoutes);
router.use(columnsMutateRoutes);
router.use(columnsDeleteRoutes);
router.use(columnsReorderRoutes);
router.use(columnsOrderRoutes);
router.use(webhooksRoutes);
router.use(webhookDeliveriesRoutes);
router.use(changesRoutes);
router.use(cleanRoutes);
router.use(formulaRoutes);
router.use(setupRoutes);
router.use(dedupeRoutes);
router.use(runsStopRoutes);

export default router;
