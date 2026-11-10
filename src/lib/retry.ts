/**
 * Retry for Google REST calls (Drive and Gmail clients): exponential backoff
 * with jitter, honouring Retry-After, at most MAX_TRIES attempts.
 *  - 429 and 403 with reason rateLimitExceeded / userRateLimitExceeded are
 *    retried for every call that is safe to repeat (Google did not process it);
 *  - 5xx only for idempotent calls (a POST that creates something is not
 *    retried on 5xx because it may have been applied);
 *  - calls marked `noRetry` (sending mail) are never retried.
 */

export const MAX_TRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Under Vitest the default is not to wait; retry tests install their own sleep to observe delays.
let sleepImpl: Sleep = process.env.VITEST ? async () => undefined : realSleep;

/** Test seam: replace the sleep between attempts (undefined restores the default). */
export function setRetrySleep(f: Sleep | undefined) {
  sleepImpl = f ?? (process.env.VITEST ? async () => undefined : realSleep);
}

export interface RetryOpts {
  /** True when repeating the request cannot apply it twice (GET, PATCH, PUT, DELETE). Enables retry on 5xx. */
  idempotent: boolean;
  /** Never retry (e.g. sending mail). */
  noRetry?: boolean;
}

/** Delay before attempt `attempt + 1` (attempt is 1-based): Retry-After when given, else capped exponential backoff with jitter. */
export function retryDelayMs(attempt: number, retryAfter?: string | null, rand: () => number = Math.random, now = Date.now()): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
  }
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(cap / 2 + rand() * (cap / 2));
}

const RATE_REASONS = new Set(["ratelimitexceeded", "userratelimitexceeded", "rate_limit_exceeded"]);

/** True when a 403 body says the request was rate limited (and nothing else). */
export async function isRateLimited403(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { errors?: { reason?: string }[]; details?: { reason?: string }[]; status?: string } };
    const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) => (e.reason ?? "").toLowerCase());
    return reasons.some((r) => RATE_REASONS.has(r)) || body.error?.status === "RESOURCE_EXHAUSTED";
  } catch {
    return false;
  }
}

async function shouldRetry(res: Response, opts: RetryOpts): Promise<boolean> {
  if (opts.noRetry) return false;
  if (res.status === 429) return true;
  if (res.status === 403) return isRateLimited403(res);
  if (res.status >= 500 && res.status <= 599) return opts.idempotent;
  return false;
}

/** `fetch` with retries; returns the last response (ok or not) for the caller's own error handling. */
export async function fetchWithRetry(fetchImpl: typeof fetch, url: string, init: RequestInit, opts: RetryOpts): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      // Network errors: only idempotent calls are repeated.
      if (opts.noRetry || !opts.idempotent || attempt >= MAX_TRIES) throw e;
      await sleepImpl(retryDelayMs(attempt));
      continue;
    }
    if (res.ok || attempt >= MAX_TRIES || !(await shouldRetry(res, opts))) return res;
    await sleepImpl(retryDelayMs(attempt, res.headers.get("retry-after")));
  }
}

/** HTTP methods that are safe to repeat. */
export function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "PUT" || m === "PATCH" || m === "DELETE";
}
