// A JSON request body written with {{column}} tokens, read as JSON so each
// value goes where it belongs (http-request-build.ts):
//   - inside a JSON string ("name": "{{Name}}") a cell's value is JSON-escaped,
//     so a quote, a backslash or a line break in a cell keeps the body valid
//     JSON (pasted as is, an AI answer with a line break broke the request); a
//     saved key or text left as written goes in unchanged;
//   - a token standing for a whole value ("count": {{Count}}) goes in as written,
//     so a cell holding JSON or a number still can;
//   - skipping empty values, a field or array item whose value is only tokens
//     that came out empty is left out ("email": "{{Email}}" with no email).
// The text is never re-serialized: everything but the values stays as written,
// number literals and spacing included. A template that isn't JSON with tokens
// in value places (a form, plain text, a token as a key) returns null and the
// caller substitutes it as written. Pure: values come in already resolved.
export interface JsonValue { text: string; escape: boolean }
import type { TemplatePart } from './http-template-parts';

// Stands for one token in the scanned text. A template holding this character
// itself isn't read as JSON (a JSON text can't hold it unescaped anyway).
const SENTINEL = String.fromCharCode(0);
const MAX_DEPTH = 100;
const QUOTE = 34, BACKSLASH = 92, SPACE = 32;

type Str = { k: 'str'; s: number; e: number; toks: number[]; blankText: boolean };
type Raw = { k: 'raw'; s: number; e: number; tok: number };
type Lit = { k: 'lit'; s: number; e: number };
type Kid = { s: number; e: number; key: Str | null; val: Node };
type Box = { k: 'box'; s: number; e: number; kids: Kid[] };
type Node = Str | Raw | Lit | Box;

const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

// Recursive descent over the scanned text. Tokens are numbered in the order met,
// which is their order in the template (splitTemplate numbers them the same way).
class Reader {
  i = 0;
  private depth = 0;
  private tok = 0;
  constructor(private readonly f: string) {}

  top(): Node | null {
    const n = this.value();
    if (!n) return null;
    this.ws();
    return this.i === this.f.length ? n : null;
  }

  private ws(): void {
    while (this.i < this.f.length) {
      const c = this.f.charCodeAt(this.i);
      if (c === SPACE || c === 9 || c === 10 || c === 13) this.i++;
      else return;
    }
  }

  private value(): Node | null {
    this.ws();
    const c = this.f[this.i];
    if (c === SENTINEL) { const s = this.i++; return { k: 'raw', s, e: this.i, tok: this.tok++ }; }
    if (c === '"') return this.string();
    if (c === '{' || c === '[') {
      if (++this.depth > MAX_DEPTH) return null;
      const n = this.box(c === '{');
      this.depth--;
      return n;
    }
    LITERAL.lastIndex = this.i;
    const m = LITERAL.exec(this.f);
    if (!m) return null;
    const s = this.i;
    this.i += m[0].length;
    return { k: 'lit', s, e: this.i };
  }

  private string(): Str | null {
    const f = this.f, s = this.i++, toks: number[] = [];
    let blankText = true;
    while (this.i < f.length) {
      const c = f.charCodeAt(this.i);
      if (c === QUOTE) { this.i++; return { k: 'str', s, e: this.i, toks, blankText }; }
      if (f[this.i] === SENTINEL) { toks.push(this.tok++); this.i++; continue; }
      if (c === BACKSLASH) {
        // An escape just before a token would escape the token's first character.
        if (this.i + 1 >= f.length || f[this.i + 1] === SENTINEL) return null;
        blankText = false;
        this.i += 2;
        continue;
      }
      if (c < SPACE) return null; // a raw control character: not JSON
      if (c !== SPACE) blankText = false;
      this.i++;
    }
    return null;
  }

  private box(object: boolean): Box | null {
    const f = this.f, s = this.i++, kids: Kid[] = [], end = object ? '}' : ']';
    this.ws();
    if (f[this.i] === end) { this.i++; return { k: 'box', s, e: this.i, kids }; }
    for (;;) {
      this.ws();
      let key: Str | null = null;
      if (object) {
        if (f[this.i] !== '"') return null;
        key = this.string();
        if (!key) return null;
        this.ws();
        if (f[this.i] !== ':') return null;
        this.i++;
      }
      const val = this.value();
      if (!val) return null;
      kids.push({ s: key ? key.s : val.s, e: val.e, key, val });
      this.ws();
      if (f[this.i] === ',') { this.i++; continue; }
      if (f[this.i] === end) { this.i++; return { k: 'box', s, e: this.i, kids }; }
      return null;
    }
  }
}

const escapeInString = (v: string) => JSON.stringify(v).slice(1, -1);

// `values[i]` is token i's text, and whether to escape it inside a string.
// Null: not JSON, substitute as written.
export function renderJsonTemplate(parts: TemplatePart[], values: JsonValue[], skipEmpty: boolean): string | null {
  if (parts.some(p => p.kind === 'text' && p.text.includes(SENTINEL))) return null;
  const f = parts.map(p => (p.kind === 'text' ? p.text : SENTINEL)).join('');
  const root = new Reader(f).top();
  if (!root) return null;

  const blank = (t: number) => values[t].text.trim() === '';
  const empty = (n: Node) => (n.k === 'raw' ? blank(n.tok)
    : n.k === 'str' && n.toks.length > 0 && n.blankText && n.toks.every(blank));
  const str = (n: Str): string => {
    let out = '', from = n.s, k = 0;
    for (;;) {
      const j = f.indexOf(SENTINEL, from);
      if (j === -1 || j >= n.e) return out + f.slice(from, n.e);
      const v = values[n.toks[k++]];
      out += f.slice(from, j) + (v.escape ? escapeInString(v.text) : v.text);
      from = j + 1;
    }
  };
  const kid = (k: Kid): string => (k.key ? str(k.key) + f.slice(k.key.e, k.val.s) : '') + render(k.val);
  // Separators stay as written; leaving items out joins the rest with the first one.
  const box = (n: Box): string => {
    const kids = n.kids;
    if (kids.length === 0) return f.slice(n.s, n.e);
    const open = f.slice(n.s, kids[0].s), close = f.slice(kids[kids.length - 1].e, n.e);
    const keep = skipEmpty ? kids.filter(k => !empty(k.val)) : kids;
    if (keep.length === kids.length) {
      let out = open;
      kids.forEach((k, i) => { out += kid(k) + (i + 1 < kids.length ? f.slice(k.e, kids[i + 1].s) : ''); });
      return out + close;
    }
    const sep = kids.length > 1 ? f.slice(kids[0].e, kids[1].s) : ', ';
    return open + keep.map(kid).join(sep) + close;
  };
  function render(n: Node): string {
    switch (n.k) {
      case 'str': return str(n);
      case 'raw': return values[n.tok].text;
      case 'lit': return f.slice(n.s, n.e);
      case 'box': return box(n);
    }
  }
  return render(root);
}
