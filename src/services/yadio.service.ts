import type { NewRateRecord } from '../types/env';

const YADIO_URL = 'https://api.yadio.io/rate/ves/usd';
const YADIO_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 250;

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

async function fetchYadioOnce(fetcher: typeof fetch): Promise<NewRateRecord> {
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

  return {
    rate,
    currency: 'YD_USD',
    name: 'USDT',
    source: 'YADIO',
  };
}

export async function fetchYadioRate(
  fetcher: typeof fetch = fetch,
  retryDelayMs: number = RETRY_DELAY_MS
): Promise<NewRateRecord> {
  try {
    return await fetchYadioOnce(fetcher);
  } catch (error) {
    if (error instanceof YadioServiceError && error.retryable) {
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
      return fetchYadioOnce(fetcher);
    }
    throw error;
  }
}
