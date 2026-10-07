// Which inputs a lookup has, counting what treg derives (pure). A waterfall's
// contract says how treg fills a key from others (`derive`: full_name from
// first_name + last_name, linkedin_handle from linkedin_url…), and treg calls
// a provider only with an identity it accepts. Shared by the request builder
// (is one identity set complete?) and the estimate (which providers can answer
// the inputs a user mapped?).

// The keys a derive rule reads: "join(first_name, last_name)" → first_name,
// last_name. Only names the tool declares count, so a function name such as
// "join" (or "linkedin_url(...)" deriving linkedin_url itself) never does.
function deriveRefs(key: string, expr: string, known: Set<string>): string[] {
  return (expr.match(/[a-z_][a-z0-9_]*/g) ?? []).filter(r => r !== key && known.has(r));
}

// A key is there when it was sent, or when treg can derive it from keys that
// were: all of them for "join(first_name, last_name)", any one for
// "coalesce(email_domain(email), host(website))".
export function keyAvailable(
  key: string, sent: Set<string>, derive: Record<string, string> | null, known: Set<string>,
): boolean {
  if (sent.has(key)) return true;
  const expr = derive?.[key];
  if (!expr) return false;
  const refs = deriveRefs(key, expr, known);
  if (refs.length === 0) return false;
  return /^\s*coalesce\s*\(/.test(expr) ? refs.some(r => sent.has(r)) : refs.every(r => sent.has(r));
}

export function setAvailable(
  set: string[], sent: Set<string>, derive: Record<string, string> | null, known: Set<string>,
): boolean {
  return set.every(k => keyAvailable(k, sent, derive, known));
}

// A waterfall provider can answer when one of the identities it accepts is
// available. A provider whose accepted identities the catalog doesn't list is
// assumed able to (treg decides at call time).
export function providerCanAnswer(
  accepts: string[][], sent: Set<string>, derive: Record<string, string> | null, known: Set<string>,
): boolean {
  if (accepts.length === 0) return true;
  return accepts.some(set => setAvailable(set, sent, derive, known));
}
