import { USDT_P2P_TIERS } from '../config/usdt-tiers';
import type { NewRateRecord, NewUsdtP2PTierRecord } from '../types/env';

const YADIO_URL = 'https://api.yadio.io/rate/ves/usd';
const YADIO_ADS_BASE_URL = 'https://api.yadio.io/market/ads';
const YADIO_TIMEOUT_MS = 8_000;
const YADIO_ADS_TIMEOUT_MS = 6_000;
const YADIO_ADS_LIMIT = 150;
const TIER_TOP_ADS_LIMIT = 20;
const MAX_PRICE_DEVIATION_RATIO = 0.4;
const RETRY_DELAY_MS = 250;

type P2PSide = 'buy' | 'sell';

export interface YadioMarketAd {
  price?: unknown;
  ad_url?: unknown;
  min?: unknown;
  max?: unknown;
  min_amount?: unknown;
  max_amount?: unknown;
  dynamic_max_amount?: unknown;
  binance_native_v1?: unknown;
}

export interface AdVesLimits {
  minVes: number;
  maxVes: number;
}

interface ParsedBinanceAd {
  price: number;
  limits: AdVesLimits | null;
}

export interface YadioRateWithTiers extends NewRateRecord {
  p2pTiers: NewUsdtP2PTierRecord[];
}

export class YadioServiceError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'YadioServiceError';
    this.retryable = retryable;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function toPositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function extractRawRate(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  if ('data' in payload && payload.data && typeof payload.data === 'object' && 'rate' in payload.data) {
    return (payload.data as { rate: unknown }).rate;
  }

  if ('rate' in payload) {
    return (payload as { rate: unknown }).rate;
  }

  return undefined;
}

function isBinanceAd(ad: YadioMarketAd): boolean {
  if (ad.binance_native_v1 !== undefined && ad.binance_native_v1 !== null) {
    return true;
  }
  return typeof ad.ad_url === 'string' && ad.ad_url.toLowerCase().includes('binance');
}

function isSaneP2PPrice(price: number, baseRate: number): boolean {
  if (!Number.isFinite(price) || price <= 1) return false;
  return Math.abs(price - baseRate) / baseRate <= MAX_PRICE_DEVIATION_RATIO;
}

export function extractAdVesLimits(ad: YadioMarketAd): AdVesLimits | null {
  const nativeAdv =
    ad.binance_native_v1 &&
    typeof ad.binance_native_v1 === 'object' &&
    'adv' in ad.binance_native_v1 &&
    ad.binance_native_v1.adv &&
    typeof ad.binance_native_v1.adv === 'object'
      ? (ad.binance_native_v1.adv as Record<string, unknown>)
      : null;

  const minVes =
    toPositiveNumber(ad.min_amount) ??
    toPositiveNumber(nativeAdv?.minSingleTransAmount) ??
    toPositiveNumber(ad.min);

  const maxVes =
    toPositiveNumber(ad.dynamic_max_amount) ??
    toPositiveNumber(nativeAdv?.dynamicMaxSingleTransAmount) ??
    toPositiveNumber(ad.max_amount) ??
    toPositiveNumber(nativeAdv?.maxSingleTransAmount) ??
    toPositiveNumber(ad.max);

  if (minVes === null || maxVes === null || maxVes < minVes) {
    return null;
  }

  return { minVes, maxVes };
}

function extractBinanceAds(payload: unknown, baseRate: number): ParsedBinanceAd[] {
  if (!payload || typeof payload !== 'object' || !('ads' in payload)) {
    return [];
  }

  const { ads } = payload as { ads?: unknown };
  if (!Array.isArray(ads)) {
    return [];
  }

  const parsed: ParsedBinanceAd[] = [];
  for (const item of ads) {
    if (!item || typeof item !== 'object') continue;
    const ad = item as YadioMarketAd;
    if (!isBinanceAd(ad)) continue;

    const numericPrice = Number(ad.price);
    if (!isSaneP2PPrice(numericPrice, baseRate)) continue;

    parsed.push({
      price: numericPrice,
      limits: extractAdVesLimits(ad),
    });
  }

  return parsed;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return round2(median);
}

function computeTierAvgRate(buyRate: number | null, sellRate: number | null): number | null {
  if (buyRate !== null && sellRate !== null) {
    return round2((buyRate + sellRate) / 2);
  }
  return buyRate ?? sellRate ?? null;
}

function getTierCompetitivePrices(
  ads: ParsedBinanceAd[],
  targetVes: number,
  side: P2PSide
): number[] {
  const matched = ads
    .filter(
      (ad) =>
        ad.limits !== null && ad.limits.minVes <= targetVes && targetVes <= ad.limits.maxVes
    )
    .map((ad) => ad.price);

  matched.sort((a, b) => (side === 'buy' ? a - b : b - a));
  return matched.slice(0, TIER_TOP_ADS_LIMIT);
}

