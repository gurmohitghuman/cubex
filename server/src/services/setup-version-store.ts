// A sheet's setup versions (setup_versions, migration 043): list, read, save
// (a copy of the setup as it is now: setup-version-snapshot.ts), rename or
// describe, delete for good. One implementation for the app, /api/v1 and MCP.
// Names are unique in a sheet, ignoring case. A column rename rewrites every
// version naming it (setup-version-rename.ts, inside the rename's transaction).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { containsInvisibleNameChar, normalizeNameSpacing } from '../lib/name-safety';
import { actorLabel, currentActor, type Via } from '../lib/actor';
import { logSheetChange } from '../lib/change-log';
import {
  MAX_SETUP_DESCRIPTION_CHARS, MAX_SETUP_NAME_CHARS, MAX_SETUP_VERSION_BYTES, MAX_SETUP_VERSIONS_PER_SHEET,
} from '../lib/constants-setups';
import { parseVersionSpec, type VersionSpec } from '../lib/setup-versions/spec';
import { snapshotSheet } from './setup-version-snapshot';
import type { RunFail } from './run-shared';

interface VersionRow {
  id: string; sheet_id: string; name: string; description: string | null; auto: number; spec: string;
  via: Via; token_name: string | null; created_at: string; updated_at: string;
}

export interface VersionInfo {
  id: string; name: string; description: string | null; auto: boolean; by: string; saved_at: string;
  columns: number; filled: number;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'Setup version not found' };
const noSheet: RunFail = { fail: 'not_found', message: 'Sheet not found' };
const iso = (at: string) => `${at.replace(' ', 'T')}Z`;

type VersionHead = Omit<VersionRow, 'spec'>;
const infoWith = (r: VersionHead, columns: number, filled: number): VersionInfo => ({
  id: r.id, name: r.name, description: r.description, auto: !!r.auto, by: actorLabel(r.via, r.token_name),
  saved_at: iso(r.created_at), columns, filled,
});
const infoOf = (r: VersionHead, spec: VersionSpec | null): VersionInfo =>
  infoWith(r, spec?.columns.length ?? 0, spec?.columns.filter(c => c.fill).length ?? 0);

// The list counts each version's columns in SQL (parseVersionSpec's rule: a spec
// it can't read counts none), so no spec, up to MAX_SETUP_VERSION_BYTES each, is read into JS.
const LIST = `SELECT id, sheet_id, name, description, auto, via, token_name, created_at, updated_at,
    CASE WHEN json_valid(spec) AND json_extract(spec, '$.v') = 1 AND json_type(spec, '$.columns') = 'array'
      THEN json_array_length(spec, '$.columns') ELSE 0 END AS n,
    CASE WHEN json_valid(spec) AND json_extract(spec, '$.v') = 1 AND json_type(spec, '$.columns') = 'array'
      THEN (SELECT COUNT(*) FROM json_each(spec, '$.columns')
        WHERE CASE WHEN type = 'object' THEN json_type(value, '$.fill') END = 'object') ELSE 0 END AS filled
  FROM setup_versions WHERE sheet_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC`;

export function versionName(raw: unknown): string | RunFail {
  if (typeof raw !== 'string' || !raw.trim()) return bad('Give the version a name.');
  const name = normalizeNameSpacing(raw);
  if (name.length > MAX_SETUP_NAME_CHARS) {
    return bad(`A version's name can be at most ${MAX_SETUP_NAME_CHARS} characters.`);
  }
  if (containsInvisibleNameChar(name)) {
    return bad('The name has invisible characters in it. Remove them and try again.');
  }
  return name;
}

function versionDescription(raw: unknown): string | null | RunFail {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return bad('description must be text.');
  const text = raw.trim();
  if (text.length > MAX_SETUP_DESCRIPTION_CHARS) {
    return bad(`A version's description can be at most ${MAX_SETUP_DESCRIPTION_CHARS} characters.`);
  }
  return text || null;
}

const nameTaken = (sheetId: string, userId: string, name: string, exceptId: string): boolean =>
  !!db.prepare(`SELECT 1 FROM setup_versions WHERE sheet_id = ? AND user_id = ? AND LOWER(name) = LOWER(?)
    AND id != ?`).get(sheetId, userId, name, exceptId);
const taken = (name: string): RunFail =>
  ({ fail: 'conflict', message: `A version named "${name}" already exists. Pick another name.` });

export function listSetupVersions(sheetId: string, userId: string): VersionInfo[] | null {
  if (!verifySheetOwnership(sheetId, userId)) return null;
  const rows = db.prepare(LIST).all(sheetId, userId) as Array<VersionHead & { n: number; filled: number }>;
  return rows.map(r => infoWith(r, r.n, r.filled));
}

