-- D1 schema for the PastaPass latency benchmark.
--
-- One row per (bot, trial). server_latency_ns is the authoritative number:
-- the mock server's own release->hit delta, measured on a single monotonic clock,
-- so it is directly comparable across every approach and language.
--
-- Apply with:
--   npx wrangler d1 execute pastapass --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS measurements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT    NOT NULL,               -- groups every row from one upload
  approach          TEXT    NOT NULL,               -- browser-observer | http-direct | browser-hybrid
  lang              TEXT    NOT NULL DEFAULT '?',    -- python | node | go
  trial             INTEGER NOT NULL,
  server_latency_ns INTEGER NOT NULL,               -- release->hit, nanoseconds (the score)
  client_fire_ns    INTEGER,                        -- diagnostic: local detect->fired
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_measurements_group ON measurements (approach, lang);
CREATE INDEX IF NOT EXISTS idx_measurements_run   ON measurements (run_id);
