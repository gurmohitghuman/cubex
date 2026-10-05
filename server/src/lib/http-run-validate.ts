import { getSheetColumns } from './sql-helpers';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from './column-names';
import { type ResponseMapping } from './http-request-template';
import { validateHttpJsonPath } from './jsonpath-extract';

// Shared column-name validation for HTTP run / preview start. Centralizes the
// rules that were previously partial and inconsistent between /run and /preview
// (preview only checked exact-string mapping dups; /run checked existence via a
// data probe but neither was case-insensitive, and neither caught a master↔mapping
// collision). All names are sanitized FIRST, then validated, so case/whitespace
// variants ("Domain" vs "domain", "A " vs "A") can't slip through — matching the
// case-insensitive column-name invariant the manual/AI add-column paths enforce
// (a Domain+domain pair makes /column prompt resolution non-deterministic).
//
// `master` may be undefined for a preview (which doesn't create a master column).

export interface HttpColumnValidation {
  ok: boolean;
  error?: string;
  // Sanitized, validated names (only set when ok). The caller should use THESE.
  sanitizedMaster?: string;
  sanitizedMappingColumns?: string[];
}

export function validateHttpRunColumns(
  sheetId: string,
  userId: string,
  responseMapping: ResponseMapping[] | undefined,
  master: string | undefined,
  // Skip the "already exists on the sheet" check for columns the run legitimately
  // reuses (preview never creates columns; a rerun targets existing columns).
  checkExisting: boolean,
): HttpColumnValidation {
  const mappings = Array.isArray(responseMapping) ? responseMapping : [];

  // Sanitize + validate every mapping column name + the master via the shared
  // relaxed rule (same contract as add/rename/AI/CSV): "# Revenue" is fine, only
  // symbol-only / reserved names are rejected.
  const sanitizedMappingColumns: string[] = [];
  for (let i = 0; i < mappings.length; i++) {
    const raw = typeof mappings[i]?.columnName === 'string' ? mappings[i].columnName : '';
    const v = sanitizeAndValidateColumnName(raw);
    if ('error' in v) {
      return { ok: false, error: `Response mapping #${i + 1}: ${v.error}` };
    }
    sanitizedMappingColumns.push(v.name);
  }
  let sanitizedMaster: string | undefined;
  if (master) {
    const v = sanitizeAndValidateColumnName(master);
    if ('error' in v) return { ok: false, error: `Status column: ${v.error}` };
    sanitizedMaster = v.name;
  }

  // Validate each mapping's JSONPath up front (Bug 7), with the LOOSER http policy
  // (validateHttpJsonPath): wildcards/recursion/indexes stay allowed (the HTTP modal
  // documents `$.results[*].title` and jsonpath-plus runs it with eval:false), only
  // eval-required filter/script constructs + over-length are rejected as a fixable
  // config error. Genuinely malformed paths still surface as a per-row error at
  // extraction time (the runner uses extractOutcome) instead of a silent no-match.
  for (let i = 0; i < mappings.length; i++) {
    const pathCheck = validateHttpJsonPath(mappings[i]?.jsonPath);
    if (!pathCheck.ok) {
      return {
        ok: false,
        error: `Response mapping #${i + 1} ("${sanitizedMappingColumns[i]}") has an invalid JSONPath: ${pathCheck.reason}`,
      };
    }
  }

  // Duplicate mapping names on any axis (exact / case / normalized-/token — e.g.
  // "Email"+"email", or "# Email"+"Email" both → /email).
  const seen: string[] = [];
  for (const name of sanitizedMappingColumns) {
    const dup = findColumnNameCollision(name, seen);
    if (dup) return { ok: false, error: `Response-mapping ${columnCollisionMessage(name, dup)}` };
    seen.push(name);
  }

  // Master ↔ mapping collision: the master column carries status markers
  // (✅/⏭️/❌/⏳), so sharing a name (or /token) with a mapping makes the marker
  // overwrite the extracted value (and breaks /column resolution).
  if (sanitizedMaster) {
    const clash = findColumnNameCollision(sanitizedMaster, sanitizedMappingColumns);
    if (clash) {
      return { ok: false, error: `The status column "${sanitizedMaster}" can't share a name or /token with a response-mapping column.` };
    }
  }

  // Conflict with columns that already exist on the sheet (exact/case/token).
  // getSheetColumns reads column_order (authoritative), so this catches an
  // existing-but-empty column the old json_extract data-probe would miss.
  if (checkExisting) {
    const existing = getSheetColumns(sheetId, userId);
    const toCreate = sanitizedMaster
      ? [sanitizedMaster, ...sanitizedMappingColumns]
      : sanitizedMappingColumns;
    for (const name of toCreate) {
      const clash = findColumnNameCollision(name, existing);
      if (clash) return { ok: false, error: columnCollisionMessage(name, clash) };
    }
  }

  return { ok: true, sanitizedMaster, sanitizedMappingColumns };
}
