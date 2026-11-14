// What an MCP tool error adds so the agent knows what to send next (error-answers.ts applies it): for an
// unknown sheet, table, column, run or setup, the close matches among the caller's own (names and ids,
// from bounded reads: next-step-lookups.ts), or that it is in the trash; and the tool that lists them.
// The message the tool gave stays as it was, at the start. An error that matches no case, or whose value
// turns out to exist (the error came from something else), is left as it was.
import { closeMatches } from '../lib/close-matches';
import { isPristineSeedSheet } from '../services/transfer-seed';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import {
  hasSetup, hasSheet, hasTable, liveSheets, liveTables, recentRunIds, runOf, savedSetups, setupColumns,
  sheetInTrash, storedColumns, tableInTrash, type InTrash, type RunKind,
} from './next-step-lookups';

type Args = Record<string, unknown>;

// A value as the message shows it: quoted, and cut when long (a call can send anything).
const shown = (v: string) => JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
const list = (items: string[]) => items.join(', ');
const namesATool = new RegExp(`\\b(${Object.keys(TOOL_ANNOTATIONS).join('|')})\\b`);
// The tool sentence, unless the message already names a tool.
const listedBy = (message: string, sentence: string) => (namesATool.test(message) ? '' : ` ${sentence}`);

// How many unknown names of one error get close matches: the work stays small whatever the call sent.
export const SUGGESTED_NAMES = 5;

const inTrash = (what: string, t: InTrash) => ` It is ${what} ${shown(t.name)}`
  + `${t.table !== undefined ? ` (table ${shown(t.table)})` : ''}, which is in the trash`
  + `${t.trash_ids.length > 1 ? ', and so is its table' : ''}: restore_from_trash with trash_ids `
  + `[${t.trash_ids.join(', ')}] brings ${t.trash_ids.length > 1 ? 'them' : 'it'} back.`;

function sheet(userId: string, args: Args, message: string): string | null {
  const key = ['sheet_id', 'source_sheet_id', 'destination_sheet_id']
    .find(k => typeof args[k] === 'string' && !hasSheet(userId, args[k] as string));
  if (!key) return null;
  const given = args[key] as string;
  const trashed = sheetInTrash(userId, given);
  if (trashed) return inTrash('sheet', trashed);
  const close = closeMatches(given, liveSheets(userId), s => [s.name, s.id]);
  return ` No sheet has the ${key} ${shown(given)}.`
    + (close.length ? ` Close matches: ${list(close.map(s =>
      `${shown(s.name)} (sheet_id ${shown(s.id)}, table ${shown(s.table)})`))}.` : '')
    + listedBy(message, 'list_tables lists every table and sheet with their ids.');
}

function table(userId: string, args: Args, message: string): string | null {
  const given = args.table_id;
  if (typeof given !== 'string' || hasTable(userId, given)) return null;
  const trashed = tableInTrash(userId, given);
  if (trashed) return inTrash('table', trashed);
  const close = closeMatches(given, liveTables(userId), t => [t.name, t.id]);
  return ` No table has the table_id ${shown(given)}.`
    + (close.length ? ` Close matches: ${list(close.map(t => `${shown(t.name)} (table_id ${shown(t.id)})`))}.` : '')
    + listedBy(message, 'list_tables lists every table with its id.');
}

// The column names a message quotes ("Emial", /Emial) or lists after "Unknown column(s):".
function columnsNamed(message: string): string[] {
  const quoted = [...message.matchAll(/"([^"]{1,200})"|(?:reads|named) \/(\S+?)[,.]?(?:\s|$)/g)]
    .map(m => m[1] ?? m[2]);
  const listed = /Unknown columns?(?:\(s\))?: ([^.]+)/i.exec(message)?.[1].split(', ')
    .map(n => n.replace(/^"|"$/g, '')) ?? [];
  return [...new Set([...quoted, ...listed])];
}

