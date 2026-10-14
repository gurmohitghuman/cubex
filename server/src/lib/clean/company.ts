// Company name cleaner (pure): the name people use, without its legal form
// ("Acme, Inc." → "Acme"), recased only when it was typed all in capitals or
// all in lower case.
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { COMPANY_WORDS, SUFFIX_UNITS, suffixKey } from './company-suffixes';
import { cleanTrim } from './text';
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
function stripOnce(name: string): { rest: string; companyWord: boolean } | null {
  for (const re of [DESCRIPTOR, TRAILING_PAREN]) {
    const m = re.exec(name);
    if (m && hasName(name.slice(0, m.index))) return { rest: name.slice(0, m.index), companyWord: false };
  }
  const words = name.split(' ');
  const unit = endingUnit(words);
  if (!unit) return null;
  const rest = words.slice(0, words.length - unit.length).join(' ');
  return hasName(rest) ? { rest, companyWord: unit.some(k => COMPANY_WORDS.has(k)) } : null;
}

// Strips until nothing more comes off, so a second pass finds nothing:
// "Acme (UK) Ltd" loses Ltd, then (UK). The comma or period a stripped
// ending leaves behind goes too ("Acme, Inc." → "Acme"); nothing else does
// ("Yahoo!" keeps its "!").
function stripLegal(name: string): { name: string; lostCompanyWord: boolean } {
  let lostCompanyWord = false;
  for (let step = stripOnce(name); step; step = stripOnce(name)) {
    name = step.rest.replace(/[\s,.]+$/, '');
    lostCompanyWord ||= step.companyWord;
  }
  return { name, lostCompanyWord };
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

export function cleanCompanyName(value: string): string {
  const s = cleanTrim(value);
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS) return '';
  const { name: stripped, lostCompanyWord } = stripLegal(s);
  const words = stripped.split(' ');
  // "The Coca-Cola Company" → "Coca-Cola", but "The Home Depot, Inc." keeps its The.
  if (lostCompanyWord && words.length > 1 && isThe(words[0])) words.shift();
  const name = words.join(' ');
  // Mixed case was typed on purpose: eBay, iRobot, HubSpot.
  if (hasLower(name) && hasUpper(name)) return name;
  return words.map((w, i) => recaseWord(w, i, words.length)).join(' ');
}
