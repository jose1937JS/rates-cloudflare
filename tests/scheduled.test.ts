import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { syncService } from '../src/services/sync.service';
import type { Env } from '../src/types/env';

function createScheduledMocks() {
  const env = {
    DB: {} as D1Database,
    API_SECRET_KEYS: 'secret-key',
  } as Env;

  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      promises.push(promise);
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  return { env, ctx, promises };
}

function createScheduledEvent(cron: string): ScheduledEvent {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry: vi.fn(),
  } as unknown as ScheduledEvent;
}

describe('Scheduled Cron Trigger Handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs only bcv when cron is "0 10 * * 1-5"', async () => {
    const syncSpy = vi.spyOn(syncService, 'sync').mockResolvedValue({
      source: 'bcv',
      syncedCount: 2,
      rates: [],
      durationMs: 10,
    });

    const { env, ctx, promises } = createScheduledMocks();
    const event = createScheduledEvent('0 10 * * 1-5');

    await worker.scheduled(event, env, ctx);
    await Promise.all(promises);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(env, 'bcv');
  });

  it('syncs only yadio when cron is "0 */4 * * *"', async () => {
    const syncSpy = vi.spyOn(syncService, 'sync').mockResolvedValue({
      source: 'yadio',
      syncedCount: 1,
      rates: [],
      durationMs: 10,
    });

    const { env, ctx, promises } = createScheduledMocks();
    const event = createScheduledEvent('0 */4 * * *');

    await worker.scheduled(event, env, ctx);
    await Promise.all(promises);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(env, 'yadio');
  });

  it('syncs all sources for any other cron expression', async () => {
    const syncSpy = vi.spyOn(syncService, 'sync').mockResolvedValue({
      source: 'all',
      syncedCount: 3,
      rates: [],
      durationMs: 10,
    });

    const { env, ctx, promises } = createScheduledMocks();
    const event = createScheduledEvent('0 0 * * *');

    await worker.scheduled(event, env, ctx);
    await Promise.all(promises);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(env, 'all');
  });
});
