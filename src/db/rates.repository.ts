import type {
  Currency,
  NewRateRecord,
  PaginatedRatesResponse,
  RateRecord,
  SyncLogEntry,
  TodayRateRecord,
} from '../types/env';

const ALL_CURRENCIES: readonly Currency[] = ['BCV_USD', 'BCV_EUR', 'YD_USD'];

export function getCaracasStartOfDayUtcIso(now: Date = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  return new Date(`${ymd}T00:00:00.000-04:00`).toISOString();
}

export const ratesRepository = {
  async ping(db: D1Database): Promise<boolean> {
    const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return row?.ok === 1;
  },

  async insertBatch(db: D1Database, records: NewRateRecord[]): Promise<void> {
    if (records.length === 0) return;

    const statements = records.map((record) =>
      db
        .prepare(
          'INSERT INTO rates (rate, buy_rate, sell_rate, currency, name, source) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(
          record.rate,
          record.buy_rate ?? null,
          record.sell_rate ?? null,
          record.currency,
          record.name,
          record.source
        )
    );

    await db.batch(statements);
  },

  async logSync(db: D1Database, entry: SyncLogEntry): Promise<void> {
    await db
      .prepare('INSERT INTO sync_logs (source, status, message, duration_ms) VALUES (?, ?, ?, ?)')
      .bind(entry.source, entry.status, entry.message ?? null, entry.duration_ms)
      .run();
  },

  async findPaginated(
    db: D1Database,
    params: { page: number; limit: number; days?: number; currency?: Currency }
  ): Promise<PaginatedRatesResponse> {
    const conditions: string[] = [];
    const bindings: (string | number)[] = [];

    if (params.currency) {
      conditions.push('currency = ?');
      bindings.push(params.currency);
    }

    if (params.days !== undefined) {
      const sinceIso = new Date(Date.now() - params.days * 86_400_000).toISOString();
      conditions.push('created_at >= ?');
      bindings.push(sinceIso);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (params.page - 1) * params.limit;

    const countRow = await db
      .prepare(`SELECT COUNT(*) AS total FROM rates ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>();

    const totalItems = Number(countRow?.total ?? 0);
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / params.limit);

    const dataResult = await db
      .prepare(
        `SELECT id, rate, buy_rate, sell_rate, currency, name, source, created_at FROM rates ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(...bindings, params.limit, offset)
      .all<RateRecord>();

    return {
      rates: dataResult.results ?? [],
      pagination: {
        currentPage: params.page,
        totalPages,
        totalItems,
        itemsPerPage: params.limit,
      },
    };
  },

  async findLatestByCurrency(db: D1Database, currency: Currency): Promise<RateRecord | null> {
    const row = await db
      .prepare(
        'SELECT id, rate, buy_rate, sell_rate, currency, name, source, created_at FROM rates WHERE currency = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      )
      .bind(currency)
      .first<RateRecord>();

    return row ?? null;
  },

  async findTodayWithFallback(db: D1Database, now: Date = new Date()): Promise<TodayRateRecord[]> {
    const startOfDayUtcIso = getCaracasStartOfDayUtcIso(now);
    const results: TodayRateRecord[] = [];

    for (const currency of ALL_CURRENCIES) {
      const todayRow = await db
        .prepare(
          'SELECT id, rate, buy_rate, sell_rate, currency, name, source, created_at FROM rates WHERE currency = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1'
        )
        .bind(currency, startOfDayUtcIso)
        .first<RateRecord>();

      if (todayRow) {
        results.push({ ...todayRow, isFallback: false });
        continue;
      }

      const fallbackRow = await this.findLatestByCurrency(db, currency);
      if (fallbackRow) {
        results.push({ ...fallbackRow, isFallback: true });
      }
    }

    return results;
  },
};
