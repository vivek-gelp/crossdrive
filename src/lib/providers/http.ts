/**
 * fetch with throttling back-off for Microsoft Graph and Dropbox. Both answer
 * 429 (and Graph sometimes 503) with a Retry-After header in seconds; we
 * honour it (capped) and retry a few times before giving up with a
 * ProviderError that the transfer engine treats as transient.
 */
import { currentProviderFetch, providerSleep } from "./env";

export const MAX_RETRIES = 4;
/** Never sleep longer than this per attempt inside one request, so a slice keeps its time budget. */
export const MAX_RETRY_AFTER_MS = 30_000;
export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000];

export function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get("retry-after");
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Math.min(Number(h) * 1000, MAX_RETRY_AFTER_MS);
  if (h) {
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)]!;
}

/**
 * Perform a request, retrying on 429 and 503/504 (throttling / temporary
 * unavailability; the request was not applied). Other statuses are returned
 * to the caller untouched. `init` must be replayable (no one-shot streams).
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, retries = MAX_RETRIES): Promise<Response> {
  const f = currentProviderFetch();
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, init);
    const retryable = res.status === 429 || res.status === 503 || res.status === 504;
    if (!retryable || attempt >= retries) return res;
    await res.arrayBuffer().catch(() => undefined);
    await providerSleep(retryAfterMs(res, attempt));
  }
}

/** Wrap a web ReadableStream as an async iterable. */
export async function* iterateStream(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value && value.length) yield value;
    }
  } finally {
    // A consumer that stops early (slice budget) must not leave the HTTP body half-read.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
