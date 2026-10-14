// curl's --data-urlencode encoding: letters, digits and - . _ ~ stay, a space
// becomes +, every other byte becomes %XX. A shell variable's marker passes
// through unencoded (it becomes a {{NAME}} reference, filled in per row).
import { VAR_CLOSE, VAR_OPEN } from './shared';

const MARKER_SPLIT_RE = new RegExp(`(${VAR_OPEN}[A-Za-z_][A-Za-z0-9_]*${VAR_CLOSE})`);
// encodeURIComponent throws on a lone surrogate half; curl would send its bytes,
// which aren't valid text either, so the replacement character stands in.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function formEncode(s: string): string {
  return s.split(MARKER_SPLIT_RE).map((part, i) => (i % 2 === 1 ? part : encodePart(part))).join('');
}

function encodePart(s: string): string {
  return encodeURIComponent(s.replace(LONE_SURROGATE_RE, '\uFFFD'))
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}
