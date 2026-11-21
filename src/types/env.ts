export type Currency = 'BCV_USD' | 'BCV_EUR' | 'YD_USD';
export type RateSource = 'BCV' | 'YADIO';
export type SyncSource = 'bcv' | 'yadio' | 'all';
export type SyncLogSource = 'BCV' | 'YADIO' | 'ALL';

export interface Env {
  DB: D1Database;
  API_SECRET_KEYS: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

export interface RateRecord {
  id: number;
  rate: number;
  buy_rate: number | null;
  sell_rate: number | null;
  currency: Currency;
  name: string;
  source: RateSource;
  created_at: string;
}

export interface NewRateRecord {
  rate: number;
  buy_rate?: number | null;
  sell_rate?: number | null;
  currency: Currency;
  name: string;
  source: RateSource;
}

export interface TodayRateRecord extends RateRecord {
  isFallback: boolean;
}

export interface PaginationMeta {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
}

export interface PaginatedRatesResponse {
  rates: RateRecord[];
  pagination: PaginationMeta;
}

export interface SyncLogEntry {
  source: SyncLogSource;
  status: 'SUCCESS' | 'ERROR';
  message?: string;
  duration_ms: number;
}