function column(userId: string, args: Args, message: string): string | null {
  // Already suggesting, or about another sheet's columns ("isn't a column of "Leads"").
  if (/Did you mean|column of "/.test(message) || typeof args.sheet_id !== 'string') return null;
  const columns = storedColumns(userId, args.sheet_id);
  if (!columns) return listedBy(message, 'get_sheet lists the sheet\'s columns.') || null;
  const have = new Set(columns);
  const missing = columnsNamed(message).filter(n => !have.has(n)).slice(0, SUGGESTED_NAMES);
  const close = missing.flatMap(n => {
    const near = closeMatches(n, columns, c => [c]);
    return near.length ? [`${list(near.map(shown))} for ${shown(n)}`] : [];
  });
  const sentence = listedBy(message, 'get_sheet lists the sheet\'s columns.');
  return close.length || sentence ? `${close.length ? ` Close matches: ${list(close)}.` : ''}${sentence}` : null;
}

// transfer_rows with column_mode require_existing, sending a column the destination doesn't have: the close
// ones it has, and the three ways on (only its columns, a mapping, or making the column). A brand-new sheet
// (only the starter column and its blank rows) takes none of its columns as they are: only making them works.
function destinationColumn(userId: string, args: Args, message: string): string | null {
  const named = /^Unknown destination column: (.+)$/.exec(message.trim())?.[1];
  if (named === undefined || typeof args.destination_sheet_id !== 'string') return null;
  if (isPristineSeedSheet(args.destination_sheet_id, userId)) {
    return ' The destination is a new, empty sheet: column_mode "create_missing" adds the columns.';
  }
  const close = closeMatches(named, storedColumns(userId, args.destination_sheet_id) ?? [], c => [c]);
  return (close.length ? ` Close matches in the destination: ${list(close.map(shown))}.` : '')
    + ' To copy only the columns it has, list them in columns (or send this one to another with column_mapping);'
    + ' column_mode "create_missing" adds it.';
}

const RUN_WORDS: Record<RunKind, string> = {
  ai: 'an AI run', http: 'an HTTP API run', enrichment: 'an enrichment run', waterfall: 'a waterfall run',
};
// The run_type a get_run_status or control_run call takes for a run of this kind: http finds all three.
const fits = (asked: unknown, kind: RunKind) => asked === kind || (asked === 'http' && kind !== 'ai');

function run(userId: string, args: Args, message: string): string | null {
  const given = args.run_id;
  if (typeof given !== 'string') return null;
  const found = runOf(userId, given);
  if (found) {
    if (args.run_type === undefined || fits(args.run_type, found.kind)) return null;
    return ` run_id ${shown(given)} is ${RUN_WORDS[found.kind]}: call again with run_type "${found.kind}".`;
  }
  const close = closeMatches(given, recentRunIds(userId), id => [id]).map(id => runOf(userId, id)!).filter(Boolean);
  return ` No run has the run_id ${shown(given)}.`
    + (close.length ? ` Close matches: ${list(close.map(r => `${shown(r.id)} (${RUN_WORDS[r.kind]}`
      + `${r.column ? ` filling ${shown(r.column)}` : ''}${r.sheet ? ` on ${shown(r.sheet)}` : ''})`))}.` : '')
    + listedBy(message, 'list_runs lists a sheet\'s runs, newest first.');
}

// apply_setup's names key a column the setup doesn't make: the close ones it makes, or that it is one the
// setup reads (an input, which inputs picks the column for).
function setupColumn(userId: string, args: Args, message: string): string | null {
  const named = /^This setup makes no column named "([^"]*)"/.exec(message)?.[1];
  const columns = typeof args.setup_id === 'string' ? setupColumns(userId, args.setup_id) : null;
  if (named === undefined || !columns) return null;
  let why = '';
  if (columns.reads.includes(named)) {
    why = ` ${shown(named)} is a column it reads (inputs picks which column of the sheet), not one it makes.`;
  } else {
    const close = closeMatches(named, columns.makes, c => [c]);
    if (close.length) why = ` Close matches: ${list(close.map(shown))}.`;
  }
  return `${why}${listedBy(message, 'list_setups with setup_id lists the columns each step makes.')}`;
}

function setup(userId: string, args: Args, message: string): string | null {
  const given = args.setup_id;
  if (typeof given !== 'string' || hasSetup(userId, given)) return null;
  const close = closeMatches(given, savedSetups(userId), s => [s.name, s.id]);
  return ` No saved setup has the setup_id ${shown(given)}.`
    + (close.length ? ` Close matches: ${list(close.map(s => `${shown(s.name)} (setup_id ${shown(s.id)})`))}.` : '')
    + listedBy(message, 'list_setups lists the saved setups with their ids.');
}

// The box each scope is in where a token is made (client AccessTokenCreateModal).
const SCOPE_BOX: Record<string, string> = { read: 'Read', write: 'Write', run: 'Run', secrets: 'Use saved API keys' };
const NEEDS_SCOPE = /(?:requires|needs) the (?:token's )?['"](read|write|run|secrets)['"] scope/;
function scope(_userId: string, _args: Args, message: string): string | null {
  const asked = NEEDS_SCOPE.exec(message)?.[1];
  if (!asked || message.includes('Agent access')) return null;
  return ' A token\'s scopes are set when it is made: the user can make a token with '
    + `${SCOPE_BOX[asked]} ticked in Cubex (Settings, then Agent access) and connect with it.`;
}

// Each case: what the message starts with or holds, and what it adds. The first that adds something wins.
const CASES: Array<[RegExp, (userId: string, args: Args, message: string) => string | null]> = [
  [NEEDS_SCOPE, scope],
  [/^(Source or destination sheet|Sheet) not found/, sheet],
  [/^Table not found/, table],
  [/^Setup not found/, setup],
  [/^(AI |HTTP |Enrichment |Waterfall )?[Rr]un not found/, run],
  // The setup's columns, never the sheet's: the column case below leaves this message out.
  [/^This setup makes no column named/, setupColumn],
  [/^Unknown destination column: /, destinationColumn],
  [/^(?!This setup makes)(?=.*column)(?=.*(not found|isn't a column|no column named|unknown column))/is, column],
  [/^Setup run not found/, (_u, _a, m) => listedBy(m, 'get_setup_run with sheet_id lists the setup runs on a sheet.')],
  [/^Run webhook not found/, (_u, _a, m) => listedBy(m, 'list_run_webhooks lists the webhooks with their ids.')],
  [/^Setup version not found/, (_u, _a, m) => listedBy(m, 'list_setup_versions lists a sheet\'s versions.')],
  [/^View not found/, (_u, _a, m) => listedBy(m, 'get_sheet lists the sheet\'s views.')],
  [/^(Row not found|One or more rows were not found)/,
    (_u, _a, m) => listedBy(m, 'read_rows gives the sheet\'s row ids; list_trash shows deleted rows.')],
];

// The message with its next step added, or as it was.
export function withNextStep(userId: string, args: unknown, message: string): string {
  const input = args && typeof args === 'object' ? args as Args : {};
  for (const [test, add] of CASES) {
    if (!test.test(message)) continue;
    const more = add(userId, input, message);
    if (!more) continue;
    const said = message.trimEnd();
    return `${said.endsWith('.') ? said : `${said}.`}${more}`;
  }
  return message;
}
