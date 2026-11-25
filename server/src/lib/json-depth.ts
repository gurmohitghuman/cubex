// How deep a parsed JSON body nests (arrays and objects inside each other), for the /api/v1 and /mcp routers: a
// body nested deeper than MAX_JSON_DEPTH is refused with a 400 before any route reads it. No tool takes anything
// near that deep, but a run start that hashes or copies its arguments could overflow on one (a 10 KB body nests
// about 3,000 levels), answering 500. Walked with a stack, not recursion, and stops at the first level too deep.
import { MAX_JSON_DEPTH } from './api-v1-constants';

export { MAX_JSON_DEPTH };
export const TOO_DEEP = `The request nests arrays or objects more than ${MAX_JSON_DEPTH} levels deep. `
  + 'Send a flatter body.';

export function jsonTooDeep(value: unknown, max = MAX_JSON_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}
