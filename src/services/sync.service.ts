import { ratesRepository } from '../db/rates.repository';
import type { Env, NewRateRecord, SyncLogSource, SyncSource } from '../types/env';
import { fetchBcvRates } from './bcv.service';
import { fetchYadioRate } from './yadio.service';

export interface SyncResult {
  source: SyncSource;
  syncedCount: number;
  rates: NewRateRecord[];
  durationMs: number;
}

function toLogSource(source: SyncSource): SyncLogSource {
  return source.toUpperCase() as SyncLogSource;
}

export const syncService = {
  async sync(env: Env, source: SyncSource = 'all'): Promise<SyncResult> {
    const start = Date.now();
    const logSource = toLogSource(source);

    try {
      const rates: NewRateRecord[] = [];

      if (source === 'bcv' || source === 'all') {
        const bcvRates = await fetchBcvRates();
        rates.push(...bcvRates);
      }

      if (source === 'yadio' || source === 'all') {
        const yadioRate = await fetchYadioRate();
        rates.push(yadioRate);
      }

      await ratesRepository.insertBatch(env.DB, rates);

      const summary = rates
        .map((r) =>
          r.buy_rate != null || r.sell_rate != null
            ? `${r.currency}=${r.rate}(buy=${r.buy_rate ?? '-'},sell=${r.sell_rate ?? '-'})`
            : `${r.currency}=${r.rate}`
        )
        .join(', ');

      const durationMs = Date.now() - start;
      await ratesRepository.logSync(env.DB, {
        source: logSource,
        status: 'SUCCESS',
        message: `Synced ${rates.length} rate(s): ${summary}`,
        duration_ms: durationMs,
      });

      return {
        source,
        syncedCount: rates.length,
        rates,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);

      await ratesRepository.logSync(env.DB, {
        source: logSource,
        status: 'ERROR',
        message,
        duration_ms: durationMs,
      });

      throw error;
    }
  },
};
