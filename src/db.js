'use strict';

/**
 * Supabase (PostgreSQL) client — source of truth for all transactional data.
 *
 * Replaces Google Sheets as the operational database. Sheets is now an async
 * read-only mirror maintained by sheets-sync.js.
 *
 * process_vehicle() uses a per-plate transaction advisory lock before looking
 * up the active row, then SELECT FOR UPDATE. Apply migration 003 for existing
 * databases. This coordinates RPC callers at READ COMMITTED, including a plate
 * without an active row; it does not serialize unrelated direct table writes.
 */

const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const logger = require('./logger');

let supabase = null;
let appTimezone = 'Asia/Ho_Chi_Minh';

function initDb(config) {
  appTimezone = config.timezone || 'Asia/Ho_Chi_Minh';
  supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  });
  logger.info('Supabase initialized', { url: config.supabase.url });
}

/**
 * Test kết nối Supabase — gọi khi khởi động để fail-fast nếu credentials sai.
 */
async function testConnection() {
  const { count, error } = await supabase
    .from('vehicles')
    .select('*', { count: 'exact', head: true })
    .limit(1);

  if (error) throw new Error(`Supabase connection test failed: ${error.message}`);
  logger.info('Supabase connection verified', { vehicleCount: count });
}

// ──────────────────────────────────────────────
// Core vehicle processing RPC
// ──────────────────────────────────────────────

/**
 * Atomically decides VAO or RA for a plate.
 *
 * @returns {{ action: 'VAO'|'RA'|'RA_DUPLICATE', vehicle_id: string, time_in_ts: string, seconds_in: number }}
 */
