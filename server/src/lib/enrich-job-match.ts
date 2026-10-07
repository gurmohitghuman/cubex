// Does a Popular job match what someone typed (pure)? treg's search ranks by
// its own vocabulary and can miss a Popular job for the plainest word:
// "company" finds neither company waterfall. So a job whose title has every
// typed word (as a word or the start of one, plurals folded) leads the search
// results. Titles only: blurbs name inputs ("from a name and company"), which
// would put the phone finder first for "company".

// "companies" → "company", "emails" → "email"; short words stay as typed.
function fold(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(fold);

export function jobMatches(title: string, query: string): boolean {
  const want = words(query);
  if (want.length === 0) return false;
  const have = words(title);
  return want.every(w => have.some(h => h === w || (w.length >= 3 && h.startsWith(w))));
}
