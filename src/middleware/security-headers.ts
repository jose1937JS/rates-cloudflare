import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';

export const securityHeadersMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
});
