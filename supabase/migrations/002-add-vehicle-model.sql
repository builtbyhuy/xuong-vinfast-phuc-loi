-- ─────────────────────────────────────────────────────────────────────────
-- Migration 002: Thêm cột vehicle_model vào bảng vehicles
-- Nhận diện loại xe VinFast (VF 5, VF 8, Lux A2.0, etc.)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_model TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_vehicles_model ON vehicles (vehicle_model);

-- ─────────────────────────────────────────────────────────────────────────
-- Cập nhật RPC process_vehicle: thêm param p_vehicle_model
-- ─────────────────────────────────────────────────────────────────────────

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
      RETURN QUERY
        SELECT 'RA_DUPLICATE'::TEXT, v_row.vehicle_id, v_row.time_in, v_secs;
    ELSE
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

GRANT EXECUTE ON FUNCTION process_vehicle(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) TO service_role;
