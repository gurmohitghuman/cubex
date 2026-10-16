// A setup as a file, to move it to another Cubex: export writes the steps,
// inputs and the names of the saved keys it uses (a saved key's value never
// leaves; the other Cubex needs keys by those names). A request with a key
// typed straight into it is refused (lib/setups/typed-key.ts): the file would
// carry the key. Import checks the whole file (lib/setups/check.ts), refuses
// a typed key too, and adds " (2)" to a name already taken.
import { MAX_SETUP_SPEC_BYTES, SETUP_FILE_FORMAT, SETUP_FILE_VERSION } from '../lib/constants-setups';
import { readSpec, stepLabel } from '../lib/setups/check';
import { columnLookup } from '../lib/setups/refs';
import { specColumns } from '../lib/setups/remap';
import type { SetupSpec } from '../lib/setups/spec';
import { typedKeyIn } from '../lib/setups/typed-key';
import { getSetup, insertSetup, setupDescription, setupName, type SetupDetail } from './setup-library';
import type { RunFail } from './run-shared';

export interface SetupFile {
  format: typeof SETUP_FILE_FORMAT; version: number; name: string; description: string | null; spec: SetupSpec;
}

// The first key typed into one of the setup's requests: where, or null.
// Saving refuses one already; this keeps a setup imported or stored before that from leaving with one.
export function typedKey(spec: SetupSpec): string | null {
  const find = columnLookup(specColumns(spec));
  const keys = new Set(spec.keys);
  const resolves = (name: string) => find.template(name) !== undefined || keys.has(name);
  for (const s of spec.steps) {
    const where = s.kind === 'http' ? typedKeyIn(s.request, resolves) : null;
    if (where) return `${stepLabel(s)}: the ${where}`;
  }
  return null;
}

export function exportSetup(userId: string, id: string): { ok: { file: SetupFile; filename: string } } | RunFail {
  const setup = getSetup(userId, id);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  const typed = typedKey(setup.spec);
  if (typed) {
    return {
      fail: 'bad_request',
      message: `A key is typed into ${typed}. Save it in Settings as an external service key, write {{its name}} in `
        + 'the request instead, then export again: the file would otherwise carry the key.',
    };
  }
  const slug = setup.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'setup';
  return {
    ok: {
      file: { format: SETUP_FILE_FORMAT, version: SETUP_FILE_VERSION, name: setup.name,
        description: setup.description, spec: setup.spec },
      filename: `${slug}.cubex-setup.json`,
    },
  };
}

export function importSetup(userId: string, raw: unknown): { ok: SetupDetail } | RunFail {
  const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
  const f = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (f.format !== SETUP_FILE_FORMAT) return bad('This isn\'t a Cubex setup file.');
  if (f.version !== SETUP_FILE_VERSION) {
    return bad('This setup file comes from a newer Cubex. Update Cubex, then import it.');
  }
  const name = setupName(f.name);
  if (typeof name !== 'string') return name;
  const description = setupDescription(f.description);
  if (description !== null && typeof description !== 'string') return description;
  // The size first: checking a setup costs more the bigger it is.
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(f.spec ?? null));
  } catch {
    return bad('This setup file can\'t be read.');
  }
  if (size > MAX_SETUP_SPEC_BYTES) {
    return bad(`This setup file is too big (over ${Math.round(MAX_SETUP_SPEC_BYTES / 1024)} KB).`);
  }
  const spec = readSpec(f.spec);
  if ('problem' in spec) return bad(`This setup file can't be used: ${spec.problem}`);
  const typed = typedKey(spec.ok);
  if (typed) return bad(`This setup file can't be used: a key is typed into ${typed}.`);
  return insertSetup(userId, name, description, spec.ok, true);
}