export function readSetupVersion(
  sheetId: string, userId: string, versionId: string,
): { info: VersionInfo; spec: VersionSpec } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return noSheet;
  const r = db.prepare('SELECT * FROM setup_versions WHERE id = ? AND sheet_id = ? AND user_id = ?')
    .get(versionId, sheetId, userId) as VersionRow | undefined;
  if (!r) return notFound;
  const spec = parseVersionSpec(r.spec);
  if (!spec) return bad('This version was saved by a newer Cubex and can\'t be read here.');
  return { info: infoOf(r, spec), spec };
}

// The one insert (call inside a transaction). A restore's own copy (auto) gets
// " (2)", " (3)"… when its name is taken, and at the cap takes the place of the
// oldest such copy (never `spare`, the version being restored); a version
// saved by name is refused instead.
export function insertVersion(
  sheetId: string, userId: string, spec: VersionSpec, name: string, description: string | null, auto: boolean,
  spare = '',
): VersionInfo | RunFail {
  const json = JSON.stringify(spec);
  if (Buffer.byteLength(json, 'utf8') > MAX_SETUP_VERSION_BYTES) {
    const mb = MAX_SETUP_VERSION_BYTES / 1024 / 1024;
    return bad(`This sheet's setup is too big to keep as a version (over ${mb} MB).`);
  }
  const count = db.prepare('SELECT COUNT(*) FROM setup_versions WHERE sheet_id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number;
  if (count >= MAX_SETUP_VERSIONS_PER_SHEET) {
    const oldestAuto = auto ? db.prepare(`SELECT id FROM setup_versions WHERE sheet_id = ? AND user_id = ? AND auto = 1
      AND id != ? ORDER BY created_at, rowid LIMIT 1`).pluck().get(sheetId, userId, spare) as string | undefined
      : undefined;
    if (!oldestAuto) {
      return { fail: 'conflict', message: `A sheet keeps at most ${MAX_SETUP_VERSIONS_PER_SHEET} setup versions. `
        + 'Delete some first.' };
    }
    db.prepare('DELETE FROM setup_versions WHERE id = ?').run(oldestAuto);
  }
  let finalName = name;
  for (let n = 2; nameTaken(sheetId, userId, finalName, ''); n++) {
    if (!auto || n > 1000) return taken(name);
    finalName = `${name.slice(0, MAX_SETUP_NAME_CHARS - 7)} (${n})`;
  }
  const id = uuidv4();
  const actor = currentActor();
  db.prepare(`INSERT INTO setup_versions (id, user_id, sheet_id, name, description, auto, spec, via, token_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, sheetId, finalName, description, auto ? 1 : 0, json, actor.via, actor.tokenName);
  const row = db.prepare(`SELECT id, sheet_id, name, description, auto, via, token_name, created_at, updated_at
    FROM setup_versions WHERE id = ?`).get(id) as VersionHead;
  return infoOf(row, spec);
}

export function saveSetupVersion(
  sheetId: string, userId: string, input: { name?: unknown; description?: unknown },
): { ok: VersionInfo } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return noSheet;
  // A busy sheet may be half-way through a column change: its setup isn't one to keep.
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const name = versionName(input.name);
  if (typeof name !== 'string') return name;
  const description = versionDescription(input.description);
  if (description !== null && typeof description !== 'string') return description;
  return db.transaction((): { ok: VersionInfo } | RunFail => {
    const info = insertVersion(sheetId, userId, snapshotSheet(sheetId, userId), name, description, false);
    if ('fail' in info) return info;
    logSheetChange(sheetId, userId, 'setup_version_saved', `Saved the setup version "${info.name}"`,
      { detail: { version_id: info.id, columns: info.columns, filled: info.filled } });
    return { ok: info };
  }).immediate();
}

export function updateSetupVersion(
  sheetId: string, userId: string, versionId: string, input: { name?: unknown; description?: unknown },
): { ok: VersionInfo } | RunFail {
  const current = readSetupVersion(sheetId, userId, versionId);
  if ('fail' in current) return current;
  const name = input.name === undefined ? current.info.name : versionName(input.name);
  if (typeof name !== 'string') return name;
  const description = input.description === undefined ? current.info.description
    : versionDescription(input.description);
  if (description !== null && typeof description !== 'string') return description;
  if (nameTaken(sheetId, userId, name, versionId)) return taken(name);
  try {
    db.prepare(`UPDATE setup_versions SET name = ?, description = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(name, description, versionId, userId);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) return taken(name);
    throw e;
  }
  return { ok: { ...current.info, name, description } };
}

export function deleteSetupVersion(sheetId: string, userId: string, versionId: string): { ok: true } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return noSheet;
  const gone = db.prepare('DELETE FROM setup_versions WHERE id = ? AND sheet_id = ? AND user_id = ?')
    .run(versionId, sheetId, userId).changes;
  return gone ? { ok: true } : notFound;
}
