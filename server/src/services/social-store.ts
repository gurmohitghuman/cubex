// A social research table's record (social_research, migration 071): reading
// it, and the view the app, /api/v1 and MCP show. A table in the trash reads
// as gone, as every other reader of a table does.
import { db } from '../lib/db';
import type { Platform } from '../lib/social/platforms';
import type { SocialStep } from '../lib/social/names';

export interface SocialRecord {
  id: string; user_id: string; table_id: string; searches_sheet_id: string; comments_sheet_id: string | null;
  posts_sheets: string; topic: string; steps: string; min_views: number | null; min_comments: number | null;
  posted_within_days: number | null; created_at: string;
}

export interface SocialView {
  id: string; table_id: string; topic: string; searches_sheet_id: string; comments_sheet_id: string | null;
  posts_sheets: Partial<Record<Platform, string>>; steps: SocialStep[];
  filters: { min_views: number | null; min_comments: number | null; posted_within_days: number | null };
  created_at: string;
}

// A table's record by its id, or by the id of one of its sheets (what get_workspace (all_tables) shows, so an agent
// that
// didn't keep the id finds it again); not one in the trash.
export const loadSocial = (userId: string, id: string): SocialRecord | undefined =>
  db.prepare(`SELECT r.* FROM social_research r JOIN tables t ON t.id = r.table_id AND t.user_id = r.user_id
    WHERE r.user_id = ? AND t.trash_id IS NULL AND (r.id = ? OR r.searches_sheet_id = ? OR r.comments_sheet_id = ?
      OR EXISTS (SELECT 1 FROM json_each(r.posts_sheets) WHERE value = ?)) ORDER BY r.created_at LIMIT 1`)
    .get(userId, id, id, id, id) as SocialRecord | undefined;

// The record a table was made with, by the table (a table holds at most one).
export const socialOfTable = (userId: string, tableId: string): SocialRecord | undefined =>
  db.prepare('SELECT * FROM social_research WHERE table_id = ? AND user_id = ? ORDER BY created_at LIMIT 1')
    .get(tableId, userId) as SocialRecord | undefined;

// The record a sheet belongs to (its Searches, a Posts sheet or Comments), for the app's guide above the grid.
export const socialForSheet = (userId: string, sheetId: string): SocialRecord | undefined =>
  db.prepare(`SELECT * FROM social_research WHERE user_id = ? AND (searches_sheet_id = ? OR comments_sheet_id = ?
    OR EXISTS (SELECT 1 FROM json_each(posts_sheets) WHERE value = ?)) ORDER BY created_at LIMIT 1`)
    .get(userId, sheetId, sheetId, sheetId) as SocialRecord | undefined;

export function sheetLive(userId: string, sheetId: string | null): boolean {
  return !!sheetId && !!db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .get(sheetId, userId);
}

export const postsSheetsOf = (r: SocialRecord): Partial<Record<Platform, string>> => JSON.parse(r.posts_sheets);

export function socialView(r: SocialRecord): SocialView {
  return {
    id: r.id, table_id: r.table_id, topic: r.topic, searches_sheet_id: r.searches_sheet_id,
    comments_sheet_id: r.comments_sheet_id, posts_sheets: postsSheetsOf(r), steps: JSON.parse(r.steps),
    filters: { min_views: r.min_views, min_comments: r.min_comments, posted_within_days: r.posted_within_days },
    created_at: r.created_at,
  };
}
