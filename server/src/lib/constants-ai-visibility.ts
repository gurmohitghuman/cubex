// AI visibility tables (services/ai-visibility-*.ts, lib/ai-visibility/).
// A new table starts with at most this many questions (more rows can come later).
export const AI_VISIBILITY_MAX_QUESTIONS = 100;
export const AI_VISIBILITY_MAX_QUESTION_CHARS = 2_000;
// Brands to look for in the answers, besides your own; each name's length.
// The longest formula holds the list once and must stay under FORMULA_MAX_CHARS.
export const AI_VISIBILITY_MAX_COMPETITORS = 20;
export const AI_VISIBILITY_MAX_BRAND_CHARS = 60;
// Cited sources an engine's answer adds as rows, per question.
export const AI_VISIBILITY_SOURCES_PER_ROW = 20;
// Checking again sooner than this after the answers kept were asked says that
// answers move slowly and vary between asks (a warning, never a refusal).
export const AI_VISIBILITY_CHECK_SOON_DAYS = 21;
// A check copies the questions once its formula and lookup columns (Named by) have caught up with the answers,
// looking this often, for at most this long (the auto-run sweep that follows a run worker's answers comes every
// 15 s); past that it copies them as they are.
export const AI_VISIBILITY_CATCH_UP_POLL_MS = 200;
export const AI_VISIBILITY_CATCH_UP_MS = 60_000;
