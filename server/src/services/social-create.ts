// A social research table: one implementation for the app, /api/v1 and MCP.
// A new table "Social: <topic>" with a Searches sheet (one row per search, and
// "<Platform> posts found" per platform: a list set up and not run that adds
// the posts it finds to that platform's sheet, keeping the ones found before),
// a "<Platform> posts" sheet per platform (the fields its search gives, its
// free formulas, and the steps picked, set up and not run: transcript, the AI
// breakdown, the creator, comments), a Comments sheet when comments are
// picked (with an AI reaction tag, set up and not run), and a Top posts view
// on each Posts sheet when the table has filters. Nothing that costs money
// runs: Find posts takes the person's click or an agent's call
// (services/social-find.ts). Each run is checked against treg's catalog
// first, then everything goes in one transaction. It is an ordinary table:
// deleting it puts it in the trash. Its History opens with "Made the social research table".
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { appendColumnsToOrder } from '../lib/sql-helpers';
import { createSheetTxn } from '../lib/sheet-crud-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { logSheetChange, withoutChangeLog } from '../lib/change-log';
import { MAX_COLUMNS_PER_SHEET, MAX_TABLE_NAME_LENGTH } from '../lib/constants';
import { nowDate } from '../lib/clock';
import {
  COLUMN_WORDS, COMMENT_COLUMNS as C, POST_COLUMNS as P, SEARCH_COLUMNS, SHEET_WORDS, SOCIAL_SHEETS, STEP_COLUMNS as S,
  foundColumn, postsSheetName, socialTableBase,
} from '../lib/social/names';
import { PLATFORM_SPECS, postColumns, type Platform } from '../lib/social/platforms';
import type { SocialInput } from '../lib/social/input';
import { createTable } from './table-crud';
import { appendRows } from './rows-write';
import { buildSocialRuns, type PlatformRuns } from './social-steps';
import {
  BREAKDOWN_OUTPUTS, BREAKDOWN_STATUS, REACTION_OUTPUT, sinceDay, topPostsWhere, writeBreakdown, writeFormulas,
  writeListColumn, writeReaction, writeStepColumn, writeTopPosts,
} from './social-write';
import type { RunFail } from './run-shared';

export interface SocialTable {
  id: string; tableId: string; tableName: string; searchesSheetId: string; commentsSheetId: string | null;
  postsSheets: Partial<Record<Platform, string>>; searches: number;
}

const COMMENT_SHEET_COLUMNS = [C.post, C.platform, C.author, C.text, C.likes, C.replies];

// A platform's Posts columns: its search's, its formulas, then each step picked.
export function postsColumnsOf(platform: Platform, input: SocialInput): string[] {
  const spec = PLATFORM_SPECS[platform];
  const has = (s: string) => input.steps.includes(s as SocialInput['steps'][number]);
  const creator = has('creator') && spec.creator ? [S.creator, ...spec.creator.outputs.map(o => o.columnName)] : [];
  return [...new Set([
    ...postColumns(spec),
    ...(has('transcript') ? [S.transcript, S.transcriptText] : []),
    ...(has('breakdown') ? [BREAKDOWN_STATUS, ...BREAKDOWN_OUTPUTS] : []),
    ...creator,
    ...(has('comments') ? [S.commentsFound] : []),
  ])];
}

function freeTableName(userId: string, topic: string): string {
  const base = socialTableBase(topic, MAX_TABLE_NAME_LENGTH - 4);
  const taken = db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND name = ? AND trash_id IS NULL LIMIT 1');
  let name = base;
  for (let n = 2; taken.get(userId, name); n++) name = `${base} ${n}`;
  return name;
}

function newSheet(tableId: string, userId: string, name: string, after: string, columns: string[]): string {
  const made = createSheetTxn(tableId, userId, name, after, { seed: false });
  if (!made.ok) throw new Error(`The ${name} sheet could not be made.`);
  appendColumnsToOrder(made.sheetId, userId, columns);
  return made.sheetId;
}

function describe(sheetId: string, userId: string, words: string, columns: string[]): void {
  db.prepare('UPDATE sheets SET description = ? WHERE id = ? AND user_id = ?').run(words, sheetId, userId);
  for (const c of columns) {
    const text = (COLUMN_WORDS as Record<string, string>)[c];
    if (text) writeColumnDescription(sheetId, userId, c, text);
  }
}

