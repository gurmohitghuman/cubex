import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { AI_PREVIEW_CONCURRENCY } from '../lib/constants';
import { parsePreviewRequest, previewErrorMessage } from './ai-preview-parse';
import { NO_MODEL_ERROR, resolveAiModel } from '../lib/ai-model-resolve';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { samplePreviewRows } from '../lib/ai-preview-sample';
import {
  upsertDraftConfig, saveDraftPreview, computeInputHash,
  type DraftConfig, type DraftPreviewRow,
} from '../lib/ai-drafts';
import { getOpenRouterClient } from '../services/openrouter';
import { processOneRow } from './ai-preview-runner';
import {
  acquirePreviewSlot, releasePreviewSlot, MAX_ACTIVE_PREVIEWS_PER_USER,
} from '../lib/ai-preview-concurrency';

const router = express.Router();
router.use(authenticateToken);

// Preview calls OpenRouter for up to AI_PREVIEW_CONCURRENCY×N rows per request.
// Without a per-route limiter (only the global 1000/15min backstop), a logged-in
// user could fire ~20k LLM calls in a window. Reuse the same per-user budget as
// /ai/run and /http/preview so preview can't be hammered for uncontrolled cost.
router.post('/preview', async (req: AuthRequest, res) => {
  // Per-user CONCURRENT-batch cap (Bug B). The rate limiter bounds start RATE;
  // this bounds how many batches run AT ONCE — necessary because a batch now
  // finishes even after client disconnect, so disconnect-and-repeat would
  // otherwise stack unbounded background OpenRouter work. Acquire AFTER the
  // limiter (over-cap retries still spend a rate token), release in the finally
  // wrapping the whole batch so a disconnect / throw / normal finish all
  // decrement exactly once.
  if (!acquirePreviewSlot(req.userId!)) {
    return res.status(429).json({
      error: `You have ${MAX_ACTIVE_PREVIEWS_PER_USER} previews already running. Wait for one to finish before starting another.`,
    });
  }
  try {
    const parsed = parsePreviewRequest(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const {
      sheetId, cleanColumnName, prompt, systemPrompt, model: requestedModel,
      useOpenRouterWebSearch, useWebFetch,
      safePreviewSize, safeTemperature, safeConcurrency, safeMaxChars,
    } = parsed;

    const sheet = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
      .get(sheetId, req.userId!) as { row_generation: number } | undefined;
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Same resolution as /ai/run (explicit > sheet default > account default),
    // and the same rejection — a preview that ran on a model /run would refuse
    // would poison draft reuse with a config the run can't reproduce.
    const model = resolveAiModel(requestedModel, sheetId, req.userId!);
    if (!model) return res.status(400).json({ error: NO_MODEL_ERROR });

    // Same up-front /column reference gate as /ai/run: a preview full of
    // "[MISSING: /token]" wastes the iteration loop, and a run started from
    // its draft would now be rejected anyway (lib/prompt-ref-validate.ts).
    const refsError = unknownPromptRefsError(sheetId, req.userId!, prompt);
    if (refsError) return res.status(400).json({ error: refsError });

    // EXACT count of rows "Run All Rows" will process — UNFILTERED, matching
    // ai-run-start.ts. The client's sheetData.totalRows is filter-aware (it shrinks
    // when the empty-filter is on), so a cost estimate built from it would UNDERSTATE
    // the run. Send the real target count so the estimate can't show less than billed.
    const runTargetRows = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
      .get(sheetId, req.userId!) as { c: number }).c;

    const rows = samplePreviewRows(sheetId, req.userId!, safePreviewSize);
    if (rows.length === 0) return res.status(400).json({ error: 'No data available for preview' });

    let openai;
    try { openai = await getOpenRouterClient(req.userId!); }
    catch (e: any) { return res.status(400).json({ error: `AI setup error: ${e?.message || 'AI client initialization failed'}` }); }

    const args = { prompt, systemPrompt, model, safeTemperature, maxChars: safeMaxChars ?? undefined, useOpenRouterWebSearch, useWebFetch };

    // Persist the draft CONFIG before streaming (survives close/reopen even if
    // the stream is aborted mid-way). Results attach at stream END, all-or-
    // nothing — see lib/ai-drafts.ts. columnName stored in canonical clean form
    // so run-start promotion compares like-for-like.
    const draftConfig: DraftConfig = {
      columnName: cleanColumnName, prompt, systemPrompt: systemPrompt || null,
      model, temperature: safeTemperature,
      useOpenRouterWebSearch: !!useOpenRouterWebSearch, useWebFetch: !!useWebFetch,
      maxChars: safeMaxChars, concurrency: safeConcurrency,
    };
    // The attempt id keys this stream's end-of-stream save — a superseding
    // preview re-upserts with a new id, neutralizing this stream's late save.
    const draftAttemptId = upsertDraftConfig(req.userId!, sheetId, draftConfig, sheet.row_generation);

    // Stream rows as newline-delimited JSON (NDJSON) so the client renders each row
    // the instant OpenRouter returns it, instead of waiting for the slowest of all 5.
    // Preview is ephemeral (no DB persistence, no worker thread), so a streamed POST
    // body is the right-sized tool here — the DB-tail SSE in ai-stream.ts is for
    // durable runs and would force persisting throwaway preview state.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // tell any proxy (nginx) not to buffer the stream
    });

    // A client disconnect (tab close / reload / network drop — NOT a closed
    // drawer, which keeps its fetch open) used to ABORT generation: preview rows
    // were throwaway, so finishing them was pure spend. They aren't throwaway
    // anymore — every completed preview persists into the draft and is REUSED by
    // "Run All Rows" (credit reuse), so we now FINISH the remaining rows (bounded:
    // ≤20 rows, 60s per-row cap in processOneRow) and save them; only the writes
    // to the dead socket stop. Worst-case waste is a superseded preview's last
    // few rows — cents — vs. reliably losing paid-for rows on every mid-stream
    // close. Listen on BOTH req AND res 'close' — for a POST whose body Express
    // already consumed, the response-stream close is the reliable signal.
    let clientGone = false;
    const onClientGone = () => { clientGone = true; };
    req.on('close', onClientGone);
    res.on('close', onClientGone);

    // Guarded write: never write to a closed/ended socket (that throws
    // ERR_STREAM_WRITE_AFTER_END and would escape into the catch → double-send).
    // Returns false once the socket is gone so the caller can stop early.
    const writeLine = (obj: unknown): boolean => {
      if (clientGone || res.writableEnded) return false;
      try { res.write(JSON.stringify(obj) + '\n'); return true; }
      catch { clientGone = true; return false; }
    };

    // Rows fan out per chunk of AI_PREVIEW_CONCURRENCY (default 5 === default preview
    // size, so the common case is a single wave). Each row's `.then` writes its line
    // the moment IT resolves, so a fast row never waits on a slow sibling. For a
    // larger previewSize (up to 20) there are multiple chunks; chunk N+1 still waits
    // on the slowest row of chunk N, but within a chunk rows stream independently.
    // Results are also collected (indexed by previewIndex = display order) for the
    // draft — the inputHash is computed HERE from the exact row data the model saw,
    // so credit reuse can later refuse a row whose referenced cells changed.
    const collected: DraftPreviewRow[] = [];
    for (let i = 0; i < rows.length; i += AI_PREVIEW_CONCURRENCY) {
      const chunk = rows.slice(i, i + AI_PREVIEW_CONCURRENCY);
      await Promise.all(chunk.map((row, j) =>
        // processOneRow never throws (returns per-row errors), so Promise.all
        // won't reject. No external abort signal: the loop runs to completion
        // even after a disconnect (see the clientGone comment above).
        processOneRow(row, openai!, args).then(result => {
          collected[i + j] = {
            rowIndex: result.rowIndex, value: result.value,
            ...(result.error ? { error: result.error } : { inputHash: computeInputHash(prompt, row.data) }),
            promptTokens: result.promptTokens, completionTokens: result.completionTokens,
          };
          // Carry the server's INTENDED order (position in `rows`) so the client
          // renders in that order: rows stream out of order as they resolve.
          writeLine({ type: 'row', previewIndex: i + j, ...result });
        }),
      ));
    }

    // All-or-nothing: only a preview where EVERY row SUCCEEDED is hydrated/
    // reused. "Present" (filter(Boolean)) isn't enough — an errored row is a
    // truthy object with {error, no inputHash}, so a preview where every row
    // failed would otherwise persist and hydrate as a misleading "ready"
    // preview (with a cost estimate over rows that never really ran). Require
    // success + non-empty value + inputHash on every row — the exact predicate
    // promotePreviewReuse uses to pick reusable rows, so a saved preview is
    // wholly reusable by construction. Saved even when the client is gone (the
    // point of finishing rows: a reload/tab-close mid-preview still yields a
    // restorable, reusable draft). A superseding preview already re-upserted the
    // config, so the attempt-id guard makes a late save a no-op.
    const allSucceeded = collected.length === rows.length
      && collected.every(r => r && !r.error && r.value !== '' && !!r.inputHash);
    if (allSucceeded) {
      saveDraftPreview(req.userId!, sheetId, draftAttemptId, collected, runTargetRows);
    }

    if (writeLine({ type: 'done', totalRows: rows.length, runTargetRows })) res.end();
    else if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Preview error:', error);
    const errorMessage = previewErrorMessage(error);
    // Once the NDJSON stream has started, headers are already flushed — we can't
    // switch to a 500 JSON body. processOneRow never throws (it returns per-row
    // errors), so a throw reaching here is a pre-stream failure (validation, client
    // setup, the row DB reads) and headersSent is false. The guard is belt-and-braces:
    // if a stream somehow errored mid-flight, emit a trailing error line instead of
    // a double-send crash.
    if (res.headersSent) {
      // Don't write to an already-ended socket (client disconnect / done already sent).
      if (!res.writableEnded) {
        try { res.write(JSON.stringify({ type: 'error', error: errorMessage }) + '\n'); res.end(); } catch {}
      }
    } else {
      res.status(500).json({ error: errorMessage });
    }
  } finally {
    // Release the concurrency slot on EVERY exit — normal finish, thrown error,
    // or client disconnect (the batch loop runs to completion, then unwinds
    // here). Paired 1:1 with the acquire above; releasePreviewSlot is clamped so
    // a stray release can't drive the count negative.
    releasePreviewSlot(req.userId!);
  }
});

export default router;
