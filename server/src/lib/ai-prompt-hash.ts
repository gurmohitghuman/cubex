// The key a prompt's token history is found by (ai_runs.prompt_hash and
// ai_preview_tokens.prompt_hash, migration 055): sha256 of the prompt text as
// the run stores it.
import { createHash } from 'crypto';

export const promptHash = (prompt: string): string => createHash('sha256').update(prompt, 'utf8').digest('hex');
