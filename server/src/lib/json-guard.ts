import { WEBHOOK_MAX_JSON_DEPTH, WEBHOOK_MAX_JSON_NODES } from './constants';

// Structural guard on an ALREADY-PARSED webhook payload. Runs AFTER JSON.parse
// (we trust V8's parser — no DIY JSON parsing) and BEFORE any extraction/write.
// Bounds the cost of the per-mapping json_set writes and the delivery-store size
// against a pathologically nested or huge object.
//
// Plain structural traversal — not parsing, not crypto — so hand-rolling is
// correct (NOT a new dependency). Iterative with an explicit stack so a deeply
// nested payload can't blow the call stack before the depth cap rejects it.

export interface JsonGuardResult {
  ok: boolean;
  reason?: string;
}

export function checkPayloadShape(
  root: unknown,
  maxDepth: number = WEBHOOK_MAX_JSON_DEPTH,
  maxNodes: number = WEBHOOK_MAX_JSON_NODES,
): JsonGuardResult {
  // Scalars / null at the root are trivially fine (the row still lands; mappings
  // just won't resolve). Only objects/arrays need bounding.
  if (root === null || typeof root !== 'object') return { ok: true };

  let nodes = 0;
  // Stack of [value, depth]. Depth of the root container is 1.
  const stack: Array<[unknown, number]> = [[root, 1]];

  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;

    if (depth > maxDepth) {
      return { ok: false, reason: `Payload nests deeper than the ${maxDepth}-level limit.` };
    }

    // Iterate WITHOUT materializing the children: Object.values() on a wide
    // object (a 512 KB body can hold ~48k short keys) would allocate the whole
    // array before the per-child node-cap check could fire — defeating the
    // guard's "reject huge objects cheaply" intent. Index/for-in iteration lets
    // the maxNodes check short-circuit mid-object.
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        nodes++;
        if (nodes > maxNodes) {
          return { ok: false, reason: `Payload has more than the ${maxNodes}-node limit.` };
        }
        const child = value[i];
        if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
      }
    } else {
      const obj = value as Record<string, unknown>;
      for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        nodes++;
        if (nodes > maxNodes) {
          return { ok: false, reason: `Payload has more than the ${maxNodes}-node limit.` };
        }
        const child = obj[key];
        if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
      }
    }
  }

  return { ok: true };
}
