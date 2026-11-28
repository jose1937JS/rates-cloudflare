import type { UsdtTierBucket, UsdtTierKey } from '../config/usdt-tiers';

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

export interface UsdtP2PTierRecord {
  tier_key: UsdtTierKey;
  label: string;
  bucket: UsdtTierBucket;
  sort_order: number;
  ref_usdt: number | null;
  amount_ves: number | null;
  buy_rate: number | null;
  sell_rate: number | null;
  avg_rate: number | null;
  sample_count_buy: number;
  sample_count_sell: number;
  is_fallback: number;
  base_rate: number;
  updated_at: string;
}

export interface NewUsdtP2PTierRecord {
  tier_key: UsdtTierKey;
  label: string;
  bucket: UsdtTierBucket;
  sort_order: number;
  ref_usdt: number | null;
  amount_ves: number | null;
  buy_rate: number | null;
  sell_rate: number | null;
  avg_rate: number | null;
  sample_count_buy: number;
  sample_count_sell: number;
  is_fallback: 0 | 1;
  base_rate: number;
  updated_at: string;
}

export interface UsdtP2PTierDto {
  tier_key: UsdtTierKey | string;
  label: string;
  bucket: UsdtTierBucket;
  ref_usdt: number | null;
  amount_ves: number | null;
  buy_rate: number | null;
  sell_rate: number | null;
  avg_rate: number | null;
  sample_count_buy: number;
  sample_count_sell: number;
  is_fallback: boolean;
}

export interface UsdtP2PTiersResponse {
  currency: 'YD_USD';
  source: 'YADIO_BINANCE_P2P';
  min_usdt: number;
  min_ves: number | null;
  base_rate: number;
  updated_at: string;
  tiers: UsdtP2PTierDto[];
}

export type UsdtAmountMatchType =
  | 'clamped_min'
  | 'exact_tier'
  | 'nearest_tier'
  | 'unfiltered_max'
  | 'rates_fallback';

export interface UsdtRateByAmountResponse {
  requested_ves: number;
  matched_tier_key: string;
  bucket: UsdtTierBucket;
  match_type: UsdtAmountMatchType;
  buy_rate: number | null;
  sell_rate: number | null;
  avg_rate: number | null;
  min_ves: number | null;
  updated_at: string;
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
