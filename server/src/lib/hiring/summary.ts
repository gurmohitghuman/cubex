// A company's summary row (pure): its roles folded one by one, in the order
// the Roles sheet holds them (oldest first), into what Companies shows: how
// many, the first few titles, the newest posting day, links to the newest
// roles, and what's new since the check before. Bounded per company whatever
// its number of roles.
import { HIRING_LINKS_SHOWN, HIRING_NEW_TITLES_SHOWN, HIRING_TITLES_SHOWN } from '../constants';
import { COMPANY_COLUMNS } from './names';

export interface RoleSeen { title: string; company: string; posted: string; link: string; isNew: boolean }

export interface CompanyAcc {
  name: string; domain: string; count: number; newCount: number;
  titles: string[];       // distinct, at most HIRING_TITLES_SHOWN + 1 (one more: "…")
  newTitles: string[];    // the same, of the new roles
  newest: string;         // YYYY-MM-DD, or ''
  links: string[];        // the newest few, newest last
}

export const newAcc = (domain: string): CompanyAcc =>
  ({ name: '', domain, count: 0, newCount: 0, titles: [], newTitles: [], newest: '', links: [] });

// "2026-11-13", from "2026-11-13", "2026-11-13T23:16:55+00:00" or "2026-08-19T20:01:53Z"; '' when it isn't a date.
export function postedDay(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

function addTitle(list: string[], title: string, shown: number): void {
  if (!title || list.length > shown) return;
  if (!list.some(t => t.toLowerCase() === title.toLowerCase())) list.push(title);
}

export function addRole(acc: CompanyAcc, r: RoleSeen): void {
  acc.count++;
  if (!acc.name && r.company) acc.name = r.company;
  addTitle(acc.titles, r.title, HIRING_TITLES_SHOWN);
  const day = postedDay(r.posted);
  if (day > acc.newest) acc.newest = day;
  if (r.link && !acc.links.includes(r.link)) {
    acc.links.push(r.link);
    if (acc.links.length > HIRING_LINKS_SHOWN) acc.links.shift();
  }
  if (r.isNew) {
    acc.newCount++;
    addTitle(acc.newTitles, r.title, HIRING_NEW_TITLES_SHOWN);
  }
}

// One company's roles that came in under its name, joined to the same company found by domain.
export function mergeAcc(into: CompanyAcc, from: CompanyAcc): void {
  into.count += from.count;
  into.newCount += from.newCount;
  if (!into.name) into.name = from.name;
  for (const t of from.titles) addTitle(into.titles, t, HIRING_TITLES_SHOWN);
  for (const t of from.newTitles) addTitle(into.newTitles, t, HIRING_NEW_TITLES_SHOWN);
  if (from.newest > into.newest) into.newest = from.newest;
  for (const l of from.links) if (!into.links.includes(l)) into.links.push(l);
  into.links.splice(0, Math.max(0, into.links.length - HIRING_LINKS_SHOWN));
}

const shownList = (list: string[], shown: number): string =>
  (list.length > shown ? `${list.slice(0, shown).join(', ')}, …` : list.join(', '));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Nov 11" (with the year when it isn't `thisYear`'s).
export function shortDay(day: string, thisYear: string): string {
  const [y, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!month || !d) return day;
  return `${month} ${Number(d)}${y === thisYear ? '' : `, ${y}`}`;
}

// "New since Nov 11: 2 roles (SDR, BDR)"; '' with nothing new.
export function newSinceText(acc: CompanyAcc, sinceLabel: string, label: string): string {
  if (acc.newCount === 0) return '';
  const n = `${acc.newCount.toLocaleString('en-US')} role${acc.newCount === 1 ? '' : 's'}`;
  const titles = shownList(acc.newTitles, HIRING_NEW_TITLES_SHOWN);
  return `New since ${shortDay(sinceLabel, label.slice(0, 4))}: ${n}${titles ? ` (${titles})` : ''}`;
}

// The cells a check writes on a company's row. sinceLabel null: the table's
// first check, where nothing is "new" (every company is). acc null: the
// company has no roles left in Roles.
export function companyCells(
  acc: CompanyAcc | null, check: { label: string; sinceLabel: string | null },
): Record<string, string> {
  const a = acc ?? newAcc('');
  const fresh = check.sinceLabel !== null && a.newCount > 0;
  return {
    [COMPANY_COLUMNS.openRoles]: String(a.count),
    [COMPANY_COLUMNS.titles]: shownList(a.titles, HIRING_TITLES_SHOWN),
    [COMPANY_COLUMNS.newest]: a.newest,
    [COMPANY_COLUMNS.links]: [...a.links].reverse().join('\n'),
    [COMPANY_COLUMNS.newSince]: fresh ? newSinceText(a, check.sinceLabel!, check.label) : '',
    [COMPANY_COLUMNS.newRoles]: fresh ? String(a.newCount) : '',
  };
}

// A new company's row: its name and domain, the day it was first seen, and its summary.
export function newCompanyRow(
  acc: CompanyAcc, check: { label: string; sinceLabel: string | null },
): Record<string, string> {
  return {
    [COMPANY_COLUMNS.company]: acc.name, [COMPANY_COLUMNS.domain]: acc.domain,
    ...companyCells(acc, check), [COMPANY_COLUMNS.firstSeen]: check.label,
  };
}
