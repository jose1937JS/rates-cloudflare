import { describe, expect, it, vi } from 'vitest';
import { BcvScrapeError, fetchBcvRates } from '../src/services/bcv.service';
import { fetchYadioRate, YadioServiceError } from '../src/services/yadio.service';

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

  it('throws BcvScrapeError when BCV returns non-OK HTTP status', async () => {
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
    expect(result).toEqual({
      rate: 56.79,
      buy_rate: 57.5,
      sell_rate: 56.3,
      currency: 'YD_USD',
      name: 'USDT',
      source: 'YADIO',
    });
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
