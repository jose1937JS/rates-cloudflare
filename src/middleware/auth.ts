import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return new Uint8Array(digest);
}

function timingSafeCompareBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  const subtleWithTimingSafe = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };

  if (typeof subtleWithTimingSafe.timingSafeEqual === 'function') {
    return subtleWithTimingSafe.timingSafeEqual(a, b);
  }

  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function extractApiKey(authHeader: string | undefined, apiKeyHeader: string | undefined): string | null {
  const xApiKey = apiKeyHeader?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  return null;
}

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = extractApiKey(c.req.header('Authorization'), c.req.header('X-API-Key'));
  const rawKeys = c.env?.API_SECRET_KEYS ?? '';
  const validKeys = rawKeys
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (!token || validKeys.length === 0) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const tokenDigest = await sha256(token);
  let matched = false;

  for (const validKey of validKeys) {
    const keyDigest = await sha256(validKey);
    if (timingSafeCompareBytes(tokenDigest, keyDigest)) {
      matched = true;
    }
  }

  if (!matched) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});
