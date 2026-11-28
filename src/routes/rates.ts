import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  buildFallbackTiersResponseFromRate,
  formatUsdtP2PTiersResponse,
  ratesRepository,
  resolveUsdtRateForVesAmount,
} from '../db/rates.repository';
import {
  currencyHistoryQuerySchema,
  currencyParamSchema,
  ratesQuerySchema,
  usdtByAmountQuerySchema,
} from '../schemas/rates.schema';
import type { Env, UsdtRateByAmountResponse } from '../types/env';

export const ratesRoutes = new Hono<{ Bindings: Env }>();

async function safeFindUsdtTiers(db: D1Database) {
  try {
    return await ratesRepository.findUsdtP2pTiers(db);
  } catch {
    return [];
  }
}

ratesRoutes.get('/', zValidator('query', ratesQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const result = await ratesRepository.findPaginated(c.env.DB, query);
  return c.json(result);
});

ratesRoutes.get('/today', async (c) => {
  const [rates, tierRows] = await Promise.all([
    ratesRepository.findTodayWithFallback(c.env.DB),
    safeFindUsdtTiers(c.env.DB),
  ]);

  const usdtP2pTiers = formatUsdtP2PTiersResponse(tierRows);

  return c.json({
    rates,
    ...(usdtP2pTiers ? { usdt_p2p_tiers: usdtP2pTiers } : {}),
  });
});

ratesRoutes.get('/usdt/tiers', async (c) => {
  const tierRows = await safeFindUsdtTiers(c.env.DB);
  const formatted = formatUsdtP2PTiersResponse(tierRows);
  if (formatted) {
    return c.json(formatted);
  }

  const latestYadio = await ratesRepository.findLatestByCurrency(c.env.DB, 'YD_USD');
  if (!latestYadio) {
    return c.json({ error: 'No USDT P2P rates available yet' }, 404);
  }

  return c.json(buildFallbackTiersResponseFromRate(latestYadio));
});

ratesRoutes.get('/usdt/by-amount', zValidator('query', usdtByAmountQuerySchema), async (c) => {
  const { ves } = c.req.valid('query');
  const tierRows = await safeFindUsdtTiers(c.env.DB);
  const resolved = resolveUsdtRateForVesAmount(tierRows, ves);

  if (resolved) {
    return c.json(resolved);
  }

  const latestYadio = await ratesRepository.findLatestByCurrency(c.env.DB, 'YD_USD');
  if (!latestYadio) {
    return c.json({ error: 'No USDT P2P rates available yet' }, 404);
  }

  const fallback: UsdtRateByAmountResponse = {
    requested_ves: ves,
    matched_tier_key: 'unfiltered',
    bucket: 'unfiltered',
    match_type: 'rates_fallback',
    buy_rate: latestYadio.buy_rate,
    sell_rate: latestYadio.sell_rate,
    avg_rate: latestYadio.rate,
    min_ves: null,
    updated_at: latestYadio.created_at,
  };

  return c.json(fallback);
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
