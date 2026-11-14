import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  );
}

export const corsMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin) {
    await next();
    return;
  }

  const allowedOrigins = parseAllowedOrigins(c.env?.ALLOWED_ORIGINS);
  if (!allowedOrigins.has(origin)) {
    return c.json({ error: 'Forbidden: Origin not allowed' }, 403);
  }

  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  c.header('Access-Control-Max-Age', '86400');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});
