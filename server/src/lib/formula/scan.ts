// A small JavaScript scanner for formulas (pure). It tells code, quoted
// strings, template literals, comments and regex literals apart, so a
// {{Column}} reference is found only where it means something, and hands each
// one to onRef, which says what to write in its place:
//   { raw }  this text (a name written exactly, a renamed one),
//   { expr } this expression (the compiled __v[i]); inside a quoted string it
//            turns the string into a template literal, so "Hi {{Name}}"
//            reads the cell as `Hi ${__v[0]}` would,
//   null     the reference as written.
// A reference ends at the first "}}" (a name can't end in "}"), and "{{{" is a
// brace and then a reference, so `${{{Name}}}` works. Only {{…}}: in code a
// /word is a division or a regex.
export class FormulaError extends Error {}

export type RefWhere = 'code' | 'text';
export type RefOut = { raw: string } | { expr: string } | null;
// raw: the reference as written, braces included.
export type OnRef = (name: string, where: RefWhere, raw: string) => RefOut;

const WORD = /[A-Za-z0-9_$\u00aa-\uffff]/;
// After these words a "/" starts a regex literal, not a division.
const KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'yield', 'await',
]);

export class FormulaScan {
  private i = 0;
  out = '';
  usesLodash = false;
  constructor(private readonly src: string, private readonly onRef: OnRef) {}

  run(): this {
    this.code(false);
    return this;
  }

  private startsRef(at: number): boolean {
    const s = this.src;
    return s[at] === '{' && s[at + 1] === '{' && s[at + 2] !== '{';
  }

  // Where a reference starting at `at` closes ("}}"), or -1 when `stop` comes
  // first (the string or template ends) or nothing closes it.
  private refEnd(at: number, stop: (c: string) => boolean): number {
    for (let k = at + 2; k < this.src.length; k++) {
      if (this.src[k] === '}' && this.src[k + 1] === '}') return k;
      if (stop(this.src[k])) return -1;
    }
    return -1;
  }

  // Code until the end or, inside a template's ${…}, the "}" that closes it.
  private code(inTemplate: boolean): void {
    const s = this.src;
    let depth = 0;
    let value = false; // the last token ends a value: a "/" next is a division
    while (this.i < s.length) {
      const c = s[this.i];
      if (this.startsRef(this.i)) { this.codeRef(); value = true; continue; }
      if (c === '"' || c === "'") { this.quoted(c); value = true; continue; }
      if (c === '`') { this.template(); value = true; continue; }
      if (c === '/' && s[this.i + 1] === '/') { this.comment('\n', 'line'); continue; }
      if (c === '/' && s[this.i + 1] === '*') { this.comment('*/', 'block'); continue; }
      if (c === '/' && !value) { this.regex(); value = true; continue; }
      if (WORD.test(c)) {
        let j = this.i;
        while (j < s.length && WORD.test(s[j])) j++;
        const word = s.slice(this.i, j);
        if (word === '_') this.usesLodash = true;
        this.out += word;
        this.i = j;
        value = !KEYWORDS.has(word);
        continue;
      }
      if (c === '}') {
        if (inTemplate && depth === 0) return;
        depth--;
      } else if (c === '{') depth++;
      this.out += c;
      this.i++;
      if (!/\s/.test(c)) value = c === ')' || c === ']' || c === '}';
    }
    if (inTemplate) throw new FormulaError('A template literal is missing its closing `.');
  }

  private codeRef(): void {
    const end = this.src.indexOf('}}', this.i + 2);
    if (end < 0) throw new FormulaError('A column reference is missing its closing }}.');
    const r = this.onRef(this.src.slice(this.i + 2, end).trim(), 'code', this.src.slice(this.i, end + 2));
    this.out += r === null ? this.src.slice(this.i, end + 2) : 'raw' in r ? r.raw : r.expr;
    this.i = end + 2;
  }

  private quoted(q: string): void {
    const s = this.src;
    const parts: ({ t: string } | { e: string })[] = [];
    let j = this.i + 1;
    let seg = j;
    while (j < s.length && s[j] !== q && s[j] !== '\n') {
      if (s[j] === '\\') { j += 2; continue; }
      const end = this.startsRef(j) ? this.refEnd(j, c => c === q || c === '\n') : -1;
      if (end < 0) { j++; continue; }
      const r = this.onRef(s.slice(j + 2, end).trim(), 'text', s.slice(j, end + 2));
      if (r !== null) {
        parts.push({ t: s.slice(seg, j) }, 'raw' in r ? { t: r.raw } : { e: r.expr });
        seg = end + 2;
      }
      j = end + 2;
    }
    if (s[j] !== q) throw new FormulaError('A string is missing its closing quote.');
    parts.push({ t: s.slice(seg, j) });
    this.i = j + 1;
    if (!parts.some(p => 'e' in p)) {
      this.out += q + parts.map(p => ('t' in p ? p.t : '')).join('') + q;
      return;
    }
    this.out += '`' + parts.map(p => ('t' in p ? asTemplateText(p.t) : '${' + p.e + '}')).join('') + '`';
  }

  private template(): void {
    const s = this.src;
    this.out += '`';
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') { this.out += s.slice(this.i, this.i + 2); this.i += 2; continue; }
      if (c === '`') { this.out += '`'; this.i++; return; }
      if (c === '$' && s[this.i + 1] === '{') {
        this.out += '${';
        this.i += 2;
        this.code(true);
        this.out += '}';
        this.i++;
        continue;
      }
      const end = this.startsRef(this.i) ? this.refEnd(this.i, ch => ch === '`') : -1;
      if (end >= 0) {
        const r = this.onRef(s.slice(this.i + 2, end).trim(), 'text', s.slice(this.i, end + 2));
        this.out += r === null ? s.slice(this.i, end + 2) : 'raw' in r ? r.raw : '${' + r.expr + '}';
        this.i = end + 2;
        continue;
      }
      this.out += c;
      this.i++;
    }
    throw new FormulaError('A template literal is missing its closing `.');
  }

  private comment(close: string, kind: 'line' | 'block'): void {
    const end = this.src.indexOf(close, this.i + 2);
    if (end < 0 && kind === 'block') throw new FormulaError('A comment is missing its closing */.');
    const stop = end < 0 ? this.src.length : kind === 'block' ? end + 2 : end;
    this.out += this.src.slice(this.i, stop);
    this.i = stop;
  }

  private regex(): void {
    const s = this.src;
    let j = this.i + 1;
    let inClass = false;
    for (; j < s.length && s[j] !== '\n'; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (inClass) { if (s[j] === ']') inClass = false; continue; }
      if (s[j] === '[') inClass = true;
      else if (s[j] === '/') break;
    }
    if (s[j] !== '/') throw new FormulaError('A regular expression is missing its closing /.');
    j++;
    while (j < s.length && /[a-z]/i.test(s[j])) j++;
    this.out += s.slice(this.i, j);
    this.i = j;
  }
}

// A quoted string's source text as template-literal text: escapes stay as they
// are, a backtick and a "${" get escaped.
function asTemplateText(t: string): string {
  let out = '';
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '\\') { out += t.slice(k, k + 2); k++; continue; }
    if (c === '`') out += '\\`';
    else if (c === '$' && t[k + 1] === '{') out += '\\$';
    else out += c;
  }
  return out;
}
