import { USDT_MIN_TIER_AMOUNT } from '../config/usdt-tiers';
import type {
  Currency,
  NewRateRecord,
  NewUsdtP2PTierRecord,
  PaginatedRatesResponse,
  RateRecord,
  SyncLogEntry,
  TodayRateRecord,
  UsdtAmountMatchType,
  UsdtP2PTierDto,
  UsdtP2PTierRecord,
  UsdtP2PTiersResponse,
  UsdtRateByAmountResponse,
} from '../types/env';

const ALL_CURRENCIES: readonly Currency[] = ['BCV_USD', 'BCV_EUR', 'YD_USD'];

function toUsdtTierDto(row: UsdtP2PTierRecord): UsdtP2PTierDto {
  return {
    tier_key: row.tier_key,
    label: row.label,
    bucket: row.bucket,
    ref_usdt: row.ref_usdt,
    amount_ves: row.amount_ves,
    buy_rate: row.buy_rate,
    sell_rate: row.sell_rate,
    avg_rate: row.avg_rate,
    sample_count_buy: row.sample_count_buy,
    sample_count_sell: row.sample_count_sell,
    is_fallback: row.is_fallback === 1,
  };
}

export function formatUsdtP2PTiersResponse(
  tiers: UsdtP2PTierRecord[]
): UsdtP2PTiersResponse | null {
  if (tiers.length === 0) return null;

  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  const minNumericTier = sorted.find((t) => t.amount_ves !== null && t.amount_ves > 0) ?? null;
  const reference = minNumericTier ?? sorted[0];

  return {
    currency: 'YD_USD',
    source: 'YADIO_BINANCE_P2P',
    min_usdt: minNumericTier?.ref_usdt ?? USDT_MIN_TIER_AMOUNT,
    min_ves: minNumericTier?.amount_ves ?? null,
    base_rate: reference.base_rate,
    updated_at: reference.updated_at,
    tiers: sorted.map(toUsdtTierDto),
  };
}

export function buildFallbackTiersResponseFromRate(
  latestYadio: RateRecord
): UsdtP2PTiersResponse {
  return {
    currency: 'YD_USD',
    source: 'YADIO_BINANCE_P2P',
    min_usdt: USDT_MIN_TIER_AMOUNT,
    min_ves: null,
    base_rate: latestYadio.rate,
    updated_at: latestYadio.created_at,
    tiers: [
      {
        tier_key: 'unfiltered',
        label: 'Mercado general',
        bucket: 'unfiltered',
        ref_usdt: null,
        amount_ves: null,
        buy_rate: latestYadio.buy_rate,
        sell_rate: latestYadio.sell_rate,
        avg_rate: latestYadio.rate,
        sample_count_buy: 0,
        sample_count_sell: 0,
        is_fallback: true,
      },
    ],
  };
}

export function resolveUsdtRateForVesAmount(
  tiers: UsdtP2PTierRecord[],
  amountVes: number
): UsdtRateByAmountResponse | null {
  if (!Number.isFinite(amountVes) || amountVes <= 0 || tiers.length === 0) {
    return null;
  }

  const numericTiers = tiers
    .filter((t): t is UsdtP2PTierRecord & { amount_ves: number } => t.amount_ves !== null && t.amount_ves > 0)
    .sort((a, b) => a.amount_ves - b.amount_ves);

  const unfilteredTier = tiers.find((t) => t.tier_key === 'unfiltered') ?? null;
  const minNumericTier = numericTiers[0] ?? null;
  const maxNumericTier = numericTiers[numericTiers.length - 1] ?? null;
  const minVes = minNumericTier?.amount_ves ?? null;

  let matched: UsdtP2PTierRecord | null = null;
  let matchType: UsdtAmountMatchType = 'nearest_tier';

  if (!minNumericTier || !maxNumericTier) {
    matched = unfilteredTier ?? tiers[0];
    matchType = 'unfiltered_max';
  } else if (amountVes <= minNumericTier.amount_ves) {
    matched = minNumericTier;
    matchType = 'clamped_min';
  } else if (amountVes > maxNumericTier.amount_ves) {
    matched = unfilteredTier ?? maxNumericTier;
    matchType = unfilteredTier ? 'unfiltered_max' : 'nearest_tier';
  } else {
    const exact = numericTiers.find((t) => Math.abs(amountVes - t.amount_ves) < 0.01);
    if (exact) {
      matched = exact;
      matchType = 'exact_tier';
    } else {
      let best = minNumericTier;
      let bestDist = Infinity;
      const logRequested = Math.log(amountVes);

      for (const candidate of numericTiers) {
        const dist = Math.abs(logRequested - Math.log(candidate.amount_ves));
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      matched = best;
      matchType = 'nearest_tier';
    }
  }

  if (!matched) return null;

  return {
    requested_ves: amountVes,
    matched_tier_key: matched.tier_key,
    bucket: matched.bucket,
    match_type: matchType,
    buy_rate: matched.buy_rate,
    sell_rate: matched.sell_rate,
    avg_rate: matched.avg_rate,
    min_ves: minVes,
    updated_at: matched.updated_at,
  };
}

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

  async upsertUsdtP2pTiers(db: D1Database, tiers: NewUsdtP2PTierRecord[]): Promise<void> {
    if (tiers.length === 0) return;

    const sql =
      'INSERT INTO usdt_p2p_tiers (tier_key, label, bucket, sort_order, ref_usdt, amount_ves, buy_rate, sell_rate, avg_rate, sample_count_buy, sample_count_sell, is_fallback, base_rate, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tier_key) DO UPDATE SET label = excluded.label, bucket = excluded.bucket, sort_order = excluded.sort_order, ref_usdt = excluded.ref_usdt, amount_ves = excluded.amount_ves, buy_rate = excluded.buy_rate, sell_rate = excluded.sell_rate, avg_rate = excluded.avg_rate, sample_count_buy = excluded.sample_count_buy, sample_count_sell = excluded.sample_count_sell, is_fallback = excluded.is_fallback, base_rate = excluded.base_rate, updated_at = excluded.updated_at';

    const statements = tiers.map((tier) =>
      db
        .prepare(sql)
        .bind(
          tier.tier_key,
          tier.label,
          tier.bucket,
          tier.sort_order,
          tier.ref_usdt,
          tier.amount_ves,
          tier.buy_rate,
          tier.sell_rate,
          tier.avg_rate,
          tier.sample_count_buy,
          tier.sample_count_sell,
          tier.is_fallback,
          tier.base_rate,
          tier.updated_at
        )
    );

    await db.batch(statements);
  },

  async findUsdtP2pTiers(db: D1Database): Promise<UsdtP2PTierRecord[]> {
    const result = await db
      .prepare(
        'SELECT tier_key, label, bucket, sort_order, ref_usdt, amount_ves, buy_rate, sell_rate, avg_rate, sample_count_buy, sample_count_sell, is_fallback, base_rate, updated_at FROM usdt_p2p_tiers ORDER BY sort_order ASC'
      )
      .all<UsdtP2PTierRecord>();

    return result.results ?? [];
  },
};