async function processVehicleDecision(plate, vehicleId, nowIso, imageUrl, minWorkshopSecs = 900, vehicleModel = '') {
  const { data, error } = await supabase.rpc('process_vehicle', {
    p_plate:              plate,
    p_vehicle_id:         vehicleId,
    p_now_ts:             nowIso,
    p_image_url:          imageUrl,
    p_min_workshop_secs:  minWorkshopSecs,
    p_vehicle_model:      vehicleModel,
  });

  if (error) throw new Error(`process_vehicle RPC failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error('process_vehicle RPC returned no rows');

  return data[0]; // { action, vehicle_id, time_in_ts, seconds_in }
}

// ──────────────────────────────────────────────
// Events (NHẬT KÝ)
// ──────────────────────────────────────────────

async function insertEvent(row) {
  const { error } = await supabase.from('events').insert({
    event_id:         row.eventId,
    timestamp:        row.timestamp,       // ISO string
    record_type:      row.recordType || 'Chưa xác định',
    plate_ai:         row.plateAI || '',
    confidence_label: row.confidenceLabel || '',
    image_url:        row.imageUrl || '',
    sender:           row.sender || '',
    message_key:      row.messageKey || '', // [MSG_ID:chatId_msgId]
    result:           row.result || '',
  });

  if (error) throw new Error(`insertEvent failed: ${error.message}`);
  logger.info('Event inserted', { eventId: row.eventId });
}

async function updateEventResult(eventId, result) {
  const { error } = await supabase
    .from('events')
    .update({ result })
    .eq('event_id', eventId);

  if (error) throw new Error(`updateEventResult failed: ${error.message}`);
  logger.info('Event result updated', { eventId, result });
}

// ──────────────────────────────────────────────
// Reviews (CẦN KIỂM TRA)
// ──────────────────────────────────────────────

async function insertReview(row) {
  const { error } = await supabase.from('reviews').insert({
    error_id:          row.errorId,
    event_id:          row.eventId || '',
    timestamp:         row.timestamp,      // ISO string
    image_url:         row.imageUrl || '',
    plate_ai:          row.plateAI || '',
    corrected_plate:   row.correctedPlate || '',
    reason:            row.reason || '',
    suggestion:        row.suggestion || '',
    review_status:     row.reviewStatus || 'Chưa xử lý',
    review_note:       row.reviewNote || '',
    reviewer:          row.reviewer || '',
    linked_vehicle_id: row.linkedVehicleId || '',
  });

  if (error) throw new Error(`insertReview failed: ${error.message}`);
  logger.info('Review inserted', { errorId: row.errorId });
}

// ──────────────────────────────────────────────
// Idempotency (O(1) index lookup)
// ──────────────────────────────────────────────

async function isMessageProcessed(messageKey) {
  const marker = `[MSG_ID:${messageKey}]`;
  const { data, error } = await supabase
    .from('events')
    .select('event_id')
    .eq('message_key', marker)
    .limit(1);

  if (error) {
    // Fail open — never block messages due to a DB error
    logger.error('isMessageProcessed query failed', { error: error.message });
    return false;
  }

  return data.length > 0;
}

// ──────────────────────────────────────────────
// Workshop queries
// ──────────────────────────────────────────────

async function getAllInWorkshop(tz) {
  const zone = tz || appTimezone;
  const { data, error } = await supabase
    .from('vehicles')
    .select('vehicle_id, plate, time_in, priority, note, vehicle_model')
    .eq('status', 'Đang trong xưởng')
    .order('time_in', { ascending: true });

  if (error) throw new Error(`getAllInWorkshop failed: ${error.message}`);
  return (data || []).map(v => ({
    vehicleId: v.vehicle_id,
    plate:     v.plate,
    timeIn:    fmtTs(v.time_in, zone),
    priority:  v.priority,
    note:      v.note || '',
    vehicleModel: v.vehicle_model || '',
  }));
}

/**
 * Expire xe kẹt quá lâu trong xưởng.
 * Đánh dấu status = 'Hết hạn theo dõi' cho xe vào trước cutoffIso.
 * @returns {number} Số xe đã expire
 */
async function expireStaleVehicles(cutoffIso, nowIso) {
  const { data, error } = await supabase
    .from('vehicles')
    .update({
      status: 'Hết hạn theo dõi',
      note: `Tự động đóng — xe không có ảnh ra sau thời gian theo dõi`,
      updated_at: nowIso,
    })
    .eq('status', 'Đang trong xưởng')
    .lt('time_in', cutoffIso)
    .select('vehicle_id');

  if (error) throw new Error(`expireStaleVehicles failed: ${error.message}`);
  return (data || []).length;
}

/**
 * Auto-close vehicles that have been in workshop for more than 72 hours.
 * Returns array of closed vehicles with formatted time_in.
 */
async function autoCloseVehicles(cutoffIso, nowIso) {
  const zone = appTimezone;
  const { data, error } = await supabase
    .from('vehicles')
    .update({
      status: 'Đã ra xưởng',
      note: 'Tự động đóng — quá 72h không có ảnh ra',
      time_out: nowIso,
      updated_at: nowIso,
    })
    .eq('status', 'Đang trong xưởng')
    .lt('time_in', cutoffIso)
    .select('vehicle_id, plate, time_in');

  if (error) throw new Error(`autoCloseVehicles failed: ${error.message}`);
  return (data || []).map(v => ({
    vehicleId: v.vehicle_id,
    plate: v.plate,
    timeIn: fmtTs(v.time_in, zone),
  }));
}

/**
 * Force-exit 1 xe theo vehicleId.
 */
async function forceExitVehicle(vehicleId, nowIso) {
  const { data, error } = await supabase
    .from('vehicles')
    .update({
      status: 'Đã ra xưởng',
      time_out: nowIso,
      note: 'Force-exit bởi admin',
      updated_at: nowIso,
    })
    .eq('vehicle_id', vehicleId)
    .eq('status', 'Đang trong xưởng')
    .select('vehicle_id, plate');

  if (error) throw new Error(`forceExitVehicle failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return data[0];
}

/**
 * Đếm xe đang trong xưởng.
 */
async function countInWorkshop() {
  const { count, error } = await supabase
    .from('vehicles')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'Đang trong xưởng');

  if (error) throw new Error(`countInWorkshop failed: ${error.message}`);
  return count || 0;
}