export function buildUsdtP2PTiers(
  baseRate: number,
  buyAds: ParsedBinanceAd[],
  sellAds: ParsedBinanceAd[],
  updatedAt: string = new Date().toISOString()
): NewUsdtP2PTierRecord[] {
  const unfilteredBuy = computeMedian(buyAds.map((a) => a.price));
  const unfilteredSell = computeMedian(sellAds.map((a) => a.price));

  if (unfilteredBuy === null && unfilteredSell === null) {
    return [];
  }

  const rawByTier = USDT_P2P_TIERS.map((tier) => {
    if (tier.refUsdt === null) {
      return {
        tier,
        amountVes: null,
        rawBuy: unfilteredBuy,
        rawSell: unfilteredSell,
        sampleBuy: buyAds.length,
        sampleSell: sellAds.length,
      };
    }

    const amountVes = round2(tier.refUsdt * baseRate);
    const buyPrices = getTierCompetitivePrices(buyAds, amountVes, 'buy');
    const sellPrices = getTierCompetitivePrices(sellAds, amountVes, 'sell');

    return {
      tier,
      amountVes,
      rawBuy: computeMedian(buyPrices),
      rawSell: computeMedian(sellPrices),
      sampleBuy: buyPrices.length,
      sampleSell: sellPrices.length,
    };
  });

  return rawByTier.map((entry, idx) => {
    if (entry.tier.refUsdt === null) {
      return {
        tier_key: entry.tier.tierKey,
        label: entry.tier.label,
        bucket: entry.tier.bucket,
        sort_order: entry.tier.sortOrder,
        ref_usdt: null,
        amount_ves: null,
        buy_rate: entry.rawBuy,
        sell_rate: entry.rawSell,
        avg_rate: computeTierAvgRate(entry.rawBuy, entry.rawSell),
        sample_count_buy: entry.sampleBuy,
        sample_count_sell: entry.sampleSell,
        is_fallback: 0,
        base_rate: baseRate,
        updated_at: updatedAt,
      };
    }

    let resolvedBuy = entry.rawBuy;
    let resolvedSell = entry.rawSell;
    let usedFallback = false;

    if (resolvedBuy === null) {
      usedFallback = true;
      for (let j = idx + 1; j < rawByTier.length; j += 1) {
        if (rawByTier[j].rawBuy !== null) {
          resolvedBuy = rawByTier[j].rawBuy;
          break;
        }
      }
    }

    if (resolvedSell === null) {
      usedFallback = true;
      for (let j = idx + 1; j < rawByTier.length; j += 1) {
        if (rawByTier[j].rawSell !== null) {
          resolvedSell = rawByTier[j].rawSell;
          break;
        }
      }
    }

    return {
      tier_key: entry.tier.tierKey,
      label: entry.tier.label,
      bucket: entry.tier.bucket,
      sort_order: entry.tier.sortOrder,
      ref_usdt: entry.tier.refUsdt,
      amount_ves: entry.amountVes,
      buy_rate: resolvedBuy,
      sell_rate: resolvedSell,
      avg_rate: computeTierAvgRate(resolvedBuy, resolvedSell),
      sample_count_buy: entry.sampleBuy,
      sample_count_sell: entry.sampleSell,
      is_fallback: usedFallback ? 1 : 0,
      base_rate: baseRate,
      updated_at: updatedAt,
    };
  });
}

async function fetchYadioAdsPayload(fetcher: typeof fetch, side: P2PSide): Promise<unknown | null> {
  try {
    const url = `${YADIO_ADS_BASE_URL}?asset=USDT&currency=VES&side=${side}&limit=${YADIO_ADS_LIMIT}`;
    const response = await fetcher(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(YADIO_ADS_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    // Degradación controlada: si falla el endpoint P2P de anuncios, no abortamos la sincronización principal.
    return null;
  }
}

async function fetchYadioBaseRateOnce(fetcher: typeof fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetcher(YADIO_URL, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(YADIO_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new YadioServiceError(`Network/timeout error fetching Yadio API: ${message}`, true);
  }

  if (!response.ok) {
    const retryable = response.status >= 500;
    throw new YadioServiceError(`Yadio API responded with HTTP ${response.status}`, retryable);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new YadioServiceError('Invalid JSON received from Yadio API', false);
  }

  const rawRate = extractRawRate(payload);
  if (rawRate === undefined || rawRate === null || rawRate === '') {
    throw new YadioServiceError('Missing rate field in Yadio API response', false);
  }

  const numericRate = Number(rawRate);
  if (!Number.isFinite(numericRate)) {
    throw new YadioServiceError(`Non-numeric rate returned by Yadio API: ${String(rawRate)}`, false);
  }

  const rate = round2(numericRate);
  if (!Number.isFinite(rate) || rate <= 1) {
    throw new YadioServiceError(`Yadio rate failed sanity check: ${rate}`, false);
  }

  return rate;
}

async function fetchYadioBaseRate(fetcher: typeof fetch, retryDelayMs: number): Promise<number> {
  try {
    return await fetchYadioBaseRateOnce(fetcher);
  } catch (error) {
    if (error instanceof YadioServiceError && error.retryable) {
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
      return fetchYadioBaseRateOnce(fetcher);
    }
    throw error;
  }
}

export async function fetchYadioRate(
  fetcher: typeof fetch = fetch,
  retryDelayMs: number = RETRY_DELAY_MS
): Promise<YadioRateWithTiers> {
  const [rate, buyPayload, sellPayload] = await Promise.all([
    fetchYadioBaseRate(fetcher, retryDelayMs),
    fetchYadioAdsPayload(fetcher, 'buy'),
    fetchYadioAdsPayload(fetcher, 'sell'),
  ]);

  let buyRate: number | null = null;
  let sellRate: number | null = null;
  let p2pTiers: NewUsdtP2PTierRecord[] = [];

  try {
    const buyAds = buyPayload ? extractBinanceAds(buyPayload, rate) : [];
    const sellAds = sellPayload ? extractBinanceAds(sellPayload, rate) : [];

    buyRate = computeMedian(buyAds.map((a) => a.price));
    sellRate = computeMedian(sellAds.map((a) => a.price));
    p2pTiers = buildUsdtP2PTiers(rate, buyAds, sellAds);
  } catch {
    // Degradación controlada ante cualquier anomalía calculando tramos
    buyRate = null;
    sellRate = null;
    p2pTiers = [];
  }

  return {
    rate,
    buy_rate: buyRate,
    sell_rate: sellRate,
    currency: 'YD_USD',
    name: 'USDT',
    source: 'YADIO',
    p2pTiers,
  };
}
