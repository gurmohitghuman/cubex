// /api/v1 saved views of a sheet: list, create (a copy of a view, the active
// one by default, then any where / hidden_columns given), rename or describe,
// change filters or hidden columns, delete. Thin wrappers over
// services/views.ts, the app's implementation. Creating one never switches
// the view the app shows. Reading through a view: rows/query, read_rows and
// export take `view`.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { createView, deleteView, updateView } from '../services/views';
import { listViews, type ViewFail } from '../services/view-store';

const router = express.Router();

const STATUS: Record<ViewFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const reply = (res: express.Response, out: { ok: unknown } | ViewFail, created = false) => {
  if ('fail' in out) return res.status(STATUS[out.fail]).json({ error: out.message });
  res.status(created ? 201 : 200).json(out.ok === true ? { ok: true } : { view: out.ok });
};
const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => (req, res) => {
  try {
    fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'View request failed' });
  }
};

router.get('/sheets/:id/views', requireScope('read'), guarded('GET /v1/sheets/:id/views', (req, res) => {
  const views = listViews(req.params.id, req.userId!);
  return views ? res.json({ views }) : res.status(404).json({ error: 'Sheet not found' });
}));

// Body: { name, description?, from?, where?, hidden_columns? }.
router.post('/sheets/:id/views', requireScope('write'), guarded('POST /v1/sheets/:id/views', (req, res) => {
  const b = body(req);
  return reply(res, createView(req.params.id, req.userId!, {
    name: b.name, description: b.description, from: b.from, where: b.where, hidden_columns: b.hidden_columns,
  }), true);
}));

// Body: any of { name, description, where, hidden_columns }; where and
// hidden_columns replace what the view had (null or [] clears).
router.patch('/sheets/:id/views/:viewId', requireScope('write'),
  guarded('PATCH /v1/sheets/:id/views/:viewId', (req, res) => {
    const b = body(req);
    return reply(res, updateView(req.params.id, req.userId!, req.params.viewId, {
      name: b.name, description: b.description, where: b.where, hidden_columns: b.hidden_columns,
    }));
  }));

router.delete('/sheets/:id/views/:viewId', requireScope('write'),
  guarded('DELETE /v1/sheets/:id/views/:viewId', (req, res) =>
    reply(res, deleteView(req.params.id, req.userId!, req.params.viewId))));

export default router;