/**
 * Force-exit xe theo biển số (cho lệnh RA thủ công).
 * Tìm xe mới nhất có plate + status='Đang trong xưởng' → update ra.
 */
async function forceExitByPlate(plate, nowIso) {
  // Tìm xe mới nhất đang trong xưởng
  const { data: found, error: findErr } = await supabase
    .from('vehicles')
    .select('vehicle_id, plate, time_in')
    .eq('plate', plate)
    .eq('status', 'Đang trong xưởng')
    .order('time_in', { ascending: false })
    .limit(1);

  if (findErr) throw new Error(`forceExitByPlate find failed: ${findErr.message}`);
  if (!found || found.length === 0) return null;

  const vehicle = found[0];
  const timeInDt = DateTime.fromISO(vehicle.time_in, { zone: appTimezone });
  const nowDt    = DateTime.fromISO(nowIso, { zone: appTimezone });
  const duration = Math.round(nowDt.diff(timeInDt, 'minutes').minutes);

  const { error: updateErr } = await supabase
    .from('vehicles')
    .update({
      status: 'Đã ra xưởng',
      time_out: nowIso,
      duration_minutes: duration > 0 ? duration : 0,
      note: 'RA thủ công qua Telegram',
      updated_at: nowIso,
    })
    .eq('vehicle_id', vehicle.vehicle_id);

  if (updateErr) throw new Error(`forceExitByPlate update failed: ${updateErr.message}`);

  return {
    vehicleId: vehicle.vehicle_id,
    plate: vehicle.plate,
    timeIn: fmtTs(vehicle.time_in, appTimezone),
    duration,
  };
}

async function updateVehiclePriority(vehicleId, priority, nowIso) {
  const { error } = await supabase
    .from('vehicles')
    .update({ priority, updated_at: nowIso })
    .eq('vehicle_id', vehicleId);

  if (error) throw new Error(`updateVehiclePriority failed: ${error.message}`);
}

// ──────────────────────────────────────────────
// Dashboard queries
// ──────────────────────────────────────────────

/**
 * Xe vào hoặc ra trong một ngày cụ thể (dùng cho dashboard).
 * @param {string} dateIso - ISO date string cho startOf day
 * @param {string} nextDateIso - ISO date string cho startOf ngày tiếp theo
 */
async function getVehiclesByDateRange(dateIso, nextDateIso, tz) {
  const zone = tz || appTimezone;
  const { data, error } = await supabase
    .from('vehicles')
    .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, vehicle_model')
    .or(`time_in.gte.${dateIso},time_out.gte.${dateIso}`)
    .or(`time_in.lt.${nextDateIso},time_out.lt.${nextDateIso}`)
    .order('time_in', { ascending: true });

  if (error) throw new Error(`getVehiclesByDateRange failed: ${error.message}`);

  const now = DateTime.now().setZone(zone);
  const startDt = DateTime.fromISO(dateIso, { zone });

  return (data || []).filter(v => {
    const tIn  = v.time_in  ? DateTime.fromISO(v.time_in,  { zone }) : null;
    const tOut = v.time_out ? DateTime.fromISO(v.time_out, { zone }) : null;
    return (tIn && tIn >= startDt && tIn < DateTime.fromISO(nextDateIso, { zone }))
        || (tOut && tOut >= startDt && tOut < DateTime.fromISO(nextDateIso, { zone }));
  }).map(v => ({
    vehicleId:     v.vehicle_id,
    plate:         v.plate,
    timeIn:        fmtTs(v.time_in, zone),
    timeOut:       fmtTs(v.time_out, zone),
    timeInISO:     v.time_in,
    timeOutISO:    v.time_out,
    durationMinutes: v.duration_minutes,
    status:        v.status,
    priority:      v.priority,
    vehicleModel:  v.vehicle_model || '',
  }));
}

