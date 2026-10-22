-- Migration 003: serialize same-plate RPC calls before looking for an active row.
-- Apply after 002; no data is deleted or rewritten.
-- Transaction locks release on commit/rollback. READ COMMITTED is required.

BEGIN;

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

-- Migration 001 created a five-argument overload; 002 added a six-argument
-- overload with defaults. Together they make five-argument calls ambiguous.
-- The current function accepts the same four/five arguments through defaults,
-- so remove only the obsolete overload. No CASCADE: unexpected dependencies
-- must stop this migration for review instead of being silently removed.
DROP FUNCTION IF EXISTS public.process_vehicle(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER);

COMMIT;
