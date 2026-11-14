import { Hono } from 'hono';
import { ratesRepository } from '../db/rates.repository';
import type { Env } from '../types/env';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/', async (c) => {
  const ok = await ratesRepository.ping(c.env.DB);
  if (!ok) {
    return c.json({ status: 'error', timestamp: new Date().toISOString() }, 503);
  }

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
