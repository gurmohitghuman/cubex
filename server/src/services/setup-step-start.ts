// Starting one step of a setup on a sheet (setup-runner.ts): through the same
// start service its kind's dialog and tools use, so every check a column gets
// (its references, rule, model, JSONPaths, the outbound guard, caps, the busy
// sheet) applies unchanged. rowIndexes: a test on some rows (null: every row);
// clean and formula columns always fill every row (they're free), but a test
// leaves their auto-run off, as it leaves every auto-run off.
import { parseRunRequest } from '../routes/ai-run-parse';
import { startAiRun } from './ai-run-start';
import { startHttpRun } from './http-run-start';
import { startEnrichmentRun } from './enrich-run-start';
import { startCleanColumn } from './clean-column';
import { startFormulaColumn } from './formula-column';
import type { RunFail } from './run-shared';
import type { SetupStep } from '../lib/setups/spec';

// What a step started: an AI or HTTP run (an enrichment is an HTTP run), or a
// clean or formula column's record, whose fill is the work.
export type StepStarted = { kind: 'ai' | 'http'; runId: string } | { kind: 'clean' | 'formula'; recordId: string };

export async function startSetupStep(
  userId: string, sheetId: string, step: SetupStep,
  opts: { rowIndexes: number[] | null; allowSecrets: boolean },
): Promise<{ ok: StepStarted } | RunFail> {
  const targets = opts.rowIndexes ?? undefined;
  switch (step.kind) {
    case 'ai': {
      const parsed = parseRunRequest({
        sheetId, columnName: step.name, prompt: step.prompt, systemPrompt: step.systemPrompt ?? undefined,
        model: step.model ?? undefined, temperature: step.temperature, concurrency: step.concurrency ?? undefined,
        maxChars: step.maxChars ?? undefined, useOpenRouterWebSearch: step.webSearch, useWebFetch: step.webFetch,
        outputColumns: step.outputColumns ?? undefined, searchEngine: step.search?.engine,
        searchMode: step.search?.mode ?? undefined, maxSearchesPerRow: step.search?.maxPerRow ?? undefined,
        runIf: step.runIf,
      });
      if (!parsed.ok) return { fail: 'bad_request', message: parsed.error };
      const out = await startAiRun(userId, { ...parsed, targetRowIndexes: targets });
      return 'fail' in out ? out : { ok: { kind: 'ai', runId: out.ok.runId } };
    }
    case 'http': {
      const out = await startHttpRun(userId, {
        sheetId, masterColumnName: step.name, targetRowIndexes: targets, allowSecrets: opts.allowSecrets,
        config: {
          requestConfig: {
            method: step.request.method, url: step.request.url, headers: { ...step.request.headers },
            ...(step.request.body === null ? {} : { body: step.request.body }),
            ...(step.request.timeout === null ? {} : { timeout: step.request.timeout }),
          },
          responseMapping: step.mappings.map(m => ({ ...m })), previewSize: 3,
          ...(step.batchSize === null ? {} : { batchSize: step.batchSize }),
          ...(step.runIf ? { runIf: step.runIf } : {}),
        },
      });
      return 'fail' in out ? out : { ok: { kind: 'http', runId: out.ok.runId } };
    }
    case 'enrichment': {
      const { kind: _k, name, autoRun: _a, toolName: _t, ...choices } = step;
      const out = await startEnrichmentRun(userId, sheetId, {
        ...choices, columnName: name, continueColumn: false, spendLimitUsd: null, rowGeneration: null, list: null,
        rows: targets
          ? { mode: 'selected', status: 'any', test: null, rowIndexes: targets }
          : { mode: 'all', status: 'any', test: null, rowIndexes: null },
      });
      return 'fail' in out ? out : { ok: { kind: 'http', runId: out.ok.runId } };
    }
    case 'clean': {
      const out = await startCleanColumn(userId, sheetId, {
        source: step.source, cleaner: step.cleaner, column: step.name, options: step.options,
        autoRun: step.autoRun && !opts.rowIndexes,
      });
      return 'fail' in out ? out : { ok: { kind: 'clean', recordId: out.ok.id } };
    }
    case 'formula': {
      const out = await startFormulaColumn(userId, sheetId, {
        formula: step.formula, column: step.name, description: step.description,
        autoRun: step.autoRun && !opts.rowIndexes,
      });
      return 'fail' in out ? out : { ok: { kind: 'formula', recordId: out.ok.id } };
    }
  }
}