/**
 * Xe vào/ra hôm nay.
 */
async function getTodayActivity(tz) {
  const zone = tz || appTimezone;
  const now = DateTime.now().setZone(zone);
  const startOfDay = now.startOf('day').toISO();
  const startOfTomorrow = now.plus({ days: 1 }).startOf('day').toISO();
  return getVehiclesByDateRange(startOfDay, startOfTomorrow, zone);
}

/**
 * Xe vào/ra hôm qua.
 */
async function getYesterdayActivity(tz) {
  const zone = tz || appTimezone;
  const now = DateTime.now().setZone(zone);
  const yesterday = now.minus({ days: 1 });
  const startOfYesterday = yesterday.startOf('day').toISO();
  const startOfToday = now.startOf('day').toISO();
  return getVehiclesByDateRange(startOfYesterday, startOfToday, zone);
}

// ──────────────────────────────────────────────
// Daily summary (BAOCAO)
// ──────────────────────────────────────────────

async function getDailySummary(tz) {
  const zone = tz || appTimezone;
  const now  = DateTime.now().setZone(zone);
  const since = now.minus({ days: 7 }).startOf('day').toISO();

  const [recentRes, workshopRes, reviewRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('vehicle_id, time_in, time_out, duration_minutes, status, priority')
      .gte('time_in', since),
    supabase
      .from('vehicles')
      .select('vehicle_id, time_in, time_out, duration_minutes, status, priority')
      .eq('status', 'Đang trong xưởng'),
    supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'Chưa xử lý'),
  ]);

  if (recentRes.error)   throw new Error(`getDailySummary recent: ${recentRes.error.message}`);
  if (workshopRes.error) throw new Error(`getDailySummary workshop: ${workshopRes.error.message}`);
  if (reviewRes.error)   logger.error('getDailySummary reviews query failed (non-blocking)', { error: reviewRes.error.message });

  const rows = mergeUnique([...(recentRes.data || []), ...(workshopRes.data || [])], 'vehicle_id');

  let totalIn = 0, totalOut = 0, inWorkshop = 0;
  let warningCount = 0, urgentCount = 0, totalDuration = 0, completedCount = 0;

  for (const v of rows) {
    const timeIn  = v.time_in  ? DateTime.fromISO(v.time_in,  { zone }) : null;
    const timeOut = v.time_out ? DateTime.fromISO(v.time_out, { zone }) : null;

    if (timeIn  && isSameDay(timeIn,  now)) totalIn++;
    if (timeOut && isSameDay(timeOut, now)) {
      totalOut++;
      if (v.duration_minutes != null) {
        totalDuration += v.duration_minutes;
        completedCount++;
      }
    }
    if (v.status === 'Đang trong xưởng') {
      inWorkshop++;
      if (v.priority === 'Cảnh báo') warningCount++;
      if (v.priority === 'Khẩn')     urgentCount++;
    }
  }

  return {
    today:         now.toFormat('dd/MM/yyyy'),
    totalIn,
    totalOut,
    inWorkshop,
    warningCount,
    urgentCount,
    pendingReview: reviewRes.count || 0,
    avgDuration:   completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
  };
}

// ──────────────────────────────────────────────
// Productivity data (NANGSUAT)
// ──────────────────────────────────────────────

