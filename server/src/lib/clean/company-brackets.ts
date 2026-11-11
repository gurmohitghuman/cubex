// Brackets in a company name (pure, company.ts): one that never closes is cut
// with what follows it, and a closing one that closes nothing goes from the
// ends. Each reading is one pass over the name.

const OPENERS = '([{';
const CLOSERS = ')]}';
const AN_OPENER = /[([{]/;
const A_CLOSER = /[)\]}]/;
const CLOSER_AT_AN_END = /^\s*[)\]}]|[)\]}]\s*$/;
// The eyes of an emoticon (":)", ";-)", "=)", "8)").
const EMOTICON_EYES = ':;=8';
// An "8" is eyes only at the start or after a space: right after anything
// else it ends a word, a number or a code ("2018", "X8", "1.8", "#8", "F-8").
// The name holds plain single spaces by then (nameText). Read at one position
// (sticky), so a check costs the same however long the name is.
const EIGHT_IN_A_WORD = /(?<=\S)8/uy;

// A closing bracket that ends an emoticon (":)", ";-)", "8]", "8-)") is text,
// never stray: "Acme :)" stays as it is. An "8" is eyes only at the start or
// after a space, so the bracket after "2018", "No.8" or "F-8" is still stray,
// and so is one after a period ("Acme Inc.]" → "Acme").
function endsEmoticon(s: string, at: number): boolean {
  const eye = at > 0 && s[at - 1] === '-' ? at - 2 : at - 1;
  if (eye < 0 || !EMOTICON_EYES.includes(s[eye])) return false;
  if (s[eye] !== '8') return true;
  EIGHT_IN_A_WORD.lastIndex = eye;
  return !EIGHT_IN_A_WORD.test(s);
}

// One pass over the brackets, a stack per kind: a closing bracket closes the
// nearest open one of its kind, and every bracket of another kind opened after
// that one (it sat inside the pair). open: the positions of the brackets that
// never close, in order; stray: the closing brackets that close nothing, an
// emoticon's aside. A closing bracket's flag depends only on what comes before
// it, so it holds for any shorter name this one starts with.
function scanBrackets(s: string): { open: number[]; stray: Uint8Array } {
  const open: number[][] = [[], [], []];
  const stray = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const o = OPENERS.indexOf(s[i]);
    if (o >= 0) { open[o].push(i); continue; }
    const c = CLOSERS.indexOf(s[i]);
    if (c < 0) continue;
    if (open[c].length === 0) {
      if (!endsEmoticon(s, i)) stray[i] = 1;
      continue;
    }
    const at = open[c].pop()!;
    for (const stack of open) while (stack.length && stack[stack.length - 1] > at) stack.pop();
  }
  return { open: open.flat().sort((x, y) => x - y), stray };
}

// Where the name starts: the first letter or digit, a first word "The" aside
// (company.ts hasName's reading).
function nameStart(s: string): number {
  const the = /^[^\p{L}\p{N}]*the(?![\p{L}\p{N}])/iu.exec(s);
  const from = the ? the[0].length : 0;
  const m = /[\p{L}\p{N}]/u.exec(s.slice(from));
  return m ? from + m.index : s.length;
}

// A bracket that never closes goes with what follows it ("ImagineSoftware
// (Technology Partners" → "ImagineSoftware"). Those with nothing named before
// them go all at once, and the name is what follows them ("(Acme Corp" → "Acme
// Corp", "The (Acme Company" → "Acme Company"). What's left has none.
export function cutUnclosed(s: string): string {
  if (!AN_OPENER.test(s)) return s;
  const { open } = scanBrackets(s);
  if (open.length === 0) return s;
  const named = nameStart(s);
  let k = 0;
  while (k < open.length && open[k] < named) k++;
  return s.slice(k > 0 ? open[k - 1] + 1 : 0, k < open.length ? open[k] : s.length).trim();
}

// The stray flags of a name, or null when it has no closing bracket.
export const strayFlags = (s: string): Uint8Array | null => (A_CLOSER.test(s) ? scanBrackets(s).stray : null);

// The name without the spaces and stray closing brackets at its end. stray:
// strayFlags of this name or of a longer one it starts with.
export function dropTrailingStray(s: string, stray: Uint8Array | null): string {
  let b = s.length;
  while (b > 0 && (s[b - 1] === ' ' || (stray !== null && stray[b - 1] === 1))) b--;
  return b === s.length ? s : s.slice(0, b);
}

// Closing brackets that close nothing go from either end, with the spaces
// between ("Acme }" and ") Acme" → "Acme"). Matched pairs stay, and so does a
// stray one inside the name ("Acme ) Beta"). With no opening bracket at all,
// every closing one but an emoticon's is stray, and only the ends are read.
export function trimStray(s: string): string {
  if (!CLOSER_AT_AN_END.test(s)) return s;
  const stray = AN_OPENER.test(s) ? scanBrackets(s).stray : null;
  const isStray = (i: number) => (stray ? stray[i] === 1 : CLOSERS.includes(s[i]) && !endsEmoticon(s, i));
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || isStray(a))) a++;
  while (b > a && (s[b - 1] === ' ' || isStray(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
