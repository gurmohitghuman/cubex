// The type treg's catalog gives an input or an output, in the words the rest of
// Cubex reads (pure). Until November 2026 a routed tool's types were short words
// (str, int, float, bool, dict, url, list) and a single tool's said its items in
// brackets (array[string]); now both are written as JSON Schema does: string,
// integer, number, boolean, object, array with its items apart, and a list of
// words where a value may be one of them. Both ways come out the same:
// string, integer, number, boolean, object, array[<items>] (array alone when no
// items are given), and a choice that takes text as string_or_<the others>,
// such as the string_or_array that request building reads (lib/enrich-request.ts).
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const OLD: Record<string, string> = {
  str: 'string', url: 'string', int: 'integer', float: 'number', bool: 'boolean', dict: 'object', list: 'array',
};
const wordOf = (w: string) => OLD[w] ?? w;

// The word for a type definition ({type, items}), or undefined when it gives none.
export function typeWord(def: unknown): string | undefined {
  if (!isObj(def)) return undefined;
  const t = def.type;
  const words = typeof t === 'string' ? [t]
    : Array.isArray(t) ? t.filter((w): w is string => typeof w === 'string') : [];
  const plain = [...new Set(words.map(wordOf))];
  if (plain.length === 0) return undefined;
  if (plain.length > 1) {
    if (plain.includes('string')) return ['string', ...plain.filter(w => w !== 'string')].join('_or_');
    return typeWord({ ...def, type: plain[0] });
  }
  if (plain[0] !== 'array') return plain[0];
  const items = typeWord(def.items);
  return items ? `array[${items}]` : 'array';
}

// An output that holds rows: the old word list, or an array whose items may be
// objects. An array of text or numbers isn't rows.
export function isRowList(def: unknown): boolean {
  if (!isObj(def)) return false;
  if (def.type === 'list') return true;
  const word = typeWord(def);
  return !!word && word.startsWith('array[') && word.slice('array['.length, -1).split('_or_').includes('object');
}
