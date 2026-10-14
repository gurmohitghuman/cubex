// Text cleaners (pure): tidy spaces, lower case, title case. Every other
// cleaner starts with cleanTrim.
import { stripInvisibleNameChars } from '../name-safety';
import { capAfterOneLetterApostrophe, capitalize, hasLower, splitAffixes, upper } from './word-case';

// Every kind of space (no-break, thin, ideographic, tab, line break) becomes
// one plain space, and hidden characters go except where they are spelling:
// the joiner inside an emoji and the (non-)joiner between letters of scripts
// that join (name-safety.ts decides which). Runs of spaces collapse.
export function cleanTrim(value: string): string {
  if (typeof value !== 'string') return '';
  return stripInvisibleNameChars(value.replace(/\p{White_Space}+/gu, ' ')).replace(/ {2,}/g, ' ').trim();
}

export const cleanLowercase = (value: string): string => cleanTrim(value).toLowerCase();

// Short words that stay lower case inside a title ("VP of Sales").
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to',
  'vs', 'via']);
// Written this way wherever they appear. "it" is always IT and "us" always US:
// cells that get title case (job titles, departments, places) mean the
// acronym far more often than the pronoun, and one rule keeps a second pass
// stable ("It's" is a different word and stays).
const ACRONYMS = new Map(['CEO', 'CFO', 'COO', 'CTO', 'CMO', 'CIO', 'CRO', 'CISO', 'VP', 'SVP', 'EVP', 'AVP',
  'HR', 'IT', 'QA', 'UX', 'UI', 'PR', 'SEO', 'R&D', 'B2B', 'B2C', 'GTM', 'AI', 'ML', 'US', 'USA', 'UK', 'EMEA',
  'APAC', 'LATAM', 'ANZ', 'SaaS'].map(a => [a.toUpperCase(), a]));
const ORDINAL = /^\d+(?:st|nd|rd|th)$/i;
// Letters joined by "&" (P&G, M&A, AT&T) read as initials.
const AMP_INITIALS = /^\p{L}{1,2}&\p{L}{1,2}$/u;

// A word whose casing doesn't depend on whether the input was all capitals.
function fixedCase(core: string, small: boolean): string | null {
  const acronym = ACRONYMS.get(core.toUpperCase());
  if (acronym) return acronym;
  const lower = core.toLowerCase();
  if (small && SMALL.has(lower)) return lower;
  // acme.com, Ph.D: dotted words are kept as typed.
  if (core.includes('.')) return core;
  if (/\p{N}/u.test(core)) return ORDINAL.test(core) ? lower : core;
  if (AMP_INITIALS.test(core)) return upper(core);
  // "X", "O'R": no letter left to lower, so all capitals or not reads the same.
  const capped = capAfterOneLetterApostrophe(capitalize(core));
  return hasLower(capped) ? null : capped;
}

function titleCore(core: string, small: boolean, allCaps: boolean): string {
  const fixed = fixedCase(core, small);
  if (fixed !== null) return fixed;
  // In mixed-case input a word with a capital after a lower case letter
  // (iPhone, eBay, HubSpot) or a short all-capital word (NASA, AWS) was typed
  // that way on purpose. When everything is in capitals, nothing was.
  if (!allCaps && (/\p{Ll}\p{Lu}/u.test(core) || /^\p{Lu}{2,4}$/u.test(core))) return core;
  return capAfterOneLetterApostrophe(capitalize(core));
}

// Whether the part at k (of n) may stay a lower case small word: inside a
// title, never first or last; inside a compound only in the middle
// (Editor-in-Chief), so "in-house" still starts with a capital.
const mayBeSmall = (k: number, n: number, first: boolean, last: boolean) =>
  n === 1 ? !first && !last : k > 0 && k < n - 1;

interface Part { lead: string; core: string; trail: string; small: boolean }

// Each word split on "-" and "/" (the delimiters stay, as strings).
function readWords(s: string): (Part | string)[][] {
  const words = s.split(' ');
  return words.map((word, i) => {
    const parts = word.split(/([-/])/);
    const n = (parts.length + 1) / 2;
    return parts.map((p, j) => {
      if (j % 2) return p;
      const [lead, core, trail] = splitAffixes(p);
      return { lead, core, trail, small: mayBeSmall(j / 2, n, i === 0, i === words.length - 1) };
    });
  });
}

// Data-style title case: "vp of sales" → "VP of Sales", "o'fallon" → "O'Fallon".
export function cleanTitleCase(value: string): string {
  const s = cleanTrim(value);
  if (!s) return '';
  const words = readWords(s);
  const parts = words.flat().filter((x): x is Part => typeof x !== 'string');
  // "All capitals" looks only at the words whose casing depends on it, so a
  // first pass's output (where "CEO" or "R&D" stay in capitals) reads the same
  // way to a second pass.
  const allCaps = !parts.some(x => fixedCase(x.core, x.small) === null && hasLower(x.core));
  const render = (x: Part | string) =>
    typeof x === 'string' ? x : x.lead + (x.core && titleCore(x.core, x.small, allCaps)) + x.trail;
  return words.map(word => word.map(render).join('')).join(' ');
}