function makeTable(userId: string, input: SocialInput, runs: PlatformRuns[], cols: Record<Platform, string[]>):
  Omit<SocialTable, 'searches'> | RunFail {
  return db.transaction((): Omit<SocialTable, 'searches'> | RunFail => {
    const made = withoutChangeLog(() => createTable(userId, freeTableName(userId, input.topic)));
    if ('fail' in made) return { fail: 'bad_request', message: made.message };
    const { id: tableId, name: tableName, sheetId: searches } = made.ok;
    const labels = input.platforms.map(p => PLATFORM_SPECS[p].label);
    logSheetChange(searches, userId, 'social_created', `Made the social research table for "${input.topic}": `
      + `${labels.join(', ')}`, { detail: { topic: input.topic, searches: input.searches, platforms: input.platforms,
      steps: input.steps } });
    db.prepare('UPDATE sheets SET name = ? WHERE id = ? AND user_id = ?').run(SOCIAL_SHEETS.searches, searches, userId);
    appendColumnsToOrder(searches, userId, [SEARCH_COLUMNS.words, ...labels.map(foundColumn)]);
    describe(searches, userId, SHEET_WORDS.searches, []);
    const rows = appendRows(searches, userId, input.searches.map(s => ({ [SEARCH_COLUMNS.words]: s })));
    if ('fail' in rows) throw new Error(`The searches didn't go in: ${rows.fail}`);

    let after = searches;
    const postsSheets: Partial<Record<Platform, string>> = {};
    for (const r of runs) {
      const spec = PLATFORM_SPECS[r.platform];
      const sheet = newSheet(tableId, userId, postsSheetName(spec.label), after, cols[r.platform]);
      after = postsSheets[r.platform] = sheet;
      describe(sheet, userId, SHEET_WORDS.posts(spec.label), cols[r.platform]);
    }
    const comments = runs.some(r => r.comments)
      ? newSheet(tableId, userId, SOCIAL_SHEETS.comments, after, [...COMMENT_SHEET_COLUMNS, REACTION_OUTPUT]) : null;
    if (comments) describe(comments, userId, SHEET_WORDS.comments, []);

    const today = nowDate().toISOString().slice(0, 10);
    const since = input.postedWithinDays === null ? null : sinceDay(today, input.postedWithinDays);
    for (const r of runs) {
      const spec = PLATFORM_SPECS[r.platform], sheet = postsSheets[r.platform]!;
      writeListColumn(userId, searches, sheet, r.search, `The ${spec.label} search`);
      writeFormulas(userId, sheet, spec);
      if (r.transcript) writeStepColumn(userId, sheet, r.transcript, `${spec.label} transcripts`);
      if (input.steps.includes('breakdown')) writeBreakdown(userId, sheet, spec, !!r.transcript);
      if (r.creator) writeStepColumn(userId, sheet, r.creator, `${spec.label} creators`);
      if (r.comments) writeListColumn(userId, sheet, comments!, r.comments, `${spec.label} comments`);
      writeTopPosts(userId, sheet, topPostsWhere({ minViews: input.minViews, minComments: input.minComments, since },
        cols[r.platform]));
    }
    if (comments) writeReaction(userId, comments);

    const id = uuidv4();
    db.prepare(`INSERT INTO social_research (id, user_id, table_id, searches_sheet_id, comments_sheet_id, posts_sheets,
        topic, steps, min_views, min_comments, posted_within_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, tableId, searches, comments, JSON.stringify(postsSheets), input.topic,
        JSON.stringify(input.steps), input.minViews, input.minComments, input.postedWithinDays);
    return { id, tableId, tableName, searchesSheetId: searches, commentsSheetId: comments, postsSheets };
  }).immediate();
}

export async function createSocialTable(userId: string, input: SocialInput): Promise<{ ok: SocialTable } | RunFail> {
  const cols = Object.fromEntries(input.platforms.map(p => [p, postsColumnsOf(p, input)])) as
    Record<Platform, string[]>;
  const widest = Math.max(...Object.values(cols).map(c => c.length), COMMENT_SHEET_COLUMNS.length + 1);
  if (widest > MAX_COLUMNS_PER_SHEET) {
    return { fail: 'bad_request', message: `This Cubex allows ${MAX_COLUMNS_PER_SHEET} columns per sheet, too few.` };
  }
  const runs = await buildSocialRuns(input, cols);
  if ('fail' in runs) return runs;
  let made: Omit<SocialTable, 'searches'> | RunFail;
  try {
    made = makeTable(userId, input, runs.ok, cols);
  } catch (err) {
    return { fail: 'bad_request', message: (err as Error).message };
  }
  if ('fail' in made) return made;
  return { ok: { ...made, searches: input.searches.length } };
}
