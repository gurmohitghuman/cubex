import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Return the URL only if it's a safe http(s) link, else undefined. AI-citation
// URLs come from model output / web-fetch results, so a `javascript:` URL
// rendered as href would execute on click (React 18 doesn't block it). Use this
// for any href built from untrusted data. Mirrors LoadingCellRenderer's guard.
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  return (url.startsWith('http://') || url.startsWith('https://')) ? url : undefined
}

// BIDI controls (U+202E RTL-override, LRM/RLM/ALM, embeddings/overrides,
// isolates) — kept in sync with the server's isBidiControl (lib/csv-safety.ts).
function isBidiControl(code: number): boolean {
  return code === 0x200e || code === 0x200f || code === 0x061c
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069)
}

// Strip ASCII control characters (except newline 0x0A and tab 0x09) AND Unicode
// BIDI controls. MUST stay byte-for-byte identical to the server's
// stripControlChars (lib/csv-safety.ts): the server strips on write, so a cell
// edit that optimistically shows '\r' (a CRLF paste) or a U+202E spoof char would
// mismatch the persisted value and silently diverge until a reload. Stripping
// here makes the optimistic value == persisted.
export function stripControlChars(s: string): string {
  if (!s) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code === 0x0a || code === 0x09) { out += s[i]; continue }
    if (code < 0x20) continue
    if (code >= 0x7f && code <= 0x9f) continue
    if (isBidiControl(code)) continue
    out += s[i]
  }
  return out
}

// Client pre-guard truncation for the basic-cell size cap (P2-8). Cuts to at
// most `max` UTF-16 units WITHOUT splitting a surrogate pair — a hard
// slice(0, max) could leave a lone high surrogate at the boundary (a value the
// server would then have to accept as it's not > max). No marker: the caller
// toasts the user, and the value must round-trip as exactly what the server
// stores (manual edits are gated ≤ max server-side, not re-truncated).
export function clampCellCharsClient(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = max
  const boundary = s.charCodeAt(cut - 1)
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1 // drop a trailing lone high surrogate
  return s.slice(0, cut)
}

// "1 row", "2 rows", "1,000 rows".
export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}
