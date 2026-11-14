CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate REAL NOT NULL CHECK (rate > 0),
  currency TEXT NOT NULL CHECK (currency IN ('BCV_USD', 'BCV_EUR', 'YD_USD')),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('BCV', 'YADIO')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_rates_currency_created_at
  ON rates (currency, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('BCV', 'YADIO', 'ALL')),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'ERROR')),
  message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at
  ON sync_logs (created_at DESC);
