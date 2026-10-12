// "Only run if" rules (lib/run-condition.ts): the text a person or the AI
// writes, read into a tree. A small hand-written parser, never eval, so a cell
// value or a generated rule can't run as code. The language:
//
//   {{Column}} is "text"        {{Column}} is not "text"     (= and != too)
//   {{Column}} contains "text"  {{Column}} does not contain "text"
//   {{Column}} is empty         {{Column}} is not empty
//   {{Column}} > 50   (<, >=, <= too)
//   joined with AND, OR, NOT and brackets (&&, || and ! read the same).
//
// NOT binds tightest, then AND, then OR, as in most languages.
export type CompareOp =
  'is' | 'is_not' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'gte' | 'lte';

export interface Compare { kind: 'cmp'; column: string; op: CompareOp; value: string; numeric: boolean }
export type RuleNode = Compare | { kind: 'and' | 'or'; items: RuleNode[] } | { kind: 'not'; item: RuleNode };

// What a person or agent may send. A stored rule can grow past it (a rename to
// a longer name, quotes written back escaped), so parsing stops only far above.
export const MAX_RULE_CHARS = 2000;
const MAX_STORED_RULE_CHARS = 20_000;
const MAX_COMPARES = 50;
const MAX_DEPTH = 20;

type Token =
  | { t: 'col'; v: string } | { t: 'str'; v: string } | { t: 'num'; v: string }
  | { t: 'word'; v: string; raw: string } | { t: 'sym'; v: string };

const SYMBOLS = ['>=', '<=', '!=', '&&', '||', '(', ')', '=', '>', '<', '!'];

export class RuleError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('{{', i)) {
      let end = src.indexOf('}}', i + 2);
      if (end < 0) throw new RuleError('A column reference is missing its closing }}.');
      // A name ending in "}": {{Size}}} names "Size}".
      while (src[end + 2] === '}') end++;
      const name = src.slice(i + 2, end).trim();
      if (!name) throw new RuleError('A column reference is empty: write {{Column name}}.');
      out.push({ t: 'col', v: name });
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let v = '', j = i + 1;
      for (; j < src.length && src[j] !== c; j++) v += src[j] === '\\' && j + 1 < src.length ? src[++j] : src[j];
      if (j >= src.length) throw new RuleError(`A value is missing its closing ${c}.`);
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const word = /^[A-Za-z]+/.exec(src.slice(i));
    if (word) { out.push({ t: 'word', v: word[0].toLowerCase(), raw: word[0] }); i += word[0].length; continue; }
    const sym = SYMBOLS.find(s => src.startsWith(s, i));
    if (!sym) throw new RuleError(`"${c}" isn't part of a rule. Put text values in quotes.`);
    out.push({ t: 'sym', v: sym });
    i += sym.length;
  }
  return out;
}

const SYMBOL_OPS: Record<string, CompareOp> = {
  '=': 'is', '!=': 'is_not', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte',
};

const describe = (k: Token | undefined) => !k ? 'the end of the rule'
  : k.t === 'col' ? `{{${k.v}}}` : `"${k.t === 'word' ? k.raw : k.v}"`;

class Parser {
  private i = 0;
  private compares = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined { return this.toks[this.i]; }
  private isWord(v: string, at = 0): boolean { const k = this.toks[this.i + at]; return k?.t === 'word' && k.v === v; }
  private isSym(v: string): boolean { const k = this.peek(); return k?.t === 'sym' && k.v === v; }
  private fail(want: string): never { throw new RuleError(`Expected ${want}, found ${describe(this.peek())}.`); }

  parse(): RuleNode {
    const node = this.or(0);
    if (this.peek()) this.fail('AND, OR or the end of the rule');
    return node;
  }

  private joined(kind: 'and' | 'or', depth: number, next: (d: number) => RuleNode, words: [string, string]): RuleNode {
    const items = [next(depth)];
    while (this.isWord(words[0]) || this.isSym(words[1])) { this.i++; items.push(next(depth)); }
    return items.length === 1 ? items[0] : { kind, items };
  }
  private or(depth: number): RuleNode { return this.joined('or', depth, d => this.and(d), ['or', '||']); }
  private and(depth: number): RuleNode { return this.joined('and', depth, d => this.not(d), ['and', '&&']); }

  private not(depth: number): RuleNode {
    if (depth > MAX_DEPTH) throw new RuleError('The rule is nested too deeply.');
    if (this.isWord('not') || this.isSym('!')) { this.i++; return { kind: 'not', item: this.not(depth + 1) }; }
    if (this.isSym('(')) {
      this.i++;
      const inner = this.or(depth + 1);
      if (!this.isSym(')')) this.fail('a closing bracket');
      this.i++;
      return inner;
    }
    return this.compare();
  }

  private value(): { value: string; numeric: boolean } {
    const k = this.peek();
    if (k?.t === 'str') { this.i++; return { value: k.v, numeric: false }; }
    if (k?.t === 'num') { this.i++; return { value: k.v, numeric: true }; }
    return this.fail('a value in quotes or a number');
  }

  private compare(): Compare {
    const col = this.peek();
    if (col?.t !== 'col') this.fail('a column like {{Industry}}');
    this.i++;
    if (++this.compares > MAX_COMPARES) throw new RuleError(`A rule can check at most ${MAX_COMPARES} things.`);
    const cmp = (op: CompareOp, v = { value: '', numeric: false }): Compare =>
      ({ kind: 'cmp', column: col.v, op, ...v });
    if (this.isWord('is')) {
      this.i++;
      const negated = this.isWord('not') ? (this.i++, true) : false;
      if (this.isWord('empty')) { this.i++; return cmp(negated ? 'not_empty' : 'empty'); }
      return cmp(negated ? 'is_not' : 'is', this.value());
    }
    if (this.isWord('contains')) { this.i++; return cmp('contains', this.value()); }
    if (this.isWord('does') && this.isWord('not', 1) && this.isWord('contain', 2)) {
      this.i += 3;
      return cmp('not_contains', this.value());
    }
    const sym = this.peek();
    if (sym?.t === 'sym' && SYMBOL_OPS[sym.v]) { this.i++; return cmp(SYMBOL_OPS[sym.v], this.value()); }
    return this.fail('is, is not, contains, does not contain, is empty, >, <, >= or <=');
  }
}

export function parseRule(text: string): RuleNode {
  if (text.length > MAX_STORED_RULE_CHARS) throw new RuleError('The rule is too long.');
  const toks = tokenize(text);
  if (toks.length === 0) throw new RuleError('The rule is empty.');
  return new Parser(toks).parse();
}
