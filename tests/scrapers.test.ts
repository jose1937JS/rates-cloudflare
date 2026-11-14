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
  it('parses and normalizes Yadio rate response', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ rate: 56.7891 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await fetchYadioRate(mockFetch, 0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      rate: 56.79,
      currency: 'YD_USD',
      name: 'USDT',
      source: 'YADIO',
    });
  });

  it('retries once on network failure or 5xx and succeeds on retry', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { rate: 58.124 } }), { status: 200 })
      );

    const result = await fetchYadioRate(mockFetch, 0);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.rate).toBe(58.12);
  });

  it('throws YadioServiceError after retry is exhausted', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on sanity check failure or 4xx response', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ rate: 0.95 }), { status: 200 }));

    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(fetchYadioRate(mockFetch, 0)).rejects.toThrow(YadioServiceError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
