interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec?: number;
}

/**
 * Fixed-window in-memory rate limiter. On Vercel this is best-effort only:
 * each function instance keeps its own counters, so the effective limit is
 * per-instance, not global. Deploy a global limiter (Upstash rate limit,
 * etc.) for hard guarantees.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { ok: true };
}

export function rateLimitedResponse(retryAfterSec: number): Response {
  return Response.json(
    { error: `Rate limit exceeded — retry in ${retryAfterSec}s` },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}
