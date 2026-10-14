// The agents' side of "Paste a cURL command": run_http_enrichment (MCP) and
// POST /api/v1/sheets/:id/http-runs take `curl` in place of url, method, headers
// and body. Same rule as the dialog: a key in the command never lands in the
// column's setup. An agent can't answer the dialog's question, so `save_keys` is
// its answer: true saves each key under the suggested name (a key already saved
// with that value is used instead), { "<where>": "<name>" } names every key.
// Saving and using keys needs the 'secrets' scope. A token can create a saved
// key this way, never read or change one.
import { parseBooleanOption } from '../lib/web-search-options';
import type { KeyChoice } from '../lib/curl/key-apply';
import type { KeyFinding } from '../lib/curl/key-detect';
import { commitCurlKeys, planCurl, prepareCurl, type CurlPlan, type PreparedCurl } from './curl-import';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { checkRunRule } from './run-rule';
import type { RunFail } from './run-shared';

export interface TokenCurl { plan: CurlPlan; prepared: PreparedCurl }

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export function curlForToken(
  caller: { userId: string; scopes: Set<string> }, sheetId: string, curl: unknown, saveKeys: unknown,
): { ok: TokenCurl } | RunFail {
  const names = parseSaveKeys(saveKeys);
  if ('fail' in names) return names;
  const secrets = caller.scopes.has('secrets');
  const planned = planCurl(caller.userId, sheetId, curl, { matchSaved: secrets });
  if ('fail' in planned) return planned;
  const plan = planned.ok;
  const missing = plan.findings.find(f => f.kind === 'missing');
  if (missing) return bad(missingMessage(missing));
  const choices: Record<string, KeyChoice> = {};
  if (plan.findings.length > 0) {
    // The scope first: the messages after this one can name saved keys.
    if (!secrets) {
      return {
        fail: 'forbidden',
        message: `This cURL command has keys in it (${plan.findings.map(f => f.where).join(', ')}). `
          + "Saving or using them needs the token's 'secrets' scope.",
      };
    }
    if (names.ok === false) return bad(saveKeysNeeded(plan));
    if (names.ok !== true) {
      const map = names.ok;
      const labels = new Set(plan.findings.flatMap(f => [f.where, f.id]));
      const stray = Object.keys(map).find(k => !labels.has(k));
      if (stray !== undefined) {
        return bad(`save_keys names "${stray.slice(0, 80)}", which isn't a key in this command. `
          + `Its keys: ${plan.findings.map(f => f.where).join(', ')}.`);
      }
      const unnamed = plan.findings.filter(f => map[f.where] === undefined && map[f.id] === undefined);
      if (unnamed.length > 0) {
        return bad(`save_keys as an object names every key: add ${unnamed.map(f => `"${f.where}"`).join(', ')}, `
          + 'or pass save_keys: true for the suggested names.');
      }
    }
    plan.findings.forEach((f, i) => {
      const named = names.ok === true ? undefined : (names.ok as Record<string, string>)[f.where]
        ?? (names.ok as Record<string, string>)[f.id];
      const existing = plan.existing[i];
      choices[f.id] = !named && existing ? { use: existing } : { save: named ?? plan.suggested[i] };
    });
  }
  const prepared = prepareCurl(plan, choices);
  if ('fail' in prepared) return prepared;
  return { ok: { plan, prepared: prepared.ok } };
}

// Before a start saves any key: the keys' own name clashes, then (unless only
// estimating) what the start would refuse anyway: its "Only run if" rule, its
// output columns, a busy sheet. So a refused start leaves no key behind. Writes nothing.
export function curlStartProblem(
  userId: string, sheetId: string, t: TokenCurl, mapping: Array<{ jsonPath: string; columnName: string }>,
  master: string | undefined, runIf: string | undefined, estimateOnly: boolean,
): RunFail | null {
  if (t.prepared.keys.length === 0) return null;
  const dry = commitCurlKeys(userId, t.plan, t.prepared.keys, true);
  if ('fail' in dry) return dry;
  if (estimateOnly) return null;
  const rule = checkRunRule(sheetId, userId, runIf ?? null);
  if ('error' in rule) return bad(rule.error);
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const columns = validateHttpRunColumns(sheetId, userId, mapping.map(m => ({ ...m })), master, true);
  return columns.ok ? null : bad(columns.error ?? 'The response columns are not valid.');
}

function parseSaveKeys(v: unknown): { ok: boolean | Record<string, string> } | RunFail {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.every(([, name]) => typeof name === 'string')) {
      return { ok: Object.fromEntries(entries) as Record<string, string> };
    }
  } else {
    const flag = parseBooleanOption(v);
    if (flag !== 'invalid') return { ok: flag === true };
  }
  return bad('save_keys must be true, or an object like { "Authorization header": "openai" }.');
}

function saveKeysNeeded(plan: CurlPlan): string {
  const n = plan.findings.length;
  const list = plan.findings.map((f, i) => (
    plan.existing[i] ? `${f.where} (already saved as ${plan.existing[i]})` : f.where));
  return `This cURL command has ${n === 1 ? 'a key' : `${n} keys`} in it: ${list.join(', ')}. `
    + "Cubex never keeps a key in a column's setup. Call again with save_keys: true to save "
    + `${n === 1 ? 'it as a saved key' : 'them as saved keys'} (${plan.suggested.join(', ')}), `
    + 'or save_keys: { "<where>": "<name>" } to choose names, or write {{name}} of a key the user already saved '
    + "in its place. Saving needs the token's 'secrets' scope.";
}

function missingMessage(f: KeyFinding): string {
  if (f.basic) {
    return `The ${f.where} uses a variable or placeholder, but Basic sign-in needs the real user and password: `
      + 'put them in -u and pass save_keys: true, or send -H "Authorization: Basic {{name}}" with a saved key '
      + 'that holds base64(user:password).';
  }
  return `The ${f.where} needs a key (${f.placeholder}), and no saved key or column has that name. `
    + `Ask the user to save the key in Cubex (Settings, External service keys)${f.refName ? ` as ${f.refName}` : ''}, `
    + 'or put the key in the command and pass save_keys: true.';
}
