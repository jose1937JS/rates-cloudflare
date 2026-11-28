import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsdtTierBucket, UsdtTierKey } from '../src/config/usdt-tiers';
import { getCaracasStartOfDayUtcIso } from '../src/db/rates.repository';
import { app } from '../src/index';
import { resetRateLimitStore } from '../src/middleware/rate-limit';
import type {
  Currency,
  Env,
  RateRecord,
  RateSource,
  SyncLogSource,
  UsdtP2PTierRecord,
  UsdtP2PTiersResponse,
  UsdtRateByAmountResponse,
} from '../src/types/env';

interface SyncLogRow {
  id: number;
  source: SyncLogSource;
  status: 'SUCCESS' | 'ERROR';
  message: string | null;
  duration_ms: number;
  created_at: string;
}

type SeedRateInput = Omit<RateRecord, 'id' | 'buy_rate' | 'sell_rate'> & {
  buy_rate?: number | null;
  sell_rate?: number | null;
};

class InMemoryD1Database {
  rates: RateRecord[] = [];
  usdtP2pTiers: UsdtP2PTierRecord[] = [];
  syncLogs: SyncLogRow[] = [];
  batchCalls = 0;
  private nextRateId = 1;
  private nextLogId = 1;

  seedRates(items: SeedRateInput[]): void {
    for (const item of items) {
      this.rates.push({
        id: this.nextRateId++,
        ...item,
        buy_rate: item.buy_rate ?? null,
        sell_rate: item.sell_rate ?? null,
      });
    }
  }

  seedUsdtP2pTiers(items: UsdtP2PTierRecord[]): void {
    for (const item of items) {
      const idx = this.usdtP2pTiers.findIndex((t) => t.tier_key === item.tier_key);
      if (idx >= 0) {
        this.usdtP2pTiers[idx] = item;
      } else {
        this.usdtP2pTiers.push(item);
      }
    }
  }

  prepare(query: string) {
    return this.createStatement(query, []);
  }

  async batch(statements: Array<{ __exec: () => unknown }>) {
    this.batchCalls += 1;
    const results = [];
    for (const stmt of statements) {
      results.push({ results: [stmt.__exec()], success: true, meta: {} });
    }
    return results;
  }

