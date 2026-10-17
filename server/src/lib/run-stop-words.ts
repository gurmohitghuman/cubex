// The sentence a sheet-wide stop answers with (services/sheet-runs.ts): what
// it stopped, what goes on, and where auto-run still starts runs. The app's
// toast, the REST answer and MCP's control_run all show it as is.

export interface StopWordsInput {
  runs: string[];     // the columns of the runs it stopped
  setups: string[];   // the setups it stopped
  paused: string[];   // auto-run columns whose batch it stopped: paused until resumed
  autoOn: string[];   // auto-run columns still on: new rows start runs there
  filling: string[];  // free clean, formula and stored-answer fills, which finish on their own
}

const MAX_NAMED = 5;

// "A", "A" and "B", "A", "B" and "C", or the first few and how many more.
export function namesList(names: string[]): string {
  const quoted = [...new Set(names)].map(n => `"${n}"`);
  if (quoted.length > MAX_NAMED) {
    return `${quoted.slice(0, MAX_NAMED).join(', ')} and ${quoted.length - MAX_NAMED} more`;
  }
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function stopWords(w: StopWordsInput): string {
  const out: string[] = [];
  if (w.runs.length === 0 && w.setups.length === 0) out.push('Nothing was running on this sheet.');
  if (w.runs.length) out.push(`Stopped ${count(w.runs.length, 'run')}: ${namesList(w.runs)}.`);
  if (w.setups.length) {
    out.push(`Stopped ${w.setups.length === 1 ? 'the setup' : 'the setups'} ${namesList(w.setups)}.`);
  }
  if (w.runs.length) out.push('Calls already sent finish, and paid ones are still billed.');
  if (w.paused.length) out.push(`Auto-run on ${namesList(w.paused)} is paused until you resume it.`);
  if (w.autoOn.length) {
    out.push(`Auto-run is still on for ${namesList(w.autoOn)}, so new rows will start runs there again.`);
  }
  if (w.filling.length) out.push(`Still filling for free and finishing on their own: ${namesList(w.filling)}.`);
  return out.join(' ');
}
