import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCaracasStartOfDayUtcIso } from '../src/db/rates.repository';
import { app } from '../src/index';
import { resetRateLimitStore } from '../src/middleware/rate-limit';
import type { Currency, Env, RateRecord, RateSource, SyncLogSource } from '../src/types/env';

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
    expect(db.batchCalls).toBe(1);
    expect(db.rates).toHaveLength(3);
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
});
