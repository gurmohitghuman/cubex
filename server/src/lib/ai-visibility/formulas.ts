// The free formula columns of an AI visibility table (pure): each engine's
// "You in <engine>" (your brand's place among the brands its answer names,
// "1st of 4", or "Not named"), "Named by" (how many of the engines that
// answered name you), "Named first" (the brand most engines name first), a
// check's "Change since <date>" and the cited sites' "Your site". A brand is found as a whole word, ignoring
// case and accents; its place is where the answer first names it, and a name
// inside a longer one found there ("Acme" in "Acme CRM") counts once, as the
// longer. The brand list sits between marker comments, so editing it rewrites
// only that part of each formula, whatever its columns are called by then.
const MATCHER = String.raw`
  const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const word = c => !!c && /[\p{L}\p{N}]/u.test(c);
  const at = (t, b) => {
    const k = fold(b);
    for (let i = k ? t.indexOf(k) : -1; i >= 0; i = t.indexOf(k, i + 1)) {
      if (!word(t[i - 1]) && !word(t[i + k.length])) return i;
    }
    return -1;
  };
  const named = t => {
    const h = B.map((b, i) => [at(t, b), i, fold(b).length]).filter(x => x[0] >= 0)
      .sort((x, y) => x[0] - y[0] || y[2] - x[2]);
    const out = [];
    let end = -1;
    for (const x of h) if (x[0] >= end) { out.push(x[1]); end = x[0] + x[2]; }
    return out;
  };`;

const BRANDS_RE = /\/\* brands \*\/[\s\S]*?\/\* end \*\//;
const brandList = (brands: readonly string[]) => `/* brands */ ${JSON.stringify(brands)} /* end */`;
const domainText = (domain: string | null) => `/* domain */ ${JSON.stringify(domain ?? '')} /* end */`;
const ref = (column: string) => `{{${column}}}`;

// brands: yours first, then the others to look for.
export function youFormula(answerColumn: string, brands: readonly string[]): string {
  return String.raw`(() => {
  const B = ${brandList(brands)};${MATCHER}
  const t = fold(${ref(answerColumn)});
  if (!t) return '';
  const n = named(t), me = n.indexOf(0) + 1;
  if (!me) return 'Not named';
  const th = me % 100 > 10 && me % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][me % 10] || 'th';
  return me + th + ' of ' + n.length;
})()`;
}

// Reads the answers themselves, never the "You in" columns: a formula column
// follows what runs and people write, not another formula column.
export function namedByFormula(answerColumns: readonly string[], brands: readonly string[]): string {
  return String.raw`(() => {
  const B = ${brandList(brands)};${MATCHER}
  const v = [${answerColumns.map(ref).join(', ')}].map(fold).filter(t => t);
  if (!v.length) return '';
  return v.filter(t => named(t).includes(0)).length + ' of ' + v.length;
})()`;
}

// "Change since <date>" (a check again, services/ai-visibility-check.ts): how
// many engines name you now, from the answers as "Named by" counts them,
// against the "3 of 5" kept that day (a lookup column, `thenColumn`): "Up 2",
// "Down 1" or "Same"; "New" for a question with no answers then (added or
// edited since). Blank while a different number of engines has answered than
// then (a rerun fills one engine at a time; one failed, or was added): counts
// over other engines can't be compared. It counts
// with the brands of that day (its own marker, which set_brands leaves alone):
// the count it compares with was made with them.
export function changeFormula(
  answerColumns: readonly string[], thenColumn: string, brands: readonly string[],
): string {
  return String.raw`(() => {
  const B = /* brands then */ ${JSON.stringify(brands)} /* end */;${MATCHER}
  const v = [${answerColumns.map(ref).join(', ')}].map(fold).filter(t => t);
  if (!v.length) return '';
  const then = /^\s*(\d+) of (\d+)\s*$/.exec(String(${ref(thenColumn)} == null ? '' : ${ref(thenColumn)}));
  if (!then) return 'New';
  if (v.length !== Number(then[2])) return '';
  const d = v.filter(t => named(t).includes(0)).length - Number(then[1]);
  return d > 0 ? 'Up ' + d : d < 0 ? 'Down ' + -d : 'Same';
})()`;
}

export function namedFirstFormula(answerColumns: readonly string[], brands: readonly string[]): string {
  return String.raw`(() => {
  const B = ${brandList(brands)};${MATCHER}
  const firsts = [${answerColumns.map(ref).join(', ')}].map(fold).filter(t => t).map(t => named(t)[0])
    .filter(i => i !== undefined);
  if (!firsts.length) return '';
  const c = [];
  firsts.forEach(i => { c[i] = (c[i] || 0) + 1; });
  return B[firsts.reduce((best, i) => (c[i] > c[best] ? i : best), firsts[0])];
})()`;
}

export function yourSiteFormula(domainColumn: string, domain: string | null): string {
  return `(() => {
  const mine = ${domainText(domain)};
  const d = String(${ref(domainColumn)} == null ? '' : ${ref(domainColumn)}).toLowerCase();
  return mine && d && (d === mine || d.endsWith('.' + mine)) ? 'Yes' : '';
})()`;
}

// A formula this table made with another brand list (null: it holds none).
export const withBrands = (formula: string, brands: readonly string[]): string | null =>
  (BRANDS_RE.test(formula) ? formula.replace(BRANDS_RE, () => brandList(brands)) : null);
