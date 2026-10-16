// The setups library: list, read, rename (and describe), delete, and the one
// place that writes a setup (insertSetup, for saving and importing). One
// implementation for the app, /api/v1 and MCP. A setup is a copy: deleting or
// changing one never touches a sheet it was used on.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_SETUP_DESCRIPTION_CHARS, MAX_SETUP_NAME_CHARS, MAX_SETUP_SPEC_BYTES } from '../lib/constants-setups';
import { containsInvisibleNameChar, normalizeNameSpacing } from '../lib/name-safety';
import { readSpec } from '../lib/setups/check';
import { KIND_LABEL, mainColumn, stepColumns, type SetupSpec, type StepKind } from '../lib/setups/spec';
import type { RunFail } from './run-shared';

interface SetupRow {
  id: string; name: string; description: string | null; spec: string; use_count: number;
  last_used_at: string | null; created_at: string; updated_at: string;
}

export interface SetupSummary {
  id: string; name: string; description: string | null;
  inputs: string[]; keys: string[];
  steps: Array<{ kind: StepKind; kind_label: string; column: string; columns: string[] }>;
  use_count: number; last_used_at: string | null; created_at: string; updated_at: string;
}
export type SetupDetail = SetupSummary & { spec: SetupSpec };

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'Setup not found' };

export function setupName(raw: unknown): string | RunFail {
  if (typeof raw !== 'string' || !raw.trim()) return bad('Give the setup a name.');
  const name = normalizeNameSpacing(raw);
  if (name.length > MAX_SETUP_NAME_CHARS) {
    return bad(`A setup's name can be at most ${MAX_SETUP_NAME_CHARS} characters.`);
  }
  if (containsInvisibleNameChar(name)) {
    return bad('The name has invisible characters in it. Remove them and try again.');
  }
  return name;
}

export function setupDescription(raw: unknown): string | null | RunFail {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return bad('The description must be text.');
  const text = raw.trim();
  if (text.length > MAX_SETUP_DESCRIPTION_CHARS) {
    return bad(`The description can be at most ${MAX_SETUP_DESCRIPTION_CHARS} characters.`);
  }
  return text || null;
}

// A stored spec was checked whole when it was written (insertSetup), so reading
// one only parses it. Damaged: shown with no steps, still deletable.
function parseSpec(raw: string): SetupSpec {
  try {
    const v = JSON.parse(raw);
    if (v && v.v === 1 && Array.isArray(v.inputs) && Array.isArray(v.keys) && Array.isArray(v.steps)) return v;
  } catch { /* below */ }
  return { v: 1, inputs: [], keys: [], steps: [] };
}

// A setup's steps in a few words (and its inputs and keys), for lists and the save dialog.
export function specSummary(spec: SetupSpec): Pick<SetupSummary, 'inputs' | 'keys' | 'steps'> {
  return {
    inputs: spec.inputs, keys: spec.keys,
    steps: spec.steps.map(s => ({ kind: s.kind, kind_label: KIND_LABEL[s.kind], column: mainColumn(s),
      columns: stepColumns(s) })),
  };
}

function summary(r: SetupRow, spec: SetupSpec): SetupSummary {
  return {
    id: r.id, name: r.name, description: r.description, ...specSummary(spec),
    use_count: r.use_count, last_used_at: r.last_used_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

const nameTaken = (userId: string, name: string, exceptId: string | null): boolean =>
  !!db.prepare('SELECT 1 FROM setups WHERE user_id = ? AND LOWER(name) = LOWER(?) AND id != ?')
    .get(userId, name, exceptId ?? '');

const taken = (name: string): RunFail => ({ fail: 'conflict', message: `A setup named "${name}" already exists.` });

export function listSetups(userId: string): SetupSummary[] {
  const rows = db.prepare('SELECT * FROM setups WHERE user_id = ? ORDER BY LOWER(name)').all(userId) as SetupRow[];
  return rows.map(r => summary(r, parseSpec(r.spec)));
}

export function getSetup(userId: string, id: string): SetupDetail | null {
  const r = db.prepare('SELECT * FROM setups WHERE id = ? AND user_id = ?').get(id, userId) as SetupRow | undefined;
  if (!r) return null;
  const spec = parseSpec(r.spec);
  return { ...summary(r, spec), spec };
}

// The one insert. A name already taken is refused (conflict), unless
// `freeName`: then " (2)", " (3)"… is added (importing a file twice).
export function insertSetup(
  userId: string, name: string, description: string | null, spec: SetupSpec, freeName = false,
): { ok: SetupDetail } | RunFail {
  const json = JSON.stringify(spec);
  if (Buffer.byteLength(json) > MAX_SETUP_SPEC_BYTES) {
    return bad(`This setup is too big to save (over ${Math.round(MAX_SETUP_SPEC_BYTES / 1024)} KB).`);
  }
  // What's stored must read back whole, as a file of it would import.
  const back = readSpec(JSON.parse(json));
  if ('problem' in back) return bad(`This setup can't be saved: ${back.problem}`);
  let finalName = name;
  for (let n = 2; nameTaken(userId, finalName, null); n++) {
    if (!freeName || n > 100) return taken(name);
    finalName = `${name.slice(0, MAX_SETUP_NAME_CHARS - 6)} (${n})`;
  }
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO setups (id, user_id, name, description, spec) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, finalName, description, json);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) return taken(finalName);
    throw e;
  }
  return { ok: getSetup(userId, id)! };
}

export function updateSetup(
  userId: string, id: string, input: { name?: unknown; description?: unknown },
): { ok: SetupDetail } | RunFail {
  const current = getSetup(userId, id);
  if (!current) return notFound;
  const name = input.name === undefined ? current.name : setupName(input.name);
  if (typeof name !== 'string') return name;
  const description = input.description === undefined ? current.description : setupDescription(input.description);
  if (description !== null && typeof description !== 'string') return description;
  if (nameTaken(userId, name, id)) return taken(name);
  try {
    db.prepare(`UPDATE setups SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(name, description, id, userId);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) return taken(name);
    throw e;
  }
  return { ok: getSetup(userId, id)! };
}

export function deleteSetup(userId: string, id: string): { ok: { deleted: string } } | RunFail {
  const out = db.prepare('DELETE FROM setups WHERE id = ? AND user_id = ?').run(id, userId);
  return out.changes ? { ok: { deleted: id } } : notFound;
}
