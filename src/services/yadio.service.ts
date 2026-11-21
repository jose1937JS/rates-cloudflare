import type { NewRateRecord } from '../types/env';

const YADIO_URL = 'https://api.yadio.io/rate/ves/usd';
const YADIO_ADS_BASE_URL = 'https://api.yadio.io/market/ads';
const YADIO_TIMEOUT_MS = 8_000;
const YADIO_ADS_TIMEOUT_MS = 6_000;
const YADIO_ADS_LIMIT = 50;
const RETRY_DELAY_MS = 250;

type P2PSide = 'buy' | 'sell';

interface YadioMarketAd {
  price?: unknown;
  ad_url?: unknown;
  binance_native_v1?: unknown;
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

function extractBinanceAdPrices(payload: unknown): number[] {
  if (!payload || typeof payload !== 'object' || !('ads' in payload)) {
    return [];
  }

  const { ads } = payload as { ads?: unknown };
  if (!Array.isArray(ads)) {
    return [];
  }

  const prices: number[] = [];
  for (const item of ads) {
    if (!item || typeof item !== 'object') continue;
    const ad = item as YadioMarketAd;
    if (!isBinanceAd(ad)) continue;

    const numericPrice = Number(ad.price);
    if (Number.isFinite(numericPrice) && numericPrice > 1) {
      prices.push(numericPrice);
    }
  }

  return prices;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return Number(median.toFixed(2));
}

async function fetchBinanceMedianBySide(fetcher: typeof fetch, side: P2PSide): Promise<number | null> {
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

    const payload: unknown = await response.json();
    const prices = extractBinanceAdPrices(payload);
    return computeMedian(prices);
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

  const rate = Number(numericRate.toFixed(2));
  if (!Number.isFinite(rate) || rate <= 1) {
    throw new YadioServiceError(`Yadio rate failed sanity check: ${rate}`, false);
  }

  return rate;
}

async function fetchYadioBaseRate(
  fetcher: typeof fetch,
  retryDelayMs: number
): Promise<number> {
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
): Promise<NewRateRecord> {
  const [rate, buyRate, sellRate] = await Promise.all([
    fetchYadioBaseRate(fetcher, retryDelayMs),
    fetchBinanceMedianBySide(fetcher, 'buy'),
    fetchBinanceMedianBySide(fetcher, 'sell'),
  ]);

  return {
    rate,
    buy_rate: buyRate,
    sell_rate: sellRate,
    currency: 'YD_USD',
    name: 'USDT',
    source: 'YADIO',
  };
}
