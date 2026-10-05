// Cap raw response payloads sent in HTTP preview responses so the modal's
// JSON tree stays responsive and the preview round-trip doesn't drag on a 5MB
// upstream payload. Arrays larger than PREVIEW_MAX_ARRAY are truncated to the
// first N items so the user can still see "shape," with the rest flagged via
// a sentinel { __more: <count> } element. Objects are walked recursively.

const PREVIEW_MAX_BYTES = 100_000;
const PREVIEW_MAX_ARRAY = 50;

export function trimForPreview(value: unknown): unknown {
  try {
    const trimmed = trimArrays(value);
    const serialized = JSON.stringify(trimmed);
    if (serialized && serialized.length > PREVIEW_MAX_BYTES) {
      return { __truncated: true, __bytes: serialized.length, preview: serialized.slice(0, PREVIEW_MAX_BYTES) };
    }
    return trimmed;
  } catch {
    return null;
  }
}

function trimArrays(v: unknown): unknown {
  if (Array.isArray(v)) {
    const sliced = v.slice(0, PREVIEW_MAX_ARRAY).map(trimArrays);
    return v.length > PREVIEW_MAX_ARRAY ? [...sliced, { __more: v.length - PREVIEW_MAX_ARRAY }] : sliced;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = trimArrays(val);
    return out;
  }
  return v;
}
