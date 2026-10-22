-- ─────────────────────────────────────────────────────────────────────────
-- VinFast Phúc Lợi Bot — Supabase Schema
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor)
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- DANH SÁCH CHÍNH (vehicles)
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vehicles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       TEXT NOT NULL UNIQUE,
  plate            TEXT NOT NULL,
  time_in          TIMESTAMPTZ NOT NULL,
  time_out         TIMESTAMPTZ,
  duration_minutes INTEGER,
  image_in_url     TEXT NOT NULL DEFAULT '',
  image_out_url    TEXT,
  status           TEXT NOT NULL DEFAULT 'Đang trong xưởng',
  priority         TEXT NOT NULL DEFAULT 'Bình thường',
  vehicle_model    TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_plate_status ON vehicles (plate, status);
CREATE INDEX IF NOT EXISTS idx_vehicles_status        ON vehicles (status);
CREATE INDEX IF NOT EXISTS idx_vehicles_time_in       ON vehicles (time_in);
CREATE INDEX IF NOT EXISTS idx_vehicles_time_out      ON vehicles (time_out);
CREATE INDEX IF NOT EXISTS idx_vehicles_vehicle_id    ON vehicles (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_model         ON vehicles (vehicle_model);

-- ─────────────────────────────────────────
-- NHẬT KÝ (events)
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         TEXT NOT NULL UNIQUE,
  timestamp        TIMESTAMPTZ NOT NULL,
  record_type      TEXT NOT NULL DEFAULT 'Chưa xác định',
  plate_ai         TEXT NOT NULL DEFAULT '',
  confidence_label TEXT NOT NULL DEFAULT '',
  image_url        TEXT NOT NULL DEFAULT '',
  sender           TEXT NOT NULL DEFAULT '',
  message_key      TEXT NOT NULL DEFAULT '',  -- [MSG_ID:chatId_msgId] for idempotency
  result           TEXT NOT NULL DEFAULT ''
);

-- Unique index on message_key enables O(1) idempotency checks
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_message_key
  ON events (message_key)
  WHERE message_key != '';

CREATE INDEX IF NOT EXISTS idx_events_event_id  ON events (event_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);

-- ─────────────────────────────────────────
-- CẦN KIỂM TRA (reviews)
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_id          TEXT NOT NULL UNIQUE,
  event_id          TEXT NOT NULL DEFAULT '',
  timestamp         TIMESTAMPTZ NOT NULL,
  image_url         TEXT NOT NULL DEFAULT '',
  plate_ai          TEXT NOT NULL DEFAULT '',
  corrected_plate   TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  suggestion        TEXT NOT NULL DEFAULT '',
  review_status     TEXT NOT NULL DEFAULT 'Chưa xử lý',
  review_note       TEXT NOT NULL DEFAULT '',
  reviewer          TEXT NOT NULL DEFAULT '',
  resolved_at       TIMESTAMPTZ,
  linked_vehicle_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reviews_review_status ON reviews (review_status);
CREATE INDEX IF NOT EXISTS idx_reviews_timestamp     ON reviews (timestamp);

-- ─────────────────────────────────────────
-- process_vehicle RPC
--
-- Atomically decides whether an incoming photo is a VAO (entry) or RA (exit).
-- A transaction-scoped advisory lock serializes this RPC for one plate before
-- its lookup, including first entry when there is no row to lock. FOR UPDATE
-- retains the active-row lock. The RPC uses PostgreSQL's READ COMMITTED default.
--
-- Returns one row:
--   action      TEXT  -- 'VAO' | 'RA' | 'RA_DUPLICATE'
--   vehicle_id  TEXT  -- trip ID
--   time_in_ts  TIMESTAMPTZ
--   seconds_in  NUMERIC  -- 0 for VAO; seconds car has been in workshop for RA
-- ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION process_vehicle(
  p_plate              TEXT,
  p_vehicle_id         TEXT,
  p_now_ts             TIMESTAMPTZ,
  p_image_url          TEXT,
  p_min_workshop_secs  INTEGER DEFAULT 900,
  p_vehicle_model      TEXT DEFAULT ''
)
RETURNS TABLE(
  action      TEXT,
  vehicle_id  TEXT,
  time_in_ts  TIMESTAMPTZ,
  seconds_in  NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row    vehicles%ROWTYPE;
  v_secs   NUMERIC;
BEGIN
  -- Row locks cannot protect a plate that has no active row yet. Lock its key
  -- before the lookup; release is automatic on transaction commit or rollback.
  -- Separate statements let the lookup see a preceding commit after waiting
  -- under READ COMMITTED. Writers bypassing this RPC must coordinate separately.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vehicle-workflow:process_vehicle:' || p_plate, 0)
  );

  -- Lock the active row for this plate, if one exists after the plate lock.
  SELECT * INTO v_row
  FROM vehicles
  WHERE plate = p_plate
    AND status = 'Đang trong xưởng'
  ORDER BY time_in DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_secs := EXTRACT(EPOCH FROM (p_now_ts - v_row.time_in));

    IF v_secs < p_min_workshop_secs THEN
      -- Too quick: car entered less than p_min_workshop_secs ago.
      -- Likely a burst duplicate or OCR misread. Do NOT mark as RA.
      RETURN QUERY
        SELECT 'RA_DUPLICATE'::TEXT, v_row.vehicle_id, v_row.time_in, v_secs;
    ELSE
      -- Real exit: update record atomically while we hold the row lock.
      UPDATE vehicles SET
        time_out         = p_now_ts,
        duration_minutes = ROUND(v_secs / 60)::INTEGER,
        image_out_url    = p_image_url,
        status           = 'Đã ra xưởng',
        priority         = 'Bình thường',
        updated_at       = now()
      WHERE id = v_row.id;

      RETURN QUERY
        SELECT 'RA'::TEXT, v_row.vehicle_id, v_row.time_in, v_secs;
    END IF;

  ELSE
    -- No active row → new entry (VAO)
    INSERT INTO vehicles (
      vehicle_id, plate, time_in, image_in_url, status, priority, vehicle_model, updated_at
    ) VALUES (
      p_vehicle_id, p_plate, p_now_ts, p_image_url, 'Đang trong xưởng', 'Bình thường', p_vehicle_model, now()
    );

    RETURN QUERY
      SELECT 'VAO'::TEXT, p_vehicle_id, p_now_ts, 0::NUMERIC;
  END IF;
END;
$$;

-- Grant execute to the service role (used by the bot's service key)
GRANT EXECUTE ON FUNCTION process_vehicle(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) TO service_role;
