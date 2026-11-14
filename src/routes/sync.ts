import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { syncQuerySchema } from '../schemas/rates.schema';
import { syncService } from '../services/sync.service';
import type { Env } from '../types/env';

export const syncRoutes = new Hono<{ Bindings: Env }>();

syncRoutes.post('/', zValidator('query', syncQuerySchema), async (c) => {
  const { source } = c.req.valid('query');

  try {
    const result = await syncService.sync(c.env, source);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    return c.json({ error: message }, 502);
  }
});
