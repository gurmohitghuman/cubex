// Legal-form endings the company name cleaner strips (company.ts). Matched as
// whole words with ".", ",", "-" and parentheses removed, case and accents
// ignored, so "Inc.", "INC," and "L.L.C." all match.

// Words like Holdings, Group, Partners, International or Technologies are part
// of the name and aren't here, nor are short foreign forms that double as
// words ("Sky UK" keeps its UK).
const SINGLE = [
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'ltd', 'limited', 'llp', 'lp', 'lllp',
  'plc', 'pllc', 'pc', 'pty', 'gmbh', 'ag', 'se', 'sa', 'nv', 'bv', 'spa', 'srl', 'sas', 'sarl', 'sl', 'oy',
  'oyj', 'ab', 'a/s', 'aps', 'asa',
];
// Endings of several words, stripped together (longest first) so "& Co."
// doesn't leave a dangling "&".
const MULTI = [
  'gmbh & co kg', 'sa de cv', 'pty ltd', 'pvt ltd', 'private limited', '& co', '& company', 'and co',
  'and company',
];

export const SUFFIX_UNITS: string[][] = [...MULTI, ...SINGLE].map(u => u.split(' '))
  .sort((a, b) => b.length - a.length);

// Losing one of these makes a leading "The" part of the legal name too:
// "The Coca-Cola Company" → "Coca-Cola".
export const COMPANY_WORDS = new Set(['co', 'company', 'corp', 'corporation']);

// The matching key of one word.
export const suffixKey = (word: string): string =>
  word.normalize('NFD').replace(/\p{M}/gu, '').replace(/[.,()-]/g, '').toLowerCase();
