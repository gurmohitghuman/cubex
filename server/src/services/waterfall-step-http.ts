// An HTTP API step of a waterfall row: the step's request with {{input}}
// templates filled from the row's inputs, sent exactly as an HTTP API column
// sends a row (lib/http-request.ts sendHTTPRequest: cache check, SSRF guard,
// JSON only, saved keys only when the run's allow_secrets allows), tried again
// on what a retry can fix (lib/http-retry.ts), then the value read with its
// JSONPath. A failure is the step's error; the waterfall goes on.
import { sendHTTPRequest, redactSecrets } from '../lib/http-request';
import { nextRetryWait, retryPolicyOf, tryFailureOf, waitUnlessStopped } from '../lib/http-retry';
import { responseStatusOf } from '../lib/http-errors';
import { extractOutcome } from '../lib/jsonpath-extract';
import { normalizeResult } from '../lib/waterfall/result-type';
import { traceDetail, traceValue } from '../lib/waterfall/trace';
import { stepRequestConfig, type HttpChoices, type WaterfallBlock } from '../lib/waterfall/config';
import { STOP, type StepResult } from './waterfall-step-types';

export interface HttpStepArgs {
  w: WaterfallBlock;
  choices: HttpChoices;
  inputs: Record<string, string>;
  userId: string;
  runId: string;
  allowSavedKeys: boolean;
  signal: AbortSignal;
  stopped: () => boolean;
}

export async function httpStep(a: HttpStepArgs): Promise<StepResult> {
  const rc = stepRequestConfig(a.choices);
  const policy = retryPolicyOf({ retries: a.choices.retries ?? undefined });
  for (let attempt = 1; ; attempt++) {
    if (a.stopped()) return STOP;
    try {
      const ans = await sendHTTPRequest(rc, a.inputs, a.userId, a.signal, a.allowSavedKeys, a.runId);
      const got = extractOutcome(ans.data, a.choices.valuePath);
      if (got.error) {
        return { outcome: 'error', value: '', detail: traceDetail(`Value path: ${got.error}`), costUsd: 0 };
      }
      const raw = got.matched ? got.value : null;
      const value = normalizeResult(a.w.resultType, raw, a.w.phone);
      if (value) return { outcome: 'answered', value, costUsd: 0 };
      const shown = typeof raw === 'string' || typeof raw === 'number' ? traceValue(String(raw)) : undefined;
      return { outcome: 'not_found', value: '', costUsd: 0, ...(shown ? { got: shown } : {}) };
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError' || a.signal.aborted) return STOP;
      const wait = nextRetryWait(tryFailureOf(error), rc.method, attempt, policy, Date.now());
      if (wait === null) {
        const status = responseStatusOf(error);
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        const tries = attempt > 1 ? ` (tried ${attempt} times)` : '';
        const code = status !== null && !message.includes(String(status)) ? `HTTP ${status}: ` : '';
        return { outcome: 'error', value: '', detail: traceDetail(`${code}${message}${tries}`), costUsd: 0 };
      }
      if (!await waitUnlessStopped(wait, a.stopped, a.signal)) return STOP;
    }
  }
}
