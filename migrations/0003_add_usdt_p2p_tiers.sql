CREATE TABLE IF NOT EXISTS usdt_p2p_tiers (
  tier_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('small', 'medium', 'large', 'unfiltered')),
  sort_order INTEGER NOT NULL,
  ref_usdt REAL,
  amount_ves REAL,
  buy_rate REAL CHECK (buy_rate IS NULL OR buy_rate > 0),
  sell_rate REAL CHECK (sell_rate IS NULL OR sell_rate > 0),
  avg_rate REAL CHECK (avg_rate IS NULL OR avg_rate > 0),
  sample_count_buy INTEGER NOT NULL DEFAULT 0,
  sample_count_sell INTEGER NOT NULL DEFAULT 0,
  is_fallback INTEGER NOT NULL DEFAULT 0 CHECK (is_fallback IN (0, 1)),
  base_rate REAL NOT NULL CHECK (base_rate > 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usdt_p2p_tiers_sort_order
  ON usdt_p2p_tiers (sort_order ASC);
