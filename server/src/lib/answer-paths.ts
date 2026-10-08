// Whether a JSONPath reads into a part of a stored answer that was not kept
// (pure): a part answer-trim.ts dropped for size ($trimmedPaths: `$.raw.data`,
// a list's tail `$.raw.items[3:]`, or `$` for a whole answer), or the `raw`
// part a prune removed. "Add a field" refuses such a path with a clear
// message instead of filling a column that stays empty (or, for a path
// above it, shorter than a run would fill it). A wildcard or `..` that could
// reach into the dropped part counts as reaching it.
type Seg =
  | { t: 'key'; k: string } | { t: 'idx'; i: number } | { t: 'any' } | { t: 'from'; i: number }
  | { t: 'deep'; next: Seg };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

// The segments after `$`, or null for anything outside the grammar
// validateHttpJsonPath allows (plus the `[n:]` tail answer-trim records).
export function parsePath(path: string): Seg[] | null {
  if (!path.startsWith('$')) return null;
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    const rest = path.slice(i);
    if (rest.startsWith('..') || rest.startsWith('.')) {
      const deep = rest.startsWith('..');
      const after = rest.slice(deep ? 2 : 1);
      let seg: Seg;
      let used: number;
      if (after.startsWith('*')) { seg = { t: 'any' }; used = 1; } else {
        const m = IDENT.exec(after);
        if (!m) return null;
        seg = { t: 'key', k: m[0] };
        used = m[0].length;
      }
      segs.push(deep ? { t: 'deep', next: seg } : seg);
      i += (deep ? 2 : 1) + used;
      continue;
    }
    const quoted = /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest);
    if (quoted) {
      segs.push({ t: 'key', k: quoted[1].replace(/\\(.)/g, '$1') });
      i += quoted[0].length;
      continue;
    }
    const bracket = /^\[(\d+|\*|\d+:)\]/.exec(rest);
    if (!bracket) return null;
    const v = bracket[1];
    if (v === '*') segs.push({ t: 'any' });
    else if (v.endsWith(':')) segs.push({ t: 'from', i: Number(v.slice(0, -1)) });
    else segs.push({ t: 'idx', i: Number(v) });
    i += bracket[0].length;
  }
  return segs;
}

// One step of the path against one step of the dropped part's path.
function stepMatches(p: Seg, t: Seg): boolean {
  if (p.t === 'any') return true;
  if (p.t === 'key') return t.t === 'key' && t.k === p.k;
  if (p.t === 'idx') return (t.t === 'idx' && t.i === p.i) || (t.t === 'from' && p.i >= t.i);
  return false;
}

// Can a value the path matches lie at, under or above the dropped part?
function reaches(p: Seg[], t: Seg[]): boolean {
  if (t.length === 0 || p.length === 0) return true;
  const [head, ...rest] = p;
  if (head.t === 'deep') {
    return reaches([head.next, ...rest], t) || reaches(p, t.slice(1));
  }
  return stepMatches(head, t[0]) && reaches(rest, t.slice(1));
}

// The dropped part `jsonPath` reads into, or null. A pruned answer lost `$.raw`.
export function droppedPartFor(jsonPath: string, trimmedPaths: string[], pruned: boolean): string | null {
  const p = parsePath(jsonPath);
  if (!p) return null;
  for (const dropped of [...trimmedPaths, ...(pruned ? ['$.raw'] : [])]) {
    const t = parsePath(dropped);
    if (t && reaches(p, t)) return dropped;
  }
  return null;
}

// "raw.sources" for `$.raw.sources`, "raw.items from item 4 on" for a cut
// tail, "the whole answer" for `$` (the panel words it the same way).
export function droppedLabel(path: string): string {
  if (path === '$') return 'the whole answer';
  const tail = /\[(\d+):\]$/.exec(path);
  const base = path.replace(/\[\d+:\]$/, '').replace(/^\$\.?/, '') || 'the answer';
  return tail ? `${base} from item ${Number(tail[1]) + 1} on` : base;
}
