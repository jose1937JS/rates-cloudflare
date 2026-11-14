import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { resetRateLimitStore } from '../src/middleware/rate-limit';
import type { Env } from '../src/types/env';

function createMinimalDbStub(): D1Database {
  const statement = {
    bind: () => statement,
    first: async <T = unknown>() => null as T | null,
    all: async <T = unknown>() => ({ results: [] as T[], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
  };

  return {
    prepare: () => statement,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('Not implemented in stub');
    },
  } as unknown as D1Database;
}

function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMinimalDbStub(),
    API_SECRET_KEYS: 'primary-secret-key,secondary-rotation-key',
    ALLOWED_ORIGINS: 'https://app.example.com,http://localhost:3000',
    RATE_LIMIT_MAX: '60',
    RATE_LIMIT_WINDOW_MS: '60000',
    ...overrides,
  };
}

describe('Auth, CORS, Rate Limiting & Security Headers', () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  it('rejects /api/* requests with 401 when API key is missing or invalid', async () => {
    const env = createTestEnv();

    const missingRes = await app.fetch(new Request('https://api.example.com/api/rates/today'), env);
    expect(missingRes.status).toBe(401);

    const invalidRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': 'wrong-key' },
      }),
      env
    );
    expect(invalidRes.status).toBe(401);

    const badBearerRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { Authorization: 'Bearer wrong-key' },
      }),
      env
    );
    expect(badBearerRes.status).toBe(401);
  });

  it('accepts valid X-API-Key and Authorization Bearer keys including rotated keys', async () => {
    const env = createTestEnv();

    const xApiKeyRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': 'primary-secret-key' },
      }),
      env
    );
    expect(xApiKeyRes.status).toBe(200);

    const bearerRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { Authorization: 'Bearer secondary-rotation-key' },
      }),
      env
    );
    expect(bearerRes.status).toBe(200);
  });

  it('allows server-to-server / native mobile requests without Origin header', async () => {
    const env = createTestEnv();
    const res = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': 'primary-secret-key' },
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows whitelisted Origin and handles OPTIONS preflight with 204', async () => {
    const env = createTestEnv();

    const preflightRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example.com' },
      }),
      env
    );

    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(preflightRes.headers.get('Vary')).toBe('Origin');
    expect(preflightRes.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(preflightRes.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, Authorization, X-API-Key'
    );
    expect(preflightRes.headers.get('Access-Control-Max-Age')).toBe('86400');

    const getRes = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: {
          Origin: 'http://localhost:3000',
          'X-API-Key': 'primary-secret-key',
        },
      }),
      env
    );

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
  });

  it('rejects disallowed Origin with 403 Forbidden', async () => {
    const env = createTestEnv();

    const res = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: {
          Origin: 'https://malicious.example.com',
          'X-API-Key': 'primary-secret-key',
        },
      }),
      env
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('attaches security headers to responses', async () => {
    const env = createTestEnv();
    const res = await app.fetch(
      new Request('https://api.example.com/api/rates/today', {
        headers: { 'X-API-Key': 'primary-secret-key' },
      }),
      env
    );

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  });

  it('enforces native rate limiting per IP with X-RateLimit headers and 429', async () => {
    const env = createTestEnv({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' });

    const req = () =>
      new Request('https://api.example.com/api/rates/today', {
        headers: {
          'CF-Connecting-IP': '203.0.113.10',
          'X-API-Key': 'primary-secret-key',
        },
      });

    const first = await app.fetch(req(), env);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('1');

    const second = await app.fetch(req(), env);
    expect(second.status).toBe(200);
    expect(second.headers.get('X-RateLimit-Remaining')).toBe('0');

    const third = await app.fetch(req(), env);
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBeTruthy();
  });
});
