import { redactSecrets } from './redact';

// Reading + bounding an undici response body. Split out of http-request.ts (one
// responsibility per file): the request orchestration there stays focused on
// guard → rate limit → fetch → validate, and the streaming/size mechanics live
// here.

// Read an undici response body to a string, destroying the stream and throwing if
// it exceeds `cap` bytes — so a public endpoint returning 100MB can't be buffered
// into memory.
export const readBoundedBody = async (
  body: AsyncIterable<unknown>,
  cap: number,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    totalBytes += chunk.byteLength;
    if (totalBytes > cap) {
      (body as any).destroy?.(new Error('Response too large'));
      throw new Error(`Response exceeds the ${(cap / 1024 / 1024).toFixed(0)}MB cap.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
};

// Read up to ~4KB of a non-2xx response body for an error message, REDACTED.
// Upstream 401/403/429 bodies routinely echo the offending key (Stripe, Twilio,
// OpenAI all do this), and this snippet ends up persisted into
// http_results.error_message AND logged — so redact before returning. Returns ''
// if the body was already destroyed / unreadable.
export const readErrorSnippet = async (body: any): Promise<string> => {
  try {
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      errBytes += chunk.byteLength;
      if (errBytes > 4096) { body.destroy(); break; }
      errChunks.push(chunk);
    }
    return redactSecrets(Buffer.concat(errChunks).toString('utf-8').slice(0, 400));
  } catch {
    return ''; // body already destroyed by undici
  }
};
