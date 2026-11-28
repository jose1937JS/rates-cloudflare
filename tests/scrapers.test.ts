import { describe, expect, it, vi } from 'vitest';
import { BcvScrapeError, fetchBcvRates } from '../src/services/bcv.service';
import {
  buildUsdtP2PTiers,
  extractAdVesLimits,
  fetchYadioRate,
  YadioServiceError,
} from '../src/services/yadio.service';

const VALID_BCV_HTML = `
<!DOCTYPE html>
<html>
  <body>
    <div id="euro" class="col-sm-12">
      <div class="row recuadrotsmc">
        <div class="col-sm-6"><span>EUR</span></div>
        <div class="col-sm-6 centrado"><strong> 51,23450000 </strong></div>
      </div>
    </div>
    <div id="dolar" class="col-sm-12">
      <div class="row recuadrotsmc">
        <div class="col-sm-6"><span>USD</span></div>
        <div class="col-sm-6 centrado"><strong> 47,89500000 </strong></div>
      </div>
    </div>
  </body>
</html>
`;

describe('BCV Scraper Service', () => {
  it('parses and normalizes #dolar and #euro from BCV HTML', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_BCV_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const rates = await fetchBcvRates(mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://www.bcv.org.ve/terminos-condiciones',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': expect.any(String) }),
      })
    );
    expect(rates).toEqual([
      { rate: 47.9, currency: 'BCV_USD', name: 'Dólar', source: 'BCV' },
      { rate: 51.23, currency: 'BCV_EUR', name: 'Euro', source: 'BCV' },
    ]);
  });

  it('parses rates with thousands separators like 1.010,56078251', async () => {
    const htmlWithThousands = `
      <div id="euro"><strong> 1.010,56078251</strong></div>
      <div id="dolar"><strong>914,02180000</strong></div>
    `;
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(htmlWithThousands, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const rates = await fetchBcvRates(mockFetch);
    expect(rates).toEqual([
      { rate: 914.02, currency: 'BCV_USD', name: 'Dólar', source: 'BCV' },
      { rate: 1010.56, currency: 'BCV_EUR', name: 'Euro', source: 'BCV' },
    ]);
  });
  it('uses native HTMLRewriter when available in the Workers runtime', async () => {
    const handlers: Record<string, { text?: (chunk: { text: string }) => void }> = {};

    class MockHTMLRewriter {
      on(selector: string, handler: { text?: (chunk: { text: string }) => void }) {
        handlers[selector] = handler;
        return this;
      }
      transform(response: Response) {
        return {
          text: async () => {
            handlers['#dolar strong']?.text?.({ text: ' 47,' });
            handlers['#dolar strong']?.text?.({ text: '895 ' });
            handlers['#euro strong']?.text?.({ text: ' 51,234 ' });
            return response.text();
          },
        };
      }
    }

    vi.stubGlobal('HTMLRewriter', MockHTMLRewriter);
    try {
      const mockFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(VALID_BCV_HTML, { status: 200 }));

      const rates = await fetchBcvRates(mockFetch);
      expect(rates).toEqual([
        { rate: 47.9, currency: 'BCV_USD', name: 'Dólar', source: 'BCV' },
        { rate: 51.23, currency: 'BCV_EUR', name: 'Euro', source: 'BCV' },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to rates.dolarvzla.com when BCV direct fails with HTTP 526', async () => {
    const getRequestUrl = (input: Parameters<typeof fetch>[0]): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('bcv.org.ve')) {
        return new Response('Invalid SSL Certificate', { status: 526 });
      }
      if (url.includes('rates.dolarvzla.com/bcv/current.json')) {
        return new Response(
          JSON.stringify({
            current: {
              date: '2026-11-23',
              usd: 919.8227,
              eur: 1011.17949056,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const rates = await fetchBcvRates(mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(rates).toEqual([
      { rate: 919.82, currency: 'BCV_USD', name: 'Dólar', source: 'BCV' },
      { rate: 1011.18, currency: 'BCV_EUR', name: 'Euro', source: 'BCV' },
    ]);
  });

  it('throws BcvScrapeError when BCV returns non-OK HTTP status and fallback fails', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

    await expect(fetchBcvRates(mockFetch)).rejects.toThrow(BcvScrapeError);
  });

  it('throws BcvScrapeError when #dolar or #euro is missing', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<div id="dolar"><strong>47,50</strong></div>', { status: 200 }));

    await expect(fetchBcvRates(mockFetch)).rejects.toThrow(BcvScrapeError);
  });

  it('throws BcvScrapeError when parsed rates fail sanity bounds', async () => {
    const invalidHtml = `
      <div id="dolar"><strong>0,50</strong></div>
      <div id="euro"><strong>50,00</strong></div>
    `;
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(invalidHtml, { status: 200 }));

    await expect(fetchBcvRates(mockFetch)).rejects.toThrow(BcvScrapeError);

    const hugeHtml = `
      <div id="dolar"><strong>150000,00</strong></div>
      <div id="euro"><strong>50,00</strong></div>
    `;
    mockFetch.mockResolvedValueOnce(new Response(hugeHtml, { status: 200 }));
    await expect(fetchBcvRates(mockFetch)).rejects.toThrow(BcvScrapeError);
  });

  it('throws BcvScrapeError on network error or timeout', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network timeout'));

    await expect(fetchBcvRates(mockFetch)).rejects.toThrow(BcvScrapeError);
  });
});

describe('Yadio API Service', () => {
  const getRequestUrl = (input: Parameters<typeof fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  it('parses and normalizes Yadio base rate plus Binance P2P buy/sell medians', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 56.7891 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('side=buy')) {
        return new Response(
          JSON.stringify({
            ads: [
              { price: 40.0, ad_url: 'https://remitano.com/ve/offers/1' },
              { price: 57.1, ad_url: 'https://c2c.binance.com/en/adv?code=1' },
              { price: 58.0, binance_native_v1: { adv: {} } },
              { price: 57.5, ad_url: 'https://c2c.binance.com/en/adv?code=2' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('side=sell')) {
        return new Response(
          JSON.stringify({
            ads: [
              { price: 56.0, ad_url: 'https://c2c.binance.com/en/adv?code=3' },
              { price: 56.2, ad_url: 'https://c2c.binance.com/en/adv?code=4' },
              { price: 56.4, binance_native_v1: { adv: {} } },
              { price: 57.0, ad_url: 'https://c2c.binance.com/en/adv?code=5' },
              { price: 99.0, ad_url: 'https://www.okx.com/p2p/1' },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchYadioRate(mockFetch, 0);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      rate: 56.79,
      buy_rate: 57.5,
      sell_rate: 56.3,
      currency: 'YD_USD',
      name: 'USDT',
      source: 'YADIO',
    });
    expect(result.p2pTiers).toHaveLength(7);
    expect(result.p2pTiers.find((t) => t.tier_key === 'unfiltered')).toMatchObject({
      buy_rate: 57.5,
      sell_rate: 56.3,
      avg_rate: 56.9,
      is_fallback: 0,
    });
  });

  it('extracts VES limits defensively across Yadio and binance_native_v1 schemas', () => {
    expect(
      extractAdVesLimits({
        min_amount: 5000,
        max_amount: 100000,
        dynamic_max_amount: 45000,
      })
    ).toEqual({ minVes: 5000, maxVes: 45000 });

    expect(
      extractAdVesLimits({
        binance_native_v1: {
          adv: {
            minSingleTransAmount: '10000',
            dynamicMaxSingleTransAmount: '80000',
            maxSingleTransAmount: '200000',
          },
        },
      })
    ).toEqual({ minVes: 10000, maxVes: 80000 });

    expect(extractAdVesLimits({ min_amount: 50000, max_amount: 10000 })).toBeNull();
    expect(extractAdVesLimits({})).toBeNull();
  });

  it('computes Binance P2P liquidity tiers by VES amount, excludes outliers, and falls back upward', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 1000 }), { status: 200 });
      }
      if (url.includes('side=buy')) {
        return new Response(
          JSON.stringify({
            ads: [
              // Non-Binance & extreme outlier (>40% from baseRate) must be ignored
              { price: 500, min_amount: 1000, max_amount: 500000, ad_url: 'https://remitano.com/1' },
              { price: 1800, min_amount: 1000, max_amount: 500000, ad_url: 'https://c2c.binance.com/en/adv?code=trap' },
              // Small-to-medium Binance buy ads (5,000 - 80,000 VES) -> covers tier_15 (15k), tier_35 (35k), tier_75 (75k)
              // Note: no ad starts <= 5,000 (tier_5 = 5,000 VES), so tier_5 should fall back upward to tier_15!
              { price: 1040, min_amount: 10000, dynamic_max_amount: 80000, ad_url: 'https://c2c.binance.com/en/adv?code=b1' },
              { price: 1044, min_amount: 12000, dynamic_max_amount: 100000, ad_url: 'https://c2c.binance.com/en/adv?code=b2' },
              // Large Binance buy ads (100,000 - 600,000 VES) -> covers tier_150 (150k), tier_400 (400k)
              { price: 1010, min_amount: 100000, dynamic_max_amount: 600000, ad_url: 'https://c2c.binance.com/en/adv?code=b3' },
              { price: 1014, min_amount: 100000, dynamic_max_amount: 600000, ad_url: 'https://c2c.binance.com/en/adv?code=b4' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('side=sell')) {
        return new Response(
          JSON.stringify({
            ads: [
              { price: 1600, min_amount: 1000, max_amount: 500000, ad_url: 'https://www.okx.com/p2p/1' },
              { price: 980, min_amount: 4000, dynamic_max_amount: 80000, ad_url: 'https://c2c.binance.com/en/adv?code=s1' },
              { price: 984, min_amount: 4000, dynamic_max_amount: 80000, ad_url: 'https://c2c.binance.com/en/adv?code=s2' },
              { price: 1002, min_amount: 100000, dynamic_max_amount: 600000, ad_url: 'https://c2c.binance.com/en/adv?code=s3' },
              { price: 1006, min_amount: 100000, dynamic_max_amount: 600000, ad_url: 'https://c2c.binance.com/en/adv?code=s4' },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchYadioRate(mockFetch, 0);
    const tier5 = result.p2pTiers.find((t) => t.tier_key === 'tier_5');
    const tier15 = result.p2pTiers.find((t) => t.tier_key === 'tier_15');
    const tier400 = result.p2pTiers.find((t) => t.tier_key === 'tier_400');
    const unfiltered = result.p2pTiers.find((t) => t.tier_key === 'unfiltered');

    expect(tier5).toMatchObject({
      amount_ves: 5000,
      buy_rate: 1042, // upward fallback from tier_15
      sell_rate: 982, // real match on sell side
      sample_count_buy: 0,
      sample_count_sell: 2,
      is_fallback: 1,
    });
    expect(tier15).toMatchObject({
      amount_ves: 15000,
      buy_rate: 1042,
      sell_rate: 982,
      avg_rate: 1012,
      sample_count_buy: 2,
      sample_count_sell: 2,
      is_fallback: 0,
    });
    expect(tier400).toMatchObject({
      amount_ves: 400000,
      buy_rate: 1012,
      sell_rate: 1004,
      avg_rate: 1008,
      sample_count_buy: 2,
      sample_count_sell: 2,
      is_fallback: 0,
    });
    expect(unfiltered).toMatchObject({
      amount_ves: null,
      buy_rate: 1027,
      sell_rate: 993,
      avg_rate: 1010,
      is_fallback: 0,
    });

    // Empty ads return empty p2pTiers cleanly
    expect(buildUsdtP2PTiers(1000, [], [])).toEqual([]);
  });

  it('degrades gracefully with null buy_rate/sell_rate when P2P ads fail or have no Binance offers', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        return new Response(JSON.stringify({ rate: 56.79 }), { status: 200 });
      }
      if (url.includes('side=buy')) {
        return new Response('Upstream error', { status: 503 });
      }
      if (url.includes('side=sell')) {
        return new Response(
          JSON.stringify({
            ads: [{ price: 55.0, ad_url: 'https://remitano.com/ve/offers/2' }],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchYadioRate(mockFetch, 0);

    expect(result).toEqual({
      rate: 56.79,
      buy_rate: null,
      sell_rate: null,
      currency: 'YD_USD',
      name: 'USDT',
      source: 'YADIO',
      p2pTiers: [],
    });
  });

  it('retries once on network failure or 5xx for base rate and succeeds on retry', async () => {
    let baseAttempts = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        baseAttempts += 1;
        if (baseAttempts === 1) {
          throw new Error('ECONNRESET');
        }
        return new Response(JSON.stringify({ data: { rate: 58.124 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ads: [] }), { status: 200 });
    });

    const result = await fetchYadioRate(mockFetch, 0);

    expect(baseAttempts).toBe(2);
    expect(result.rate).toBe(58.12);
  });

  it('throws YadioServiceError after base rate retry is exhausted', async () => {
    let baseAttempts = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        baseAttempts += 1;
        return new Response('Bad Gateway', { status: 502 });
      }
      return new Response(JSON.stringify({ ads: [] }), { status: 200 });
    });

    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(baseAttempts).toBe(2);
  });

  it('does not retry on sanity check failure or 4xx response', async () => {
    let baseAttempts = 0;
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        baseAttempts += 1;
        return new Response(JSON.stringify({ rate: 0.95 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ads: [] }), { status: 200 });
    });

    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(baseAttempts).toBe(1);

    mockFetch.mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url.includes('/rate/ves/usd')) {
        baseAttempts += 1;
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ ads: [] }), { status: 200 });
    });
    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(baseAttempts).toBe(2);
  });
});
