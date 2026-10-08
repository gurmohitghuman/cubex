// What an enrichment keeps of treg's answer (pure). `output` and `_treg` stay
// whole (outputs, the answer panel and "add a field" read them); a provider's
// `raw` answer is trimmed to a byte budget by dropping its largest subtrees
// first, so what's left is still valid JSON, and `$trimmedPaths` says what went.
// A single tool's whole answer counts as raw.
import { ENRICH_STORED_RAW_MAX_BYTES } from './constants';
import { pathSegment } from './enrich-tool-io';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
const MAX_CUTS = 200;

// The biggest child of `node` (an object key or array index) with its path.
function biggestChild(node: unknown, path: string): { parent: Json | unknown[]; key: string | number; path: string; bytes: number } | null {
  let best: { parent: Json | unknown[]; key: string | number; path: string; bytes: number } | null = null;
  if (Array.isArray(node)) {
    node.forEach((v, i) => { const b = size(v); if (!best || b > best.bytes) best = { parent: node, key: i, path: `${path}[${i}]`, bytes: b }; });
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) { const b = size(v); if (!best || b > best.bytes) best = { parent: node, key: k, path: `${path}${pathSegment(k)}`, bytes: b }; }
  }
  return best;
}

// One cut that removes at least `excess` bytes where it can: walk into the
// heaviest object while one field alone holds more than that, cut a heavy
// list's tail (recorded as path[n:]), or drop the heaviest field.
function cutOnce(node: Json | unknown[], path: string, excess: number, trimmed: string[]): void {
  const pick = biggestChild(node, path);
  if (!pick) return;
  const child = (pick.parent as Record<string | number, unknown>)[pick.key];
  if (pick.bytes > excess && Array.isArray(child) && child.length > 1) {
    let removed = 0;
    while (child.length > 1 && removed < excess) removed += size(child.pop()) + 1;
    trimmed.push(`${pick.path}[${child.length}:]`);
    return;
  }
  if (pick.bytes > excess && isObj(child) && Object.keys(child).length > 1) { cutOnce(child, pick.path, excess, trimmed); return; }
  if (Array.isArray(pick.parent)) pick.parent.splice(pick.key as number, 1);
  else delete (pick.parent as Json)[pick.key as string];
  trimmed.push(pick.path);
}

// A copy of `value` trimmed to at most `max` bytes, and the paths it dropped.
export function trimJson(value: unknown, max: number, rootPath: string): { value: unknown; trimmed: string[] } {
  if (size(value) <= max) return { value, trimmed: [] };
  const copy = JSON.parse(JSON.stringify(value));
  const trimmed: string[] = [];
  if (!isObj(copy) && !Array.isArray(copy)) return { value: null, trimmed: [rootPath] };
  for (let cuts = 0, over = size(copy) - max; cuts < MAX_CUTS && over > 0; cuts++, over = size(copy) - max) {
    const before = trimmed.length;
    cutOnce(copy, rootPath, over, trimmed);
    if (trimmed.length === before) break;
  }
  if (size(copy) > max) return { value: null, trimmed: [rootPath] };
  return { value: copy, trimmed };
}

export function trimAnswer(body: unknown, routed: boolean, max = ENRICH_STORED_RAW_MAX_BYTES): unknown {
  if (routed && isObj(body)) {
    if (!('raw' in body)) return body;
    const { value, trimmed } = trimJson(body.raw, max, '$.raw');
    return trimmed.length ? { ...body, raw: value, $trimmedPaths: trimmed } : body;
  }
  const { value, trimmed } = trimJson(body, max, '$');
  if (!trimmed.length) return body;
  return isObj(value) ? { ...value, $trimmedPaths: trimmed } : { $answer: value, $trimmedPaths: trimmed };
}
