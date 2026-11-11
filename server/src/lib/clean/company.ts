// Company name cleaner (pure): the name people use, without its legal form
// ("Acme, Inc." → "Acme"), recased only when it was typed all in capitals or
// all in lower case. It reads the value through nameText (emoji dropped,
// full-width ASCII folded) and leaves a placeholder ("n/a", "unknown") blank.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { COMPANY_WORDS, SUFFIX_UNITS, suffixKey } from './company-suffixes';
import { cutUnclosed, dropTrailingStray, strayFlags, trimStray } from './company-brackets';
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
// nothing, or "The" alone ("The Limited" stays). A letter or digit after the
// first word, or in it unless it is "The".
function hasName(name: string): boolean {
  const s = name.trimStart();
  const space = s.indexOf(' ');
  const first = space < 0 ? s : s.slice(0, space);
  return /[\p{L}\p{N}]/u.test(isThe(first) ? s.slice(first.length) : s);
}

// The longest unit, in words: a step reads only that many words at the end,
// so stripping a long name one ending at a time stays cheap.
const LONGEST_UNIT = Math.max(...SUFFIX_UNITS.map(u => u.length));

// Where each of the last n words starts (fewer in a shorter name); words are
// one space apart (cleanTrim).
function lastWordStarts(name: string, n: number): number[] {
  const starts: number[] = [];
  for (let end = name.length; starts.length < n;) {
    const space = name.lastIndexOf(' ', end - 1);
    starts.unshift(space + 1);
    if (space <= 0) break;
    end = space;
  }
  return starts;
}

// The longest legal-form unit the words end with.
function endingUnit(words: string[]): string[] | undefined {
  const keys = words.slice(-LONGEST_UNIT).map(suffixKey);
  return SUFFIX_UNITS.find(u => u.length <= keys.length && u.every((k, i) => keys[keys.length - u.length + i] === k));
}

// One step off the end (descriptor, parenthetical or legal form), or null.
// keepCompanyWord: stop at a legal form with Company, Co or Corp in it.
function stripOnce(name: string, keepCompanyWord: boolean): { rest: string; companyWord: boolean } | null {
  for (const re of [DESCRIPTOR, TRAILING_PAREN]) {
    const m = re.exec(name);
    if (m && hasName(name.slice(0, m.index))) return { rest: name.slice(0, m.index), companyWord: false };
  }
  const starts = lastWordStarts(name, LONGEST_UNIT);
  const words = starts.map((at, i) => name.slice(at, i + 1 < starts.length ? starts[i + 1] - 1 : name.length));
  const unit = endingUnit(words);
  if (!unit) return null;
  const companyWord = unit.some(k => COMPANY_WORDS.has(k));
  if (companyWord && keepCompanyWord) return null;
  const from = starts[starts.length - unit.length];
  const rest = from === 0 ? '' : name.slice(0, from - 1);
  return hasName(rest) ? { rest, companyWord } : null;
}

// Strips until nothing more comes off, so a second pass finds nothing:
// "Acme (UK) Ltd" loses Ltd, then (UK). The comma or period a stripped
// ending leaves behind goes too ("Acme, Inc." → "Acme"), and so does a closing
// bracket that closes nothing ("Acme ) Ltd" → "Acme"); nothing else does
// ("Yahoo!" keeps its "!"). Every step cuts the end, so one reading of the
// brackets holds for each shorter name.
function stripLegal(name: string, keepCompanyWord: boolean): { name: string; lostCompanyWord: boolean } {
  let lostCompanyWord = false;
  const stray = strayFlags(name);
  for (;;) {
    name = dropTrailingStray(name, stray);
    const step = stripOnce(name, keepCompanyWord);
    if (!step) return { name, lostCompanyWord };
    name = step.rest.replace(/[\s,.]+$/, '');
    lostCompanyWord ||= step.companyWord;
  }
}

// Brackets and legal forms off, again until nothing changes: cutting at ", a
// subsidiary of" or at a legal form ("(Acme Ltd)") can leave a bracket open,
// and cutting at a bracket can bare a legal form.
function strip(s: string, keepCompanyWord: boolean): { name: string; lostCompanyWord: boolean } {
  let lostCompanyWord = false;
  for (;;) {
    const step = stripLegal(trimStray(cutUnclosed(s)), keepCompanyWord);
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
  const text = nameText(value);
  if (!text || text.length > MAX_CLEAN_FIELD_CHARS || isPlaceholder(text, false)) return '';
  // "The" counts for the_company once brackets are seen to: "The (Acme Company" is "Acme Company", and
  // ") The Acme Company" starts with The.
  const s = trimStray(cutUnclosed(text));
  const keep = theCompany === 'keep' && isThe(s.split(' ')[0]);
  const { name: stripped, lostCompanyWord } = strip(s, keep);
  const theWords = stripped.split(' ');
  // "The Coca-Cola Company" → "Coca-Cola", but "The Home Depot, Inc." keeps its The. A stray closing bracket
  // its going bares goes too ("THE ) Ltd& Co." → "Ltd&").
  if (lostCompanyWord && theWords.length > 1 && isThe(theWords[0])) theWords.shift();
  const name = trimStray(theWords.join(' '));
  const words = name.split(' ');
  // Mixed case was typed on purpose: eBay, iRobot, HubSpot.
  const out = hasLower(name) && hasUpper(name) ? name : words.map((w, i) => recaseWord(w, i, words.length)).join(' ');
  // "Unknown Corp" gives "Unknown", a placeholder too.
  return isPlaceholder(out, false) ? '' : out;
}
