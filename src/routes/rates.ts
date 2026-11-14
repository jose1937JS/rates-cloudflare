import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { ratesRepository } from '../db/rates.repository';
import {
  currencyHistoryQuerySchema,
  currencyParamSchema,
  ratesQuerySchema,
} from '../schemas/rates.schema';
import type { Env } from '../types/env';

export const ratesRoutes = new Hono<{ Bindings: Env }>();

ratesRoutes.get('/', zValidator('query', ratesQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const result = await ratesRepository.findPaginated(c.env.DB, query);
  return c.json(result);
});

ratesRoutes.get('/today', async (c) => {
  const rates = await ratesRepository.findTodayWithFallback(c.env.DB);
  return c.json({ rates });
});

ratesRoutes.get('/:currency', zValidator('param', currencyParamSchema), async (c) => {
  const { currency } = c.req.valid('param');
  const rate = await ratesRepository.findLatestByCurrency(c.env.DB, currency);

  if (!rate) {
    return c.json({ error: `No rate found for currency ${currency}` }, 404);
  }

  return c.json({ rate });
});

ratesRoutes.get(
  '/:currency/all',
  zValidator('param', currencyParamSchema),
  zValidator('query', currencyHistoryQuerySchema),
  async (c) => {
    const { currency } = c.req.valid('param');
    const query = c.req.valid('query');

    const result = await ratesRepository.findPaginated(c.env.DB, {
      ...query,
      currency,
    });

    return c.json(result);
  }
);
