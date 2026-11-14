import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_MS = 60_000;

const rateLimitStore = new Map<string, RateLimitBucket>();

export function resetRateLimitStore(): void {
  rateLimitStore.clear();
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(c: Context<{ Bindings: Env }>): string {
  const cfIp = c.req.header('CF-Connecting-IP')?.trim();
  if (cfIp) return cfIp;

  const forwarded = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;

  return 'unknown';
}

function pruneExpiredBuckets(now: number): void {
  if (rateLimitStore.size < 1000) return;
  for (const [key, bucket] of rateLimitStore.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const maxRequests = parsePositiveInt(c.env?.RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS);
  const windowMs = parsePositiveInt(c.env?.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  const now = Date.now();

  pruneExpiredBuckets(now);

  const clientIp = getClientIp(c);
  const existing = rateLimitStore.get(clientIp);
  const bucket: RateLimitBucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

  bucket.count += 1;
  rateLimitStore.set(clientIp, bucket);

  const remaining = Math.max(0, maxRequests - bucket.count);
  const resetEpochSeconds = Math.ceil(bucket.resetAt / 1000);

  c.header('X-RateLimit-Limit', String(maxRequests));
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Reset', String(resetEpochSeconds));

  if (bucket.count > maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  await next();
});