async function getProductivityData(tz) {
  const zone      = tz || appTimezone;
  const now       = DateTime.now().setZone(zone);
  const yesterday = now.minus({ days: 1 });
  const since     = yesterday.startOf('day').toISO();

  const [recentRes, workshopRes, reviewRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, vehicle_model')
      .gte('time_in', since),
    supabase
      .from('vehicles')
      .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, vehicle_model')
      .eq('status', 'Đang trong xưởng'),
    supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'Chưa xử lý'),
  ]);

  if (recentRes.error)   throw new Error(`getProductivityData recent: ${recentRes.error.message}`);
  if (workshopRes.error) throw new Error(`getProductivityData workshop: ${workshopRes.error.message}`);
  if (reviewRes.error)   logger.error('getProductivityData reviews query failed (non-blocking)', { error: reviewRes.error.message });

  const rows = mergeUnique([...(recentRes.data || []), ...(workshopRes.data || [])], 'vehicle_id');

  let todayIn = 0, todayOut = 0, inWorkshop = 0, warningCount = 0, urgentCount = 0;
  let totalDuration = 0, completedCount = 0, fastestVehicle = null, slowestVehicle = null;
  let yesterdayIn = 0, yesterdayOut = 0, yesterdayTotalDuration = 0, yesterdayCompletedCount = 0;
  const timeSlots = { sang: 0, chieu: 0, toi: 0, dem: 0 };

  for (const v of rows) {
    const timeIn  = v.time_in  ? DateTime.fromISO(v.time_in,  { zone }) : null;
    const timeOut = v.time_out ? DateTime.fromISO(v.time_out, { zone }) : null;
    const dur     = v.duration_minutes;

    if (timeIn) {
      if (isSameDay(timeIn, now)) {
        todayIn++;
        const h = timeIn.hour;
        if (h >= 6 && h < 12)      timeSlots.sang++;
        else if (h >= 12 && h < 18) timeSlots.chieu++;
        else if (h >= 18)           timeSlots.toi++;
        else                        timeSlots.dem++;
      }
      if (isSameDay(timeIn, yesterday)) yesterdayIn++;
    }

    if (timeOut) {
      if (isSameDay(timeOut, now) && dur != null) {
        todayOut++;
        totalDuration += dur;
        completedCount++;
        if (!fastestVehicle || dur < fastestVehicle.duration) fastestVehicle = { plate: v.plate, duration: dur };
        if (!slowestVehicle || dur > slowestVehicle.duration) slowestVehicle = { plate: v.plate, duration: dur };
      }
      if (isSameDay(timeOut, yesterday) && dur != null) {
        yesterdayOut++;
        yesterdayTotalDuration += dur;
        yesterdayCompletedCount++;
      }
    }

    if (v.status === 'Đang trong xưởng') {
      inWorkshop++;
      if (v.priority === 'Cảnh báo') warningCount++;
      if (v.priority === 'Khẩn')     urgentCount++;
    }
  }

  return {
    today:        now.toFormat('dd/MM/yyyy'),
    yesterday:    yesterday.toFormat('dd/MM/yyyy'),
    todayIn,
    todayOut,
    inWorkshop,
    warningCount,
    urgentCount,
    pendingReview:         reviewRes.count || 0,
    completedCount,
    avgDuration:           completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
    fastestVehicle,
    slowestVehicle,
    timeSlots,
    yesterdayIn,
    yesterdayOut,
    yesterdayAvgDuration:  yesterdayCompletedCount > 0
      ? Math.round(yesterdayTotalDuration / yesterdayCompletedCount) : 0,
    completionRate:        todayIn > 0 ? Math.round((todayOut / todayIn) * 100) : 0,
  };
}

// ──────────────────────────────────────────────
// getAllMainRows (for accounting report cross-reference)
// ──────────────────────────────────────────────

async function getAllMainRows(tz) {
  const zone = tz || appTimezone;
  const { data, error } = await supabase
    .from('vehicles')
    .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, note, vehicle_model')
    .order('time_in', { ascending: true });

  if (error) throw new Error(`getAllMainRows failed: ${error.message}`);
  return (data || []).map(v => ({
    vehicleId: v.vehicle_id,
    plate:     v.plate,
    timeIn:    fmtTs(v.time_in, zone),
    timeOut:   fmtTs(v.time_out, zone),
    duration:  v.duration_minutes != null ? String(v.duration_minutes) : '',
    status:    v.status,
    priority:  v.priority,
    note:      v.note || '',
    vehicleModel: v.vehicle_model || '',
  }));
}

// ──────────────────────────────────────────────
// Full daily report (BAOCAO + NANGSUAT + TONKHO)
// ──────────────────────────────────────────────

