// Company name cleaner (pure): the name people use, without its legal form
// ("Acme, Inc." → "Acme"), recased only when it was typed all in capitals or
// all in lower case. It reads the value through nameText (emoji dropped,
// full-width letters folded) and leaves a placeholder ("n/a", "unknown") blank.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { COMPANY_WORDS, SUFFIX_UNITS, suffixKey } from './company-suffixes';
import { isPlaceholder, nameText } from './name-text';
import {
  capAfterOneLetterApostrophe, capitalize, hasLower, hasUpper, hasVowel, splitAffixes, upper,
} from './word-case';

// ", a subsidiary of Foo Inc." and the like say whom the company belongs to.
const DESCRIPTOR =
  /,\s*an?\s+(?:wholly[\s-]owned\s+)?(?:company|subsidiary|division|part|member|unit|brand)\s+of\b.*$/i;
// "(NYSE: ACM)", "(formerly Foo)", "(UK)" at the very end.
const TRAILING_PAREN = /\s*\([^()]*\)$/;

const isThe = (word: string) => suffixKey(word) === 'the';

// Whether a shortened name still holds a name: stripping never leaves
// nothing, or "The" alone ("The Limited" stays).
function hasName(name: string): boolean {
  const words = name.split(' ').filter(Boolean);
  if (words.length && isThe(words[0])) words.shift();
  return words.some(w => /[\p{L}\p{N}]/u.test(w));
}

// The longest legal-form unit the words end with.
function endingUnit(words: string[]): string[] | undefined {
  const keys = words.map(suffixKey);
  return SUFFIX_UNITS.find(u => u.length <= keys.length && u.every((k, i) => keys[keys.length - u.length + i] === k));
}

// One step off the end (descriptor, parenthetical or legal form), or null.
// keepCompanyWord: stop at a legal form with Company, Co or Corp in it.
function stripOnce(name: string, keepCompanyWord: boolean): { rest: string; companyWord: boolean } | null {
  for (const re of [DESCRIPTOR, TRAILING_PAREN]) {
    const m = re.exec(name);
    if (m && hasName(name.slice(0, m.index))) return { rest: name.slice(0, m.index), companyWord: false };
  }
  const words = name.split(' ');
  const unit = endingUnit(words);
  if (!unit) return null;
  const companyWord = unit.some(k => COMPANY_WORDS.has(k));
  if (companyWord && keepCompanyWord) return null;
  const rest = words.slice(0, words.length - unit.length).join(' ');
  return hasName(rest) ? { rest, companyWord } : null;
}

// Strips until nothing more comes off, so a second pass finds nothing:
// "Acme (UK) Ltd" loses Ltd, then (UK). The comma or period a stripped
// ending leaves behind goes too ("Acme, Inc." → "Acme"); nothing else does
// ("Yahoo!" keeps its "!").
function stripLegal(name: string, keepCompanyWord: boolean): { name: string; lostCompanyWord: boolean } {
  let lostCompanyWord = false;
  for (let step = stripOnce(name, keepCompanyWord); step; step = stripOnce(name, keepCompanyWord)) {
    name = step.rest.replace(/[\s,.]+$/, '');
    lostCompanyWord ||= step.companyWord;
  }
  return { name, lostCompanyWord };
}

const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// Where the first bracket that never closes is, or -1. A closing bracket
// closes the nearest open one of its kind (and any left open inside it).
function unclosedAt(s: string): number {
  const open: Array<{ ch: string; at: number }> = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (CLOSE[ch]) { open.push({ ch, at: i }); continue; }
    const j = open.map(o => CLOSE[o.ch]).lastIndexOf(ch);
    if (j >= 0) open.length = j;
  }
  return open.length ? open[0].at : -1;
}

// An unclosed bracket and what follows go ("ImagineSoftware (Technology
// Partners" → "ImagineSoftware"); when nothing named comes before it, what
// follows it is the name ("(Acme Corp" → "Acme Corp").
function cutUnclosed(s: string): string {
  for (let at = unclosedAt(s); at >= 0; at = unclosedAt(s)) {
    const before = s.slice(0, at);
    s = (/[\p{L}\p{N}]/u.test(before) ? before : s.slice(at + 1)).trim();
  }
  return s;
}

// Brackets and legal forms off, again until neither changes anything: cutting
// at ", a subsidiary of" can leave a bracket open, and cutting at a bracket
// can bare a legal form.
function strip(s: string, keepCompanyWord: boolean): { name: string; lostCompanyWord: boolean } {
  let lostCompanyWord = false;
  for (;;) {
    const step = stripLegal(cutUnclosed(s), keepCompanyWord);
    lostCompanyWord ||= step.lostCompanyWord;
    if (step.name === s) return { name: s, lostCompanyWord };
    s = step.name;
  }
}

const LOWER_WORDS = new Set(['of', 'and', 'the', 'for']);

// One part of a word (split on "-" and "/") of a name typed all in one case.
function recasePart(part: string): string {
  if (!hasVowel(part)) return upper(part); // HSBC, KPMG, DHL
  if (/^mc\p{L}{3}/iu.test(part)) return 'Mc' + capitalize(part.slice(2)); // McKinsey (no Mac rule: Macy's)
  return capAfterOneLetterApostrophe(capitalize(part));
}

function recaseWord(word: string, i: number, count: number): string {
  const [lead, core, trail] = splitAffixes(word);
  if (!core) return word;
  // AT&T, P&G, 3M; a one-word name of three letters or fewer is initials (IBM).
  if (/[&\p{N}]/u.test(core) || (count === 1 && /^\p{L}{1,3}$/u.test(core))) return lead + upper(core) + trail;
  if (i > 0 && LOWER_WORDS.has(core.toLowerCase())) return lead + core.toLowerCase() + trail;
  return lead + core.split(/([-/])/).map((p, j) => (j % 2 ? p : recasePart(p))).join('') + trail;
}

// What "The ... Company" becomes: strip drops both ("The Coca-Cola Company" →
// "Coca-Cola"); keep keeps both, for companies whose name is said whole ("The
// Christman Company"), while other legal forms still go.
export type TheCompany = 'strip' | 'keep';

export function cleanCompanyName(value: string, theCompany: TheCompany = 'strip'): string {
  const s = nameText(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS || isPlaceholder(s, false)) return '';
  const keep = theCompany === 'keep' && isThe(s.split(' ')[0]);
  const { name: stripped, lostCompanyWord } = strip(s, keep);
  const words = stripped.split(' ');
  // "The Coca-Cola Company" → "Coca-Cola", but "The Home Depot, Inc." keeps its The.
  if (lostCompanyWord && words.length > 1 && isThe(words[0])) words.shift();
  const name = words.join(' ');
  // Mixed case was typed on purpose: eBay, iRobot, HubSpot.
  const out = hasLower(name) && hasUpper(name) ? name : words.map((w, i) => recaseWord(w, i, words.length)).join(' ');
  // "Unknown Corp" gives "Unknown", a placeholder too.
  return isPlaceholder(out, false) ? '' : out;
}
