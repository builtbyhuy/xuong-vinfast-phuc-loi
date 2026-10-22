-- Exact function from commit 22935d3b2db0b1891e0a8d02bb7ea152ac4559a9, schema blob a2c99587e8ddafd455705e8bb40efb2eac31aa78.
-- Preserved only to reproduce the concurrent-first-entry regression.
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
  -- Lock the active row for this plate (if any).
  -- Concurrent calls for the same plate block here until the first completes.
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
GRANT EXECUTE ON FUNCTION process_vehicle TO service_role;
