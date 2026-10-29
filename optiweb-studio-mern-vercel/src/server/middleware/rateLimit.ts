/**
 * In-process sliding-window rate limiter.
 *
 * Scope note: state lives in module memory, which is correct for a single
 * Node instance. On horizontally scaled deployments the limiter must move to a
 * shared store (Redis) — documented in docs/deployment.md.
 */
import { rateLimits, type RateLimitBucket } from "@/server/config/env";

type Hit = { count: number; resetAt: number };

const buckets = new Map<string, Hit>();
const MAX_TRACKED_KEYS = 5_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
};

export function consumeRateLimit(bucket: RateLimitBucket, key: string): RateLimitResult {
  const config = rateLimits[bucket];
  const now = Date.now();
  const mapKey = `${bucket}:${key}`;
  const existing = buckets.get(mapKey);

  if (!existing || existing.resetAt <= now) {
    if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();
    buckets.set(mapKey, { count: 1, resetAt: now + config.windowMs });
    return {
      allowed: true,
      remaining: config.capacity - 1,
      retryAfterSeconds: 0,
      limit: config.capacity,
    };
  }

  existing.count += 1;
  const allowed = existing.count <= config.capacity;
  return {
    allowed,
    remaining: Math.max(0, config.capacity - existing.count),
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
    limit: config.capacity,
  };
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}
