ALTER TABLE rates ADD COLUMN buy_rate REAL CHECK (buy_rate IS NULL OR buy_rate > 0);
ALTER TABLE rates ADD COLUMN sell_rate REAL CHECK (sell_rate IS NULL OR sell_rate > 0);
