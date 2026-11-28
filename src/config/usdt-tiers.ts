export type UsdtTierBucket = 'small' | 'medium' | 'large' | 'unfiltered';

export type UsdtTierKey =
  | 'tier_5'
  | 'tier_15'
  | 'tier_35'
  | 'tier_75'
  | 'tier_150'
  | 'tier_400'
  | 'unfiltered';

export interface UsdtTierDefinition {
  tierKey: UsdtTierKey;
  label: string;
  bucket: UsdtTierBucket;
  refUsdt: number | null;
  sortOrder: number;
}

export const USDT_MIN_TIER_AMOUNT = 5;

export const USDT_P2P_TIERS: readonly UsdtTierDefinition[] = [
  { tierKey: 'tier_5', label: 'Mínimo (5 USDT)', bucket: 'small', refUsdt: 5, sortOrder: 1 },
  { tierKey: 'tier_15', label: 'Pequeño (15 USDT)', bucket: 'small', refUsdt: 15, sortOrder: 2 },
  { tierKey: 'tier_35', label: 'Pequeño (35 USDT)', bucket: 'small', refUsdt: 35, sortOrder: 3 },
  { tierKey: 'tier_75', label: 'Mediano (75 USDT)', bucket: 'medium', refUsdt: 75, sortOrder: 4 },
  { tierKey: 'tier_150', label: 'Mediano (150 USDT)', bucket: 'medium', refUsdt: 150, sortOrder: 5 },
  { tierKey: 'tier_400', label: 'Grande (400 USDT)', bucket: 'large', refUsdt: 400, sortOrder: 6 },
  {
    tierKey: 'unfiltered',
    label: 'Mercado general',
    bucket: 'unfiltered',
    refUsdt: null,
    sortOrder: 7,
  },
] as const;
