// Saved views in the app (services/views.ts): new view (a copy of the active
// one, switched to), a ready-made one, rename, describe, hide or show
// columns, delete, switch, the active view's whole filter (the filter panel),
// and clearing its extra row filter.
// The sheet read (sheets-read.ts) lists the views; REST v1: api-v1-views.ts.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { activateView, createView, deleteView, saveRowFilter, updateView } from '../services/views';
import { isViewStarter, pickViewStarter } from '../services/view-starters';
import { saveSheetFilters } from '../services/view-filter-save';
import { viewMoved, type ViewFail } from '../services/view-store';

const router = express.Router();
router.use(authenticateToken);

const STATUS: Record<ViewFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };

function answer(res: express.Response, outcome: { ok: unknown } | ViewFail, status = 200) {
  if ('fail' in outcome) return res.status(STATUS[outcome.fail]).json({ error: outcome.message });
  return res.status(status).json(outcome.ok === true ? { ok: true } : { view: outcome.ok });
}

const guarded = (label: string, handler: (req: AuthRequest, res: express.Response) => unknown) =>
  (req: AuthRequest, res: express.Response) => {
    try {
      handler(req, res);
    } catch (error) {
      console.error(`${label} error:`, error);
      res.status(500).json({ error: `Failed to ${label}` });
    }
  };

// Body: { name, description?, from? }: a copy of `from` (default: the active
// view), switched to.
router.post('/:id/views', guarded('create view', (req, res) => {
  const b = req.body ?? {};
  answer(res, createView(req.params.id, req.userId!,
    { name: b.name, description: b.description, from: b.from, activate: true }), 201);
}));

// Body: { kind: 'errors' | 'filled' }.
router.post('/:id/views/starter', guarded('add view', (req, res) => {
  const kind = req.body?.kind;
  if (!isViewStarter(kind)) return res.status(400).json({ error: 'kind must be errors or filled.' });
  answer(res, pickViewStarter(req.params.id, req.userId!, kind));
}));

// Body: any of { name, description, hiddenColumns }.
router.patch('/:id/views/:viewId', guarded('update view', (req, res) => {
  const b = req.body ?? {};
  answer(res, updateView(req.params.id, req.userId!, req.params.viewId,
    { name: b.name, description: b.description, hidden_columns: b.hiddenColumns }));
}));

router.delete('/:id/views/:viewId', guarded('delete view', (req, res) => {
  answer(res, deleteView(req.params.id, req.userId!, req.params.viewId));
}));

router.post('/:id/views/:viewId/activate', guarded('switch view', (req, res) => {
  answer(res, activateView(req.params.id, req.userId!, req.params.viewId));
}));

// Body: { rowFilter: null | where, viewId? } (viewId: as the other filter saves, sheets-crud.ts).
router.put('/:id/row-filter', guarded('update filter', (req, res) => {
  if (viewMoved(req.params.id, req.userId!, req.body?.viewId)) {
    return res.status(409).json({ error: 'Another view is showing now. Reloading.', viewChanged: true });
  }
  answer(res, saveRowFilter(req.params.id, req.userId!, req.body?.rowFilter ?? null));
}));

// Body: { where: null | where, viewId? }: the active view's whole filter (services/view-filter-save.ts).
router.put('/:id/filters', guarded('update filter', (req, res) => {
  if (viewMoved(req.params.id, req.userId!, req.body?.viewId)) {
    return res.status(409).json({ error: 'Another view is showing now. Reloading.', viewChanged: true });
  }
  answer(res, saveSheetFilters(req.params.id, req.userId!, req.body?.where ?? null));
}));

export default router;
