// Extracting usable text out of an OpenRouter chat completion, split from
// lib/prompt.ts (200-line guardrail): prompt.ts owns /column-reference
// handling; this file owns completion-payload handling.

// Pull the usable cell text out of an OpenRouter chat completion, or THROW a
// descriptive error when the model returned nothing usable. The throw is
// deliberate: both the preview runner and the production row runner already wrap
// the OpenRouter call in a try/catch that turns a thrown error into a per-row
// failure (an "Error" badge in preview, a recorded `failed` + "❌ Error" cell in
// a run). Returning '' instead would write a SILENT blank cell with no error —
// the exact bug this fixes.
//
// Why a completion can have no content even with tools off:
//   - Reasoning/"thinking" models (DeepSeek V4, o-series, R1) burn the output
//     budget on reasoning and stop at finish_reason="length" with content=null.
//   - OpenRouter "zero-completion" responses (0 output tokens, null content).
//   - A refusal: the text lands in message.refusal, not message.content.
//   - content_filter blocked the output.
// In every case message.content is null/empty; we surface WHY instead of blank.
// Matches tool-call syntax that leaked into message.content as TEXT (the model
// should have used the structured tool_calls field, or OpenRouter should have
// executed it). Covers: DeepSeek DSML special-token blocks (`<｜｜DSML｜｜tool_calls>`
// and the `<｜…｜>` full-width-pipe variants), generic `<tool_call>`/`<tool▁call>`
// tags, and `<invoke name="…">` / `<function…>` fragments. Case-insensitive; a
// single match anywhere is enough to distrust the whole cell.
const LEAKED_TOOL_CALL_RE =
  /<[｜|].*?tool.?calls?.*?[｜|]?>|<\/?tool[_▁]?calls?\b|<invoke\s+name=|<function(?:_calls?)?\b|openrouter_web_(?:fetch|search)/i;

// A best-effort check that the content ALSO carries a real answer alongside the
// leaked markup — if so we don't fail (rare). Strips every leaked-tool-call
// block and asks whether meaningful prose survives. Conservative: only treats
// a decent chunk of leftover non-markup text as "resolved" so a stray word
// inside the markup doesn't mask a fully-leaked cell.
function hasResolvedAnswer(rawContent: string): boolean {
  const stripped = rawContent
    // Whole leaked blocks first (open→close), so their INNER text (urls, JSON
    // args) is removed too, not just the tags.
    .replace(/<[｜|][\s\S]*?tool.?calls?[\s\S]*?<\/[｜|][^>]*tool.?calls?[｜|]?>/gi, '')
    .replace(/<tool[_▁]?calls?\b[\s\S]*?<\/tool[_▁]?calls?[^>]*>/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    // Then any stray leftover tags/fragments + URLs.
    .replace(LEAKED_TOOL_CALL_RE, '')
    .replace(/https?:\/\/\S+/gi, '')
    // JSON-ish tool-arg remnants (e.g. {"name":"web_fetch"}) left after tags go.
    .replace(/\{[^{}]*"(?:name|url|arguments|parameters)"[^{}]*\}/gi, '')
    .trim();
  return stripped.length >= 8;
}

// opts.cleanMarkdown=false returns the model's text VERBATIM while keeping every
// error check below (empty / refusal / content-filter / length / unresolved tool
// call). Structured multi-column runs MUST pass false: their text is JSON, and
// cleanMarkdown mangles it two ways —
//   1. its inline-code rule eats two of the three backticks in a ```json fence,
//      leaving `json{...}` which ai-multi-output's stripCodeFence (anchored on
//      ```) can no longer match → JSON.parse throws → the row fails even though
//      the model answered correctly. Fencing is the default habit of most models.
//   2. it strips *, #, and backticks from INSIDE JSON string values, so a row
//      that does parse stores silently altered text ("rank #3" → "rank 3").
// Prose cells still want the cleaning — that is what it was written for.
export function extractCompletionText(
  completion: any,
  opts: { cleanMarkdown?: boolean } = {},
): string {
  const applyMarkdownCleaning = opts.cleanMarkdown !== false;
  const choice = completion?.choices?.[0];
  const message = choice?.message;
  const rawContent = typeof message?.content === 'string' ? message.content : '';

  // Unresolved tool call. When the model wants a tool (web_fetch/web_search) but
  // OpenRouter didn't run it, the model just STOPS at the tool call. Two shapes:
  //  - Structured: message.tool_calls populated / finish_reason='tool_calls',
  //    content empty → the empty-content path below already fails it cleanly.
  //  - Leaked as TEXT: some models (DeepSeek-family, `<｜｜DSML｜｜tool_calls>…`)
  //    render the tool call as plain text IN content — non-empty, so it would
  //    otherwise be written verbatim into the cell as garbage. Detect that and
  //    fail the row with the SAME clean error, so both shapes look identical to
  //    the user (fail, don't strip — stripping leaves an empty/misleading
  //    answer, worse for enrichment data).
  const finishReasonRaw: string | undefined = choice?.finish_reason ?? undefined;
  const hasStructuredToolCall =
    (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
    finishReasonRaw === 'tool_calls';
  const looksLikeLeakedToolCall = LEAKED_TOOL_CALL_RE.test(rawContent);
  if ((hasStructuredToolCall || looksLikeLeakedToolCall) && !hasResolvedAnswer(rawContent)) {
    throw new Error(
      'Model tried to call a tool that did not run (unresolved tool call). Try a different model, or turn off web search / URL fetching.',
    );
  }

  // Trim either way: a JSON payload padded with whitespace is still valid, and
  // the empty-content error paths below must fire on whitespace-only content
  // regardless of which mode we're in.
  const cleaned = applyMarkdownCleaning ? cleanMarkdown(rawContent) : rawContent.trim();
  if (cleaned) return cleaned;

  // No usable content — work out the most actionable reason for the error.
  const finishReason = finishReasonRaw;
  const refusal: string | undefined =
    typeof message?.refusal === 'string' && message.refusal.trim() ? message.refusal.trim() : undefined;

  if (refusal) throw new Error(`Model refused to answer: ${refusal}`);
  if (finishReason === 'content_filter') {
    throw new Error('Model output was blocked by a content filter.');
  }
  if (finishReason === 'length') {
    // Almost always a reasoning model exhausting the token budget before the
    // final answer. Point the user at the lever that fixes it.
    throw new Error(
      'Model returned no text (hit the output token limit, usually a reasoning model thinking past the budget). Try a non-reasoning model or a smaller prompt.',
    );
  }
  if (rawContent.trim()) {
    // The model DID return text, but it was pure markdown/formatting that
    // cleanMarkdown stripped to nothing. Rare, but don't report it as empty.
    // Unreachable in raw mode by construction: non-empty rawContent.trim()
    // would have returned above, so this only ever describes cleaned output.
    throw new Error('Model returned only formatting with no usable text.');
  }
  throw new Error(
    `Model returned an empty response${finishReason ? ` (finish_reason=${finishReason})` : ''}.`,
  );
}

// Strip common markdown formatting from AI output so cells contain plain text.
export function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s*(.*?)(?:\n|$)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
