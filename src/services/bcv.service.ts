import type { NewRateRecord } from '../types/env';

const BCV_URL = 'https://www.bcv.org.ve/terminos-condiciones';
const BCV_TIMEOUT_MS = 10_000;
const BCV_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class BcvScrapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BcvScrapeError';
  }
}

function parseSanitizedRate(raw: string, label: string): number {
  let normalized = raw.replace(/\s+/g, '');

  // Formato numérico venezolano/europeo: puntos como separadores de miles y comas como decimales
  // Ej: "1.010,56078251" -> "1010.56078251" o "914,02180000" -> "914.02180000"
  if (normalized.includes(',')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new BcvScrapeError(`Invalid ${label} rate format: "${raw.trim()}"`);
  }

  const parsed = Number(parseFloat(normalized).toFixed(2));
  if (!Number.isFinite(parsed) || parsed <= 1 || parsed >= 100_000) {
    throw new BcvScrapeError(`${label} rate out of sanity bounds: ${parsed}`);
  }

  return parsed;
}

function extractTagContentByIdFallback(html: string, id: string): string {
  const openTagRegex = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const openMatch = openTagRegex.exec(html);
  if (!openMatch || openMatch.index === undefined) return '';

  const tagName = openMatch[1];
  const contentStart = openMatch.index + openMatch[0].length;
  const tagBoundaryRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagBoundaryRegex.lastIndex = contentStart;

  let depth = 1;
  let contentEnd = -1;
  let boundaryMatch: RegExpExecArray | null;

  while ((boundaryMatch = tagBoundaryRegex.exec(html)) !== null) {
    const token = boundaryMatch[0];
    if (token.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        contentEnd = boundaryMatch.index;
        break;
      }
    } else if (!token.endsWith('/>')) {
      depth += 1;
    }
  }

  if (contentEnd === -1) return '';

  const innerHtml = html.slice(contentStart, contentEnd);
  const strongMatch = /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(innerHtml);
  const rawContent = strongMatch ? strongMatch[1] : innerHtml;
  return rawContent.replace(/<[^>]+>/g, '');
}

async function extractBcvTexts(response: Response): Promise<{ usdRaw: string; eurRaw: string }> {
  if (typeof HTMLRewriter !== 'undefined') {
    let usdStrong = '';
    let usdContainer = '';
    let eurStrong = '';
    let eurContainer = '';

    const rewriter = new HTMLRewriter()
      .on('#dolar strong', {
        text(chunk) {
          usdStrong += chunk.text;
        },
      })
      .on('#dolar', {
        text(chunk) {
          usdContainer += chunk.text;
        },
      })
      .on('#euro strong', {
        text(chunk) {
          eurStrong += chunk.text;
        },
      })
      .on('#euro', {
        text(chunk) {
          eurContainer += chunk.text;
        },
      });

    await rewriter.transform(response).text();

    return {
      usdRaw: usdStrong.trim() ? usdStrong : usdContainer,
      eurRaw: eurStrong.trim() ? eurStrong : eurContainer,
    };
  }

  const html = await response.text();
  return {
    usdRaw: extractTagContentByIdFallback(html, 'dolar'),
    eurRaw: extractTagContentByIdFallback(html, 'euro'),
  };
}

export async function fetchBcvRates(fetcher: typeof fetch = fetch): Promise<NewRateRecord[]> {
  let response: Response;
  try {
    response = await fetcher(BCV_URL, {
      headers: {
        'User-Agent': BCV_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(BCV_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BcvScrapeError(`Failed to fetch BCV page: ${message}`);
  }

  if (!response.ok) {
    throw new BcvScrapeError(`BCV responded with HTTP ${response.status}`);
  }

  const { usdRaw, eurRaw } = await extractBcvTexts(response);

  if (!usdRaw.trim() || !eurRaw.trim()) {
    throw new BcvScrapeError('Missing #dolar or #euro elements in BCV HTML');
  }

  const usdRate = parseSanitizedRate(usdRaw, 'BCV_USD');
  const eurRate = parseSanitizedRate(eurRaw, 'BCV_EUR');

  return [
    {
      rate: usdRate,
      currency: 'BCV_USD',
      name: 'Dólar',
      source: 'BCV',
    },
    {
      rate: eurRate,
      currency: 'BCV_EUR',
      name: 'Euro',
      source: 'BCV',
    },
  ];
}
