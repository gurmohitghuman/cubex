// Word lists for the person name cleaners (person-name.ts, name-case.ts).
// Kept short on purpose: king, judge, bishop, chief, coach, lady and lord are
// real names too, so only unambiguous honorifics are stripped.

// The matching key: case and periods ignored ("Dr." = "dr", "Ph.D." = "phd").
export const nameKey = (word: string): string => word.replace(/\./g, '').toLowerCase();

// Stripped from the front, and only when another name word follows.
export const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor', 'rev', 'fr', 'hon', 'sir', 'dame',
  'capt', 'col', 'lt', 'sgt', 'gen',
]);

// Stripped from the end: generations and credentials. Never "Do" or "Ed",
// which are names.
export const SUFFIXES = new Set([
  'jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv', '2nd', '3rd', 'esq',
  'phd', 'md', 'mba', 'cpa', 'cfa', 'jd', 'dds', 'rn', 'pe', 'pmp', 'cissp',
]);

// Words that join the last name when they come right before it ("van
// Beethoven", "de la Vega", "St. Clair"). In first place a capitalized one is
// a first name (Van Morrison, Di Wang); one in lower case, or St., starts a
// last name.
export const PARTICLES = new Set([
  'de', 'da', 'di', 'du', 'del', 'della', 'der', 'den', 'van', 'von', 'ten', 'ter', 'la', 'le', 'dos', 'das',
  'bin', 'ibn', 'st', 'ste',
]);
// Particles that are capitalized wherever they are.
export const CAPITAL_PARTICLES = new Set(['st', 'ste']);

// Last names starting with "Mac" that don't take a capital after it (prefix
// match): Macey, Machado, Mackey...
export const MAC_EXCEPTIONS = [
  'macevicius', 'machado', 'machar', 'machin', 'machlin', 'macias', 'maciulis', 'mackie', 'mackle', 'macklin',
  'macquarie', 'macomber', 'macin', 'mackintosh', 'macken', 'machen', 'machiel', 'maciol', 'mackell', 'macklem',
  'mackrell', 'maclin', 'mackey', 'mackley', 'machell', 'machon', 'macedo', 'mackmin', 'macron', 'macaulay',
  'macey',
];
// Take the capital although their ending would say otherwise.
export const MAC_FORCED = new Map([['macmurdo', 'MacMurdo'], ['macisaac', 'MacIsaac']]);

// Placeholders: a whole value that is one of these (case, and the spaces, dots
// and brackets around it, ignored: "N/A.", "(none)", "NULL", a spreadsheet's
// "#N/A") says there is no name. The name and company cleaners leave it blank.
// Only whole values: "Test Kitchen", "Nancy Unknown" and "Gary Null" are names.
export const PLACEHOLDERS = new Set([
  'n/a', '#n/a', 'n.a', 'na', 'none', 'null', 'nil', 'blank', '-', '--', '?', 'unknown', 'test', 'tbd',
]);
// Written so, these are names (Nil Moliner, Gary Null, Arthur Blank) and can be
// a cleaner's own result (the last name of Gary Null, Blank Inc's company
// name), so every name and company cleaner keeps them and cleaning that result
// again changes nothing.
export const PLACEHOLDER_NAME_EXCEPTIONS = new Set(['Nil', 'Null', 'Blank']);
// And "Na" (Li Na, Na Young) in the person name cleaners.
export const PERSON_NAME_EXCEPTIONS = new Set(['Na']);