async function getFullDailyReport(tz) {
  const zone      = tz || appTimezone;
  const now       = DateTime.now().setZone(zone);
  const yesterday = now.minus({ days: 1 });
  const since     = yesterday.startOf('day').toISO();

  const [recentRes, workshopRes, reviewRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, vehicle_model')
      .gte('time_in', since),
    supabase
      .from('vehicles')
      .select('vehicle_id, plate, time_in, time_out, duration_minutes, status, priority, vehicle_model')
      .eq('status', 'Đang trong xưởng'),
    supabase
      .from('reviews')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'Chưa xử lý'),
  ]);

  if (recentRes.error)   throw new Error(`getFullDailyReport recent: ${recentRes.error.message}`);
  if (workshopRes.error) throw new Error(`getFullDailyReport workshop: ${workshopRes.error.message}`);
  if (reviewRes.error)   logger.error('getFullDailyReport reviews query failed (non-blocking)', { error: reviewRes.error.message });

  const rows = mergeUnique([...(recentRes.data || []), ...(workshopRes.data || [])], 'vehicle_id');

  // Aggregate counters
  let totalIn = 0, totalOut = 0, inWorkshopCount = 0;
  let warningCount = 0, urgentCount = 0;
  let totalDuration = 0, completedCount = 0;
  let yesterdayIn = 0, yesterdayOut = 0, yesterdayTotalDuration = 0, yesterdayCompletedCount = 0;
  let fastestVehicle = null, slowestVehicle = null;
  const timeSlots = { sang: 0, chieu: 0, toi: 0, dem: 0 };

  // Vehicle detail lists
  const vehiclesOut    = [];  // ra hôm nay
  const vehiclesInToday = []; // vào hôm nay, chưa ra
  const inWorkshop     = [];  // tất cả đang trong xưởng

  for (const v of rows) {
    const timeIn  = v.time_in  ? DateTime.fromISO(v.time_in,  { zone }) : null;
    const timeOut = v.time_out ? DateTime.fromISO(v.time_out, { zone }) : null;
    const dur     = v.duration_minutes;
    const vehicle = {
      vehicleId: v.vehicle_id,
      plate:     v.plate,
      timeIn:    fmtTs(v.time_in, zone),
      timeOut:   fmtTs(v.time_out, zone),
      durationMinutes: dur,
      priority:  v.priority,
      status:    v.status,
      vehicleModel: v.vehicle_model || '',
    };

    // Today's entries
    if (timeIn && isSameDay(timeIn, now)) {
      totalIn++;
      const h = timeIn.hour;
      if (h >= 6 && h < 12)       timeSlots.sang++;
      else if (h >= 12 && h < 18) timeSlots.chieu++;
      else if (h >= 18)           timeSlots.toi++;
      else                        timeSlots.dem++;
    }

    // Yesterday's entries
    if (timeIn && isSameDay(timeIn, yesterday)) yesterdayIn++;

    // Today's exits
    if (timeOut && isSameDay(timeOut, now)) {
      totalOut++;
      vehiclesOut.push(vehicle);
      if (dur != null) {
        totalDuration += dur;
        completedCount++;
        if (!fastestVehicle || dur < fastestVehicle.durationMinutes) fastestVehicle = vehicle;
        if (!slowestVehicle || dur > slowestVehicle.durationMinutes) slowestVehicle = vehicle;
      }
    }

    // Yesterday's exits
    if (timeOut && isSameDay(timeOut, yesterday) && dur != null) {
      yesterdayOut++;
      yesterdayTotalDuration += dur;
      yesterdayCompletedCount++;
    }

    // In workshop
    if (v.status === 'Đang trong xưởng') {
      inWorkshopCount++;
      inWorkshop.push(vehicle);
      if (v.priority === 'Cảnh báo') warningCount++;
      if (v.priority === 'Khẩn')     urgentCount++;

      // Vào hôm nay nhưng chưa ra
      if (timeIn && isSameDay(timeIn, now)) vehiclesInToday.push(vehicle);
    }
  }

  return {
    today:     now.toFormat('dd/MM/yyyy'),
    yesterday: yesterday.toFormat('dd/MM/yyyy'),

    // Vehicle details
    vehiclesOut,
    vehiclesInToday,
    inWorkshop,

    // Summary (BAOCAO)
    totalIn,
    totalOut,
    inWorkshopCount,
    warningCount,
    urgentCount,
    pendingReview: reviewRes.count || 0,
    avgDuration:   completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,

    // Productivity (NANGSUAT)
    yesterdayIn,
    yesterdayOut,
    yesterdayAvgDuration: yesterdayCompletedCount > 0
      ? Math.round(yesterdayTotalDuration / yesterdayCompletedCount) : 0,
    completionRate: totalIn > 0 ? Math.round((totalOut / totalIn) * 100) : 0,
    completedCount,
    fastestVehicle,
    slowestVehicle,
    timeSlots,
  };
}

