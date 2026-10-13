// OpenRouter's in-flight credit budget, checked before a run (pure). Each paid
// call holds an estimate of its cost while it runs: its input tokens plus the
// output max_tokens allows, at the model's prices (OpenRouter caps the output
// part at a fixed per-request amount, so this is an upper bound). The account
// may hold "a fraction of your current credit balance, up to a fixed ceiling"
// at once; a call past it is refused with 402 until running calls settle
// (https://openrouter.ai/docs/api_reference/limits). OpenRouter doesn't publish
// the fraction, so the balance gives only a ceiling, never a safe number. Free
// models and calls served entirely on your own provider key (BYOK, no paid
// plugins) aren't held.

export interface InFlight {
  concurrency: number;
  reserve_per_call_usd: number;
  reserve_at_concurrency_usd: number;
  // The account's credit balance, when OpenRouter shares it with this key.
  account_balance_usd: number | null;
  // Calls at once the whole balance could hold: an upper bound, since only a
  // part of it is allowed. null when the balance is unknown.
  concurrency_ceiling: number | null;
  note: string;
  warning?: string;
}

const usd = (n: number) => Math.round(n * 1e6) / 1e6;
// Below a cent, two significant figures ($0.00042), never a rounded-away $0.00.
const money = (n: number) => `$${n >= 0.01 || n === 0 ? n.toFixed(2) : String(Number(n.toPrecision(2)))}`;

export function inFlightCheck(a: {
  concurrency: number; inputTokens: number; maxTokens: number;
  promptPrice: number; completionPrice: number; balanceUsd: number | null;
}): InFlight | null {
  const perCall = a.inputTokens * a.promptPrice + a.maxTokens * a.completionPrice;
  if (!(perCall > 0)) return null;
  const atConcurrency = perCall * a.concurrency;
  const ceiling = a.balanceUsd === null ? null : Math.max(0, Math.floor(a.balanceUsd / perCall));
  const out: InFlight = {
    concurrency: a.concurrency, reserve_per_call_usd: usd(perCall), reserve_at_concurrency_usd: usd(atConcurrency),
    account_balance_usd: a.balanceUsd, concurrency_ceiling: ceiling,
    note: `Each running call holds up to ${money(perCall)} of OpenRouter credit (its input plus ${a.maxTokens} `
      + 'output tokens), and OpenRouter lets the account hold only part of its balance at once (it doesn\'t say '
      + 'how much). A call past that is refused with 402; Cubex waits and retries it a few times. '
      + (a.balanceUsd === null
        ? 'OpenRouter shares the balance only with a management key, so Cubex can\'t compare.'
        : 'If rows fail with error_class "concurrency", rerun them with a lower concurrency.'),
  };
  if (a.balanceUsd !== null && ceiling !== null && atConcurrency > a.balanceUsd) {
    const held = `At concurrency ${a.concurrency} this run can hold about ${money(atConcurrency)} at once, more than `
      + `the whole ${money(a.balanceUsd)} OpenRouter balance, so many calls will be refused (402).`;
    out.warning = ceiling >= 1
      ? `${held} Use a concurrency well under ${ceiling}, or add credits.`
      : `${held} Even one call needs more than that: add credits.`;
  }
  return out;
}