  private createStatement(query: string, bindings: unknown[]) {
    const normalizedSql = query.replace(/\s+/g, ' ').trim();
    const db = this;

    const executeQuery = (): unknown[] => {
      if (normalizedSql === 'SELECT 1 AS ok') {
        return [{ ok: 1 }];
      }

      if (normalizedSql.startsWith('INSERT INTO rates')) {
        const [rate, buy_rate, sell_rate, currency, name, source] = bindings as [
          number,
          number | null,
          number | null,
          Currency,
          string,
          RateSource,
        ];
        const row: RateRecord = {
          id: db.nextRateId++,
          rate,
          buy_rate: buy_rate ?? null,
          sell_rate: sell_rate ?? null,
          currency,
          name,
          source,
          created_at: new Date().toISOString(),
        };
        db.rates.push(row);
        return [row];
      }

      if (normalizedSql.startsWith('INSERT INTO usdt_p2p_tiers')) {
        const [
          tier_key,
          label,
          bucket,
          sort_order,
          ref_usdt,
          amount_ves,
          buy_rate,
          sell_rate,
          avg_rate,
          sample_count_buy,
          sample_count_sell,
          is_fallback,
          base_rate,
          updated_at,
        ] = bindings as [
          UsdtTierKey,
          string,
          UsdtTierBucket,
          number,
          number | null,
          number | null,
          number | null,
          number | null,
          number | null,
          number,
          number,
          number,
          number,
          string,
        ];
        const row: UsdtP2PTierRecord = {
          tier_key,
          label,
          bucket,
          sort_order,
          ref_usdt,
          amount_ves,
          buy_rate,
          sell_rate,
          avg_rate,
          sample_count_buy,
          sample_count_sell,
          is_fallback,
          base_rate,
          updated_at,
        };
        const existingIdx = db.usdtP2pTiers.findIndex((t) => t.tier_key === tier_key);
        if (existingIdx >= 0) {
          db.usdtP2pTiers[existingIdx] = row;
        } else {
          db.usdtP2pTiers.push(row);
        }
        return [row];
      }

      if (normalizedSql.includes('FROM usdt_p2p_tiers')) {
        return [...db.usdtP2pTiers].sort((a, b) => a.sort_order - b.sort_order);
      }

      if (normalizedSql.startsWith('INSERT INTO sync_logs')) {
        const [source, status, message, duration_ms] = bindings as [
          SyncLogSource,
          'SUCCESS' | 'ERROR',
          string | null,
          number,
        ];
        const row: SyncLogRow = {
          id: db.nextLogId++,
          source,
          status,
          message,
          duration_ms,
          created_at: new Date().toISOString(),
        };
        db.syncLogs.push(row);
        return [row];
      }

      if (normalizedSql.startsWith('SELECT COUNT(*) AS total FROM rates')) {
        const filtered = db.filterRates(normalizedSql, bindings);
        return [{ total: filtered.length }];
      }

      if (
        normalizedSql.startsWith(
          'SELECT id, rate, buy_rate, sell_rate, currency, name, source, created_at FROM rates'
        )
      ) {
        const hasLimitOffset = normalizedSql.includes('LIMIT ? OFFSET ?');
        const hasLimitOne = normalizedSql.includes('LIMIT 1');

        const filterBindings = hasLimitOffset ? bindings.slice(0, -2) : bindings;
        const filtered = db
          .filterRates(normalizedSql, filterBindings)
          .sort((a, b) => {
            const cmp = b.created_at.localeCompare(a.created_at);
            return cmp !== 0 ? cmp : b.id - a.id;
          });

        if (hasLimitOffset) {
          const limit = Number(bindings[bindings.length - 2]);
          const offset = Number(bindings[bindings.length - 1]);
          return filtered.slice(offset, offset + limit);
        }

        if (hasLimitOne) {
          return filtered.slice(0, 1);
        }

        return filtered;
      }

      throw new Error(`Unsupported mock SQL: ${normalizedSql}`);
    };

    const statement = {
      bind: (...args: unknown[]) => db.createStatement(query, args),
      first: async <T = unknown>() => {
        const rows = executeQuery();
        return (rows[0] as T | undefined) ?? null;
      },
      all: async <T = unknown>() => {
        const rows = executeQuery();
        return { results: rows as T[], success: true, meta: {} };
      },
      run: async () => {
        const rows = executeQuery();
        return { results: rows, success: true, meta: {} };
      },
      raw: async () => [],
      __exec: executeQuery,
    };

    return statement;
  }

  private filterRates(sql: string, bindings: unknown[]): RateRecord[] {
    let idx = 0;
    let rows = [...this.rates];

    if (sql.includes('currency = ?')) {
      const currency = bindings[idx++] as Currency;
      rows = rows.filter((r) => r.currency === currency);
    }

    if (sql.includes('created_at >= ?')) {
      const since = bindings[idx++] as string;
      rows = rows.filter((r) => r.created_at >= since);
    }

    return rows;
  }
}

const API_KEY = 'test-api-key';

function createEnv(db: InMemoryD1Database): Env {
  return {
    DB: db as unknown as D1Database,
    API_SECRET_KEYS: API_KEY,
    ALLOWED_ORIGINS: 'https://app.example.com',
  };
}

