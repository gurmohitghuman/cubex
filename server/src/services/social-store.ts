// A social research table's record (social_research, migration 071): reading
// it, and the view the app, /api/v1 and MCP show. A sheet of it in the trash
// reads as gone (null), as every other reader of a sheet does.
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

export const loadSocial = (userId: string, id: string): SocialRecord | undefined =>
  db.prepare('SELECT * FROM social_research WHERE id = ? AND user_id = ?').get(id, userId) as SocialRecord | undefined;

// The record a table was made with, by the table (a table holds at most one).
export const socialOfTable = (userId: string, tableId: string): SocialRecord | undefined =>
  db.prepare('SELECT * FROM social_research WHERE table_id = ? AND user_id = ? ORDER BY created_at LIMIT 1')
    .get(tableId, userId) as SocialRecord | undefined;

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
