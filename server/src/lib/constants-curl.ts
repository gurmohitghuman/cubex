// "Paste a cURL command" constants (lib/curl/), split out of constants.ts
// (200-line guardrail). Import via './constants', which re-exports this module.

// Longest command the parser reads. A pasted command carries its body inline,
// so this is generous; it bounds the tokenizer's work, not a quota.
export const CURL_MAX_CHARS = 100_000;

// Longest saved-key name a paste can create (names follow API_KEY_NAME_PATTERN).
export const CURL_KEY_NAME_MAX = 64;

// Most keys one command may hold. Each is a separate choice in the dialog; past
// this, a paste is refused rather than offered dozens of choices (or run an
// unbounded naming and matching pass on the server).
export const CURL_MAX_KEYS = 20;