describe('Rates API Endpoints', () => {
  let db: InMemoryD1Database;
  let env: Env;

  beforeEach(() => {
    resetRateLimitStore();
    db = new InMemoryD1Database();
    env = createEnv(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health returns 200 ok publicly after checking D1', async () => {
    const res = await app.fetch(new Request('https://api.example.com/health'), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });

  it('GET /api/rates supports pagination, currency filter and days filter', async () => {
    const now = Date.now();
    db.seedRates([
      {
        rate: 45.1,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: new Date(now - 10 * 86_400_000).toISOString(),
      },
      {
        rate: 46.2,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: new Date(now - 2 * 86_400_000).toISOString(),
      },
      {
        rate: 46.8,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: new Date(now - 1 * 86_400_000).toISOString(),
      },
      {
        rate: 52.0,
        currency: 'YD_USD',
        name: 'USDT',
        source: 'YADIO',
        created_at: new Date(now - 3600_000).toISOString(),
      },
    ]);

    const res = await app.fetch(
      new Request('https://api.example.com/api/rates?page=1&limit=1&currency=BCV_USD&days=5', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rates: RateRecord[];
      pagination: { currentPage: number; totalPages: number; totalItems: number; itemsPerPage: number };
    };
    expect(body.rates).toHaveLength(1);
    expect(body.rates[0].rate).toBe(46.8);
    expect(body.pagination).toEqual({
      currentPage: 1,
      totalPages: 2,
      totalItems: 2,
      itemsPerPage: 1,
    });
  });

  it('GET /api/rates validates query params with Zod', async () => {
    const res = await app.fetch(
      new Request('https://api.example.com/api/rates?limit=500', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(400);
  });

  it('calculates America/Caracas start of day in UTC correctly', () => {
    // 2026-11-14T03:30:00Z is 2026-11-13 23:30 in Caracas (UTC-4) -> start of day is 2026-11-13T04:00:00.000Z
    expect(getCaracasStartOfDayUtcIso(new Date('2026-11-14T03:30:00.000Z'))).toBe(
      '2026-11-13T04:00:00.000Z'
    );
    // 2026-11-14T04:00:00Z is 2026-11-14 00:00 in Caracas (UTC-4) -> start of day is 2026-11-14T04:00:00.000Z
    expect(getCaracasStartOfDayUtcIso(new Date('2026-11-14T04:00:00.000Z'))).toBe(
      '2026-11-14T04:00:00.000Z'
    );
  });

  it('GET /api/rates/today returns today rates and falls back to historical BCV on weekends/holidays', async () => {
    const startOfTodayIso = getCaracasStartOfDayUtcIso();
    const startMs = Date.parse(startOfTodayIso);

    db.seedRates([
      {
        rate: 46.5,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: new Date(startMs - 86_400_000).toISOString(),
      },
      {
        rate: 50.1,
        currency: 'BCV_EUR',
        name: 'Euro',
        source: 'BCV',
        created_at: new Date(startMs - 86_400_000).toISOString(),
      },
      {
        rate: 55.25,
        buy_rate: 55.8,
        sell_rate: 54.9,
        currency: 'YD_USD',
        name: 'USDT',
        source: 'YADIO',
        created_at: new Date(startMs + 1000).toISOString(),
      },
    ]);

    const res = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rates: Array<RateRecord & { isFallback: boolean }>;
    };

    expect(body.rates).toHaveLength(3);
    expect(body.rates.find((r) => r.currency === 'BCV_USD')).toMatchObject({
      rate: 46.5,
      buy_rate: null,
      sell_rate: null,
      isFallback: true,
    });
    expect(body.rates.find((r) => r.currency === 'BCV_EUR')).toMatchObject({
      rate: 50.1,
      buy_rate: null,
      sell_rate: null,
      isFallback: true,
    });
    expect(body.rates.find((r) => r.currency === 'YD_USD')).toMatchObject({
      rate: 55.25,
      buy_rate: 55.8,
      sell_rate: 54.9,
      isFallback: false,
    });
  });

  it('GET /api/rates/:currency returns latest rate, 404 if missing, and 400 on invalid enum', async () => {
    db.seedRates([
      {
        rate: 45.0,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: '2026-11-13T10:00:00.000Z',
      },
      {
        rate: 46.12,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: '2026-11-14T10:00:00.000Z',
      },
    ]);

    const okRes = await app.fetch(
      new Request('https://api.example.com/api/rates/BCV_USD', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { rate: RateRecord };
    expect(okBody.rate.rate).toBe(46.12);

    const notFoundRes = await app.fetch(
      new Request('https://api.example.com/api/rates/YD_USD', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(notFoundRes.status).toBe(404);

    const invalidEnumRes = await app.fetch(
      new Request('https://api.example.com/api/rates/INVALID_CUR', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(invalidEnumRes.status).toBe(400);
  });

  it('GET /api/rates/:currency/all returns paginated history for that currency', async () => {
    db.seedRates([
      {
        rate: 51.0,
        currency: 'YD_USD',
        name: 'USDT',
        source: 'YADIO',
        created_at: '2026-11-14T01:00:00.000Z',
      },
      {
        rate: 52.0,
        currency: 'YD_USD',
        name: 'USDT',
        source: 'YADIO',
        created_at: '2026-11-14T05:00:00.000Z',
      },
      {
        rate: 46.0,
        currency: 'BCV_USD',
        name: 'Dólar',
        source: 'BCV',
        created_at: '2026-11-14T10:00:00.000Z',
      },
    ]);

    const res = await app.fetch(
      new Request('https://api.example.com/api/rates/YD_USD/all?page=1&limit=10', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rates: RateRecord[];
      pagination: { totalItems: number };
    };
    expect(body.pagination.totalItems).toBe(2);
    expect(body.rates.map((r) => r.rate)).toEqual([52.0, 51.0]);
  });

  it('POST /api/sync persists rates via D1 batch and logs sync results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('bcv.org.ve')) {
        return new Response(
          '<div id="dolar"><strong>46,25</strong></div><div id="euro"><strong>50,40</strong></div>',
          { status: 200 }
        );
      }
      if (url.includes('yadio.io/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 54.88 }), { status: 200 });
      }
      if (url.includes('yadio.io/market/ads') && url.includes('side=buy')) {
        return new Response(
          JSON.stringify({
            ads: [
              { price: 55.1, ad_url: 'https://c2c.binance.com/en/adv?code=1' },
              { price: 55.5, ad_url: 'https://c2c.binance.com/en/adv?code=2' },
              { price: 55.9, ad_url: 'https://c2c.binance.com/en/adv?code=3' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('yadio.io/market/ads') && url.includes('side=sell')) {
        return new Response(
          JSON.stringify({
            ads: [
              { price: 54.2, ad_url: 'https://c2c.binance.com/en/adv?code=4' },
              { price: 54.4, ad_url: 'https://c2c.binance.com/en/adv?code=5' },
              { price: 54.6, ad_url: 'https://c2c.binance.com/en/adv?code=6' },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await app.fetch(
      new Request('https://api.example.com/api/sync?source=all', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { syncedCount: number; source: string };
    expect(body.syncedCount).toBe(3);
    expect(body.source).toBe('all');
    expect(db.batchCalls).toBe(2);
    expect(db.rates).toHaveLength(3);
    expect(db.usdtP2pTiers).toHaveLength(7);
    expect(db.rates.find((r) => r.currency === 'BCV_USD')).toMatchObject({
      rate: 46.25,
      buy_rate: null,
      sell_rate: null,
    });
    expect(db.rates.find((r) => r.currency === 'YD_USD')).toMatchObject({
      rate: 54.88,
      buy_rate: 55.5,
      sell_rate: 54.4,
    });
    expect(db.syncLogs).toHaveLength(1);
    expect(db.syncLogs[0].source).toBe('ALL');
    expect(db.syncLogs[0].status).toBe('SUCCESS');
  });

  it('POST /api/sync logs ERROR and returns 502 when upstream scraper fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    const res = await app.fetch(
      new Request('https://api.example.com/api/sync?source=yadio', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(502);
    expect(db.syncLogs).toHaveLength(1);
    expect(db.syncLogs[0].source).toBe('YADIO');
    expect(db.syncLogs[0].status).toBe('ERROR');
  });

  it('POST /api/sync accepts JSON body { source } and falls back BCV on HTTP 526', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('bcv.org.ve')) {
        return new Response('Invalid SSL Certificate', { status: 526 });
      }
      if (url.includes('rates.dolarvzla.com/bcv/current.json')) {
        return new Response(
          JSON.stringify({ current: { date: '2026-11-23', usd: 919.8227, eur: 1011.17949056 } }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await app.fetch(
      new Request('https://api.example.com/api/sync', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'bcv' }),
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; syncedCount: number };
    expect(body.source).toBe('bcv');
    expect(body.syncedCount).toBe(2);
    expect(db.rates.map((r) => ({ currency: r.currency, rate: r.rate }))).toEqual([
      { currency: 'BCV_USD', rate: 919.82 },
      { currency: 'BCV_EUR', rate: 1011.18 },
    ]);
  });

  it('POST /api/sync?source=all still persists Yadio rates if both BCV direct and fallback fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('bcv.org.ve') || url.includes('rates.dolarvzla.com')) {
        return new Response('SSL Error', { status: 526 });
      }
      if (url.includes('yadio.io/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 54.88 }), { status: 200 });
      }
      if (url.includes('yadio.io/market/ads')) {
        return new Response(JSON.stringify({ ads: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await app.fetch(
      new Request('https://api.example.com/api/sync?source=all', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );

    expect(res.status).toBe(502);
    expect(db.rates).toHaveLength(1);
    expect(db.rates[0].currency).toBe('YD_USD');
    expect(db.syncLogs[0].status).toBe('ERROR');
  });

  it('GET /api/rates/usdt/tiers & /usdt/by-amount resolve tiers, clamp min/max, and validate Zod', async () => {
    // 1. Empty DB -> 404
    const emptyTiersRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/tiers', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(emptyTiersRes.status).toBe(404);

    // 2. Fallback to latest YD_USD rate when usdt_p2p_tiers table has no rows yet
    db.seedRates([
      {
        rate: 500,
        buy_rate: 508,
        sell_rate: 495,
        currency: 'YD_USD',
        name: 'USDT',
        source: 'YADIO',
        created_at: '2026-11-28T00:00:00.000Z',
      },
    ]);

    const fallbackTiersRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/tiers', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(fallbackTiersRes.status).toBe(200);
    const fallbackBody = (await fallbackTiersRes.json()) as UsdtP2PTiersResponse;
    expect(fallbackBody.tiers).toHaveLength(1);
    expect(fallbackBody.tiers[0]).toMatchObject({
      tier_key: 'unfiltered',
      buy_rate: 508,
      sell_rate: 495,
      avg_rate: 500,
      is_fallback: true,
    });

    const fallbackByAmtRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/by-amount?ves=15000', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(fallbackByAmtRes.status).toBe(200);
    expect((await fallbackByAmtRes.json()) as UsdtRateByAmountResponse).toMatchObject({
      matched_tier_key: 'unfiltered',
      match_type: 'rates_fallback',
      buy_rate: 508,
      sell_rate: 495,
    });

    // 3. Seed canonical 7-tier P2P liquidity curve
    const updatedAt = '2026-11-28T04:00:00.000Z';
    db.seedUsdtP2pTiers([
      { tier_key: 'tier_5', label: 'Mínimo (5 USDT)', bucket: 'small', sort_order: 1, ref_usdt: 5, amount_ves: 2500, buy_rate: 520, sell_rate: 485, avg_rate: 502.5, sample_count_buy: 8, sample_count_sell: 9, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'tier_15', label: 'Pequeño (15 USDT)', bucket: 'small', sort_order: 2, ref_usdt: 15, amount_ves: 7500, buy_rate: 515, sell_rate: 488, avg_rate: 501.5, sample_count_buy: 12, sample_count_sell: 14, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'tier_35', label: 'Pequeño (35 USDT)', bucket: 'small', sort_order: 3, ref_usdt: 35, amount_ves: 17500, buy_rate: 512, sell_rate: 491, avg_rate: 501.5, sample_count_buy: 15, sample_count_sell: 18, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'tier_75', label: 'Mediano (75 USDT)', bucket: 'medium', sort_order: 4, ref_usdt: 75, amount_ves: 37500, buy_rate: 510, sell_rate: 494, avg_rate: 502, sample_count_buy: 20, sample_count_sell: 20, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'tier_150', label: 'Mediano (150 USDT)', bucket: 'medium', sort_order: 5, ref_usdt: 150, amount_ves: 75000, buy_rate: 508, sell_rate: 496, avg_rate: 502, sample_count_buy: 20, sample_count_sell: 20, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'tier_400', label: 'Grande (400 USDT)', bucket: 'large', sort_order: 6, ref_usdt: 400, amount_ves: 200000, buy_rate: 506, sell_rate: 498, avg_rate: 502, sample_count_buy: 20, sample_count_sell: 20, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
      { tier_key: 'unfiltered', label: 'Mercado general', bucket: 'unfiltered', sort_order: 7, ref_usdt: null, amount_ves: null, buy_rate: 507, sell_rate: 497, avg_rate: 502, sample_count_buy: 100, sample_count_sell: 100, is_fallback: 0, base_rate: 500, updated_at: updatedAt },
    ]);

    const tiersRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/tiers', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(tiersRes.status).toBe(200);
    const tiersBody = (await tiersRes.json()) as UsdtP2PTiersResponse;
    expect(tiersBody.min_usdt).toBe(5);
    expect(tiersBody.min_ves).toBe(2500);
    expect(tiersBody.tiers).toHaveLength(7);
    expect(tiersBody.tiers[0].is_fallback).toBe(false);

    // Clamped min (< 5 USDT)
    const minRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/by-amount?ves=1000', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(minRes.status).toBe(200);
    expect((await minRes.json()) as UsdtRateByAmountResponse).toMatchObject({
      requested_ves: 1000,
      matched_tier_key: 'tier_5',
      match_type: 'clamped_min',
      buy_rate: 520,
      sell_rate: 485,
      min_ves: 2500,
    });

    // Intermediate nearest tier (35000 VES -> closest to tier_75 = 37500)
    const medRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/by-amount?ves=35000', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(medRes.status).toBe(200);
    expect((await medRes.json()) as UsdtRateByAmountResponse).toMatchObject({
      matched_tier_key: 'tier_75',
      bucket: 'medium',
      match_type: 'nearest_tier',
      buy_rate: 510,
      sell_rate: 494,
    });

    // Unfiltered max (> 400 USDT = 200,000 VES)
    const maxRes = await app.fetch(
      new Request('https://api.example.com/api/rates/usdt/by-amount?ves=500000', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(maxRes.status).toBe(200);
    expect((await maxRes.json()) as UsdtRateByAmountResponse).toMatchObject({
      matched_tier_key: 'unfiltered',
      bucket: 'unfiltered',
      match_type: 'unfiltered_max',
      buy_rate: 507,
      sell_rate: 497,
    });

    // GET /api/rates/today includes additive usdt_p2p_tiers while preserving rates[]
    const todayRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(todayRes.status).toBe(200);
    const todayBody = (await todayRes.json()) as {
      rates: Array<RateRecord & { isFallback: boolean }>;
      usdt_p2p_tiers?: UsdtP2PTiersResponse;
    };
    expect(todayBody.rates).toHaveLength(1);
    expect(todayBody.usdt_p2p_tiers?.tiers).toHaveLength(7);

    // Zod validation errors on invalid ?ves
    for (const invalidQuery of ['', '?ves=-10', '?ves=0', '?ves=abc']) {
      const badRes = await app.fetch(
        new Request(`https://api.example.com/api/rates/usdt/by-amount${invalidQuery}`, {
          headers: { 'X-API-Key': API_KEY },
        }),
        env
      );
      expect(badRes.status).toBe(400);
    }
  });

  it('POST /api/sync?source=yadio updates usdt_p2p_tiers and degrades without wiping on /market/ads failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('yadio.io/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 500 }), { status: 200 });
      }
      if (url.includes('yadio.io/market/ads') && url.includes('side=buy')) {
        return new Response(
          JSON.stringify({
            ads: [{ price: 515, min_amount: 1000, max_amount: 300000, ad_url: 'https://c2c.binance.com/1' }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('yadio.io/market/ads') && url.includes('side=sell')) {
        return new Response(
          JSON.stringify({
            ads: [{ price: 495, min_amount: 1000, max_amount: 300000, ad_url: 'https://c2c.binance.com/2' }],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const okSync = await app.fetch(
      new Request('https://api.example.com/api/sync?source=yadio', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(okSync.status).toBe(200);
    expect(db.usdtP2pTiers).toHaveLength(7);
    expect(db.syncLogs[0].message).toContain('7 P2P tiers');

    // Now simulate /market/ads returning 503: sync succeeds with base rate and existing tiers stay intact
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('yadio.io/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 505 }), { status: 200 });
      }
      return new Response('Unavailable', { status: 503 });
    });

    const degradedSync = await app.fetch(
      new Request('https://api.example.com/api/sync?source=yadio', {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY },
      }),
      env
    );
    expect(degradedSync.status).toBe(200);
    expect(db.rates[1]).toMatchObject({ rate: 505, buy_rate: null, sell_rate: null });
    expect(db.usdtP2pTiers).toHaveLength(7);
  });
});
