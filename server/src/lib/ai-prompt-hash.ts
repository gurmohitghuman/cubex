// The key a prompt's token history is found by (ai_runs.prompt_hash and
// ai_previews.prompt_hash, migration 055): sha256 of the prompt text as the run
// stores it, with its system prompt (it changes what each row sends) and how
// many typed output columns it fills (0: one plain column; their JSON changes
// the answer's size). The count, not the names: a column rename changes no
// count, so a rename only rehashes the prompts it rewrites. A plain prompt
// with neither hashes as its text alone.
import { createHash } from 'crypto';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function promptHash(prompt: string, systemPrompt?: string | null, outputs = 0): string {
  return !systemPrompt && !outputs ? sha256(prompt) : sha256(JSON.stringify([prompt, systemPrompt || null, outputs]));
}

// How many output columns a stored run fills (ai_runs.output_columns, JSON; null: one plain column).
export function storedOutputCount(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const specs: unknown = JSON.parse(json);
    return Array.isArray(specs) ? specs.length : 0;
  } catch { return 0; }
}