// ──────────────────────────────────────────────
// Intelligence queries (smart report)
// ──────────────────────────────────────────────

/**
 * Get weekly averages for the last N days.
 * @returns {{ avgDailyIn: number, avgDailyOut: number, avgDuration: number }}
 */
async function getWeeklyAverages(tz, days = 7) {
  const zone = tz || appTimezone;
  const since = DateTime.now().setZone(zone).minus({ days }).startOf('day').toISO();

  const { data, error } = await supabase
    .from('vehicles')
    .select('time_in, time_out, duration_minutes, status')
    .gte('time_in', since);

  if (error) {
    logger.error('getWeeklyAverages failed', { error: error.message });
    return { avgDailyIn: 0, avgDailyOut: 0, avgDuration: 0 };
  }

  const rows = data || [];
  const now = DateTime.now().setZone(zone);
  const dailyIn = new Map();
  const dailyOut = new Map();
  let totalDuration = 0;
  let completedCount = 0;

  for (const r of rows) {
    if (r.time_in) {
      const d = DateTime.fromISO(r.time_in, { zone }).toISODate();
      dailyIn.set(d, (dailyIn.get(d) || 0) + 1);
    }
    if (r.time_out) {
      const d = DateTime.fromISO(r.time_out, { zone }).toISODate();
      dailyOut.set(d, (dailyOut.get(d) || 0) + 1);
    }
    if (r.duration_minutes != null && r.time_out) {
      totalDuration += r.duration_minutes;
      completedCount++;
    }
  }

  const numDays = Math.max(dailyIn.size, 1);
  const totalIn = [...dailyIn.values()].reduce((a, b) => a + b, 0);
  const totalOut = [...dailyOut.values()].reduce((a, b) => a + b, 0);

  return {
    avgDailyIn: Math.round(totalIn / numDays),
    avgDailyOut: Math.round(totalOut / numDays),
    avgDuration: completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
  };
}

/**
 * Get vehicles approaching 24h/48h thresholds (for predictive alerts).
 * Returns in-workshop vehicles with computed hoursIn.
 */
async function getInWorkshopWithHours(tz) {
  const zone = tz || appTimezone;
  const { data, error } = await supabase
    .from('vehicles')
    .select('vehicle_id, plate, time_in, priority, status, vehicle_model')
    .eq('status', 'Đang trong xưởng');

  if (error) {
    logger.error('getInWorkshopWithHours failed', { error: error.message });
    return [];
  }

  const now = DateTime.now().setZone(zone);
  return (data || []).map(v => {
    const timeIn = v.time_in ? DateTime.fromISO(v.time_in, { zone }) : now;
    const hoursIn = now.diff(timeIn, 'hours').hours;
    return {
      vehicleId: v.vehicle_id,
      plate: v.plate,
      timeIn: fmtTs(v.time_in, zone),
      timeInISO: v.time_in,
      priority: v.priority,
      hoursIn: Math.round(hoursIn * 10) / 10,
      vehicleModel: v.vehicle_model || '',
    };
  });
}

/**
 * Detect plates that visited multiple times in the last N days.
 */
async function getRepeatVisitors(tz, windowDays = 14) {
  const zone = tz || appTimezone;
  const since = DateTime.now().setZone(zone).minus({ days: windowDays }).startOf('day').toISO();

  const { data, error } = await supabase
    .from('vehicles')
    .select('plate, time_in, time_out')
    .gte('time_in', since)
    .order('time_in', { ascending: false });

  if (error) {
    logger.error('getRepeatVisitors failed', { error: error.message });
    return [];
  }

  return (data || []).map(v => ({
    plate: v.plate,
    timeIn: fmtTs(v.time_in, zone),
    timeOut: fmtTs(v.time_out, zone),
  }));
}

/**
 * Get duration statistics (percentiles) from completed vehicles.
 */
async function getDurationStats(tz, days = 30) {
  const zone = tz || appTimezone;
  const since = DateTime.now().setZone(zone).minus({ days }).startOf('day').toISO();

  const { data, error } = await supabase
    .from('vehicles')
    .select('duration_minutes')
    .gte('time_in', since)
    .not('duration_minutes', 'is', null)
    .not('time_out', 'is', null)
    .order('duration_minutes', { ascending: true });

  if (error) {
    logger.error('getDurationStats failed', { error: error.message });
    return { p50: 0, p75: 0, p90: 0, count: 0 };
  }

  const durations = (data || []).map(r => r.duration_minutes);
  if (durations.length === 0) return { p50: 0, p75: 0, p90: 0, count: 0 };

  const p = (arr, pct) => {
    const idx = Math.ceil((pct / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
  };

  return {
    p50: p(durations, 50),
    p75: p(durations, 75),
    p90: p(durations, 90),
    count: durations.length,
  };
}

/**
 * Get pending OCR reviews (detailed).
 */
async function getPendingReviews() {
  const { data, error } = await supabase
    .from('reviews')
    .select('error_id, plate_ai, reason, timestamp')
    .eq('review_status', 'Chưa xử lý')
    .order('timestamp', { ascending: false })
    .limit(20);

  if (error) {
    logger.error('getPendingReviews failed', { error: error.message });
    return { count: 0, items: [] };
  }

  const items = (data || []).map(r => ({
    plate: r.plate_ai,
    reason: r.reason,
  }));

  return { count: items.length, items };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function isSameDay(dt1, dt2) {
  return dt1.hasSame(dt2, 'day');
}

function mergeUnique(rows, key) {
  const seen = new Set();
  const out  = [];
  for (const r of rows) {
    if (!seen.has(r[key])) {
      seen.add(r[key]);
      out.push(r);
    }
  }
  return out;
}

/**
 * Format a TIMESTAMPTZ string to dd/MM/yyyy HH:mm:ss in the given timezone.
 * Matches the string format expected by utils.hoursSince() and utils.calcMinutesBetween().
 */
function fmtTs(ts, zone) {
  if (!ts) return '';
  return DateTime.fromISO(ts, { zone }).toFormat('dd/MM/yyyy HH:mm:ss');
}

module.exports = {
  initDb,
  processVehicleDecision,
  insertEvent,
  updateEventResult,
  insertReview,
  isMessageProcessed,
  getAllInWorkshop,
  updateVehiclePriority,
  getDailySummary,
  getProductivityData,
  getAllMainRows,
  getFullDailyReport,
  testConnection,
  forceExitByPlate,
  expireStaleVehicles,
  autoCloseVehicles,
  forceExitVehicle,
  countInWorkshop,
  // Intelligence queries (smart report)
  getWeeklyAverages,
  getInWorkshopWithHours,
  getRepeatVisitors,
  getDurationStats,
  getPendingReviews,
  // Dashboard queries
  getTodayActivity,
  getYesterdayActivity,
};
