'use strict';

const { DateTime } = require('luxon');
const crypto = require('crypto');

// ──────────────────────────────────────────────
// ID Generation
// ──────────────────────────────────────────────

// Keep IDs opaque to consumers. A 128-bit suffix avoids the collision-prone
// 16-bit space when several IDs are created in the same timestamp second.
/** Ma luot xe: LX-YYMMDDHHmmss-<32 hex characters> */
function generateVehicleId(tz) {
  const ts = DateTime.now().setZone(tz).toFormat('yyMMddHHmmss');
  const rand = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `LX-${ts}-${rand}`;
}

/** Ma su kien: SK-YYMMDDHHmmss-<32 hex characters> */
function generateEventId(tz) {
  const ts = DateTime.now().setZone(tz).toFormat('yyMMddHHmmss');
  const rand = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `SK-${ts}-${rand}`;
}

/** Ma loi: ERR-YYMMDDHHmmss-<32 hex characters> */
function generateErrorId(tz) {
  const ts = DateTime.now().setZone(tz).toFormat('yyMMddHHmmss');
  const rand = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `ERR-${ts}-${rand}`;
}

// ──────────────────────────────────────────────
// Time Formatting
// ──────────────────────────────────────────────

/** Tra ve chuoi datetime: "12/02/2026 14:30:05" */
function nowFormatted(tz) {
  return DateTime.now().setZone(tz).toFormat('dd/MM/yyyy HH:mm:ss');
}

/** Tinh so phut giua 2 chuoi datetime (cung format dd/MM/yyyy HH:mm:ss) */
function calcMinutesBetween(startStr, endStr) {
  const fmt = 'dd/MM/yyyy HH:mm:ss';
  const start = DateTime.fromFormat(startStr, fmt);
  const end = DateTime.fromFormat(endStr, fmt);
  if (!start.isValid || !end.isValid) return '';
  return Math.round(end.diff(start, 'minutes').minutes);
}

/** Tinh so gio tu 1 chuoi datetime den bay gio */
function hoursSince(startStr, tz) {
  const fmt = 'dd/MM/yyyy HH:mm:ss';
  const start = DateTime.fromFormat(startStr, fmt, { zone: tz });
  if (!start.isValid) return 0;
  return DateTime.now().setZone(tz).diff(start, 'hours').hours;
}

/** Format so gio (float) thanh "Xh Yp", xu ly 60p → +1h */
function formatHours(hours) {
  let h = Math.floor(hours);
  let m = Math.round((hours % 1) * 60);
  if (m >= 60) { h += 1; m = 0; }
  return `${h}h${m}p`;
}

/** Format so phut thanh chuoi "X gio Y phut" */
function formatDuration(minutes) {
  if (!minutes && minutes !== 0) return '';
  const m = parseInt(minutes, 10);
  if (isNaN(m)) return '';
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  if (hours > 0) return `${hours} gio ${mins} phut`;
  return `${mins} phut`;
}

// ──────────────────────────────────────────────
// Plate Normalization
// ──────────────────────────────────────────────

/**
 * Chuan hoa bien so xe Viet Nam.
 * VD: "30a 123.45" -> "30A-12345"
 */
function normalizePlate(raw) {
  if (!raw) return '';
  let plate = raw.toUpperCase().trim();
  plate = plate.replace(/[^A-Z0-9]/g, '');
  const match1 = plate.match(/^(\d{2,3})([A-Z])(\d{3,5})$/);
  const match2 = plate.match(/^(\d{2,3})([A-Z][A-Z0-9])(\d{4,5})$/);
  const match = match1 || match2;
  if (match) {
    plate = `${match[1]}${match[2]}-${match[3]}`;
  }
  return plate;
}

/**
 * Regex validation bien so Viet Nam (tolerant).
 */
function isValidVietnamPlate(plate) {
  if (!plate) return false;
  return /^\d{2,3}[A-Z][A-Z0-9]?-?\d{3,5}$/.test(plate);
}

// ──────────────────────────────────────────────
// Message Parsing
// ──────────────────────────────────────────────

/**
 * Cac lenh text-only (khong can anh).
 */
const TEXT_ONLY_ACTIONS = ['TONKHO', 'HELP', 'BAOCAO', 'NANGSUAT', 'RA_MANUAL'];

/**
 * Parse text tin nhan.
 * Nhan dang: TONKHO, HELP, BAOCAO, NANGSUAT, RA <bien so>.
 */
function parseMessage(text) {
  if (!text) return { action: null, params: '' };

  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  // RA <biển số> — manual exit
  const raMatch = normalized.match(/^RA\s+(.+)$/);
  if (raMatch) {
    const plate = normalizePlate(raMatch[1]);
    if (plate) return { action: 'RA_MANUAL', params: plate };
  }

  let action = null;

  if (/^(TONKHO|TON KHO)$/.test(normalized)) {
    action = 'TONKHO';
  } else if (/^(HELP|HUONGDAN|HUONG DAN)$/.test(normalized)) {
    action = 'HELP';
  } else if (/^(BAOCAO|BAO CAO)$/.test(normalized)) {
    action = 'BAOCAO';
  } else if (/^(NANGSUAT|NANG SUAT)$/.test(normalized)) {
    action = 'NANGSUAT';
  }

  return { action, params: '' };
}

/**
 * Parse evening sweep reply (vehicle indices the security guard reports as exited).
 *
 * Strict format: text must contain only digits, spaces, commas, dots, semicolons.
 * Examples that match: "1 3 5", "1,3,5", "1, 3, 5", "135" → [1,3,5] / [135]
 * Examples that DO NOT match: "30A-12345" (letters), "ra 1 3" (letters), "" (empty)
 *
 * Returns array of unique positive integers, or null if not a sweep reply format.
 */
function parseSweepReply(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Only digits and common separators allowed
  if (!/^[\d\s,;.]+$/.test(trimmed)) return null;
  const matches = trimmed.match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  // Dedup, parse, drop zeros
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.length > 0 ? out : null;
}

// ──────────────────────────────────────────────
// Report formatting helpers
// ──────────────────────────────────────────────

/**
 * Format xe đã hoàn thành (có giờ ra).
 * "30A-12345 — 08:15 → 14:30 (6h15p)"
 */
function formatVehicleCompleted(v, tz) {
  const tIn  = extractTime(v.timeIn);
  const tOut = extractTime(v.timeOut);
  const dur  = v.durationMinutes != null ? ` (${formatHours(v.durationMinutes / 60)})` : '';
  return `${v.plate} — ${tIn} → ${tOut}${dur}`;
}

/**
 * Format xe đang trong xưởng.
 * "🚨 51F-45678 (VF 8) — Vào 16/03 08:15 (96h)"
 */
function formatVehicleInProgress(v, tz) {
  const hours = hoursSince(v.timeIn, tz);
  const icon  = v.priority === 'Khẩn' ? '🚨' : v.priority === 'Cảnh báo' ? '⚠️' : '🔧';
  const dateTime = extractDateTimeShort(v.timeIn, tz);
  const modelStr = v.vehicleModel ? ` (${v.vehicleModel})` : '';
  return `${icon} ${v.plate}${modelStr} — Vào ${dateTime} (${formatHours(hours)})`;
}

/**
 * Trich xuat HH:mm tu chuoi "dd/MM/yyyy HH:mm:ss".
 */
function extractTime(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/\d{2}\/\d{2}\/\d{4} (\d{2}:\d{2})/);
  return match ? match[1] : dateStr;
}

/**
 * Trich xuat "dd/MM HH:mm" tu chuoi "dd/MM/yyyy HH:mm:ss".
 * Neu cung ngay hom nay thi chi hien HH:mm.
 */
function extractDateTimeShort(dateStr, tz) {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{2})\/(\d{2})\/\d{4} (\d{2}:\d{2})/);
  if (!match) return dateStr;
  const now = DateTime.now().setZone(tz || 'Asia/Ho_Chi_Minh');
  const day = match[1], month = match[2], time = match[3];
  if (parseInt(day) === now.day && parseInt(month) === now.month) return time;
  return `${day}/${month} ${time}`;
}

/**
 * Split report sections into multiple messages respecting Telegram 4000 char limit.
 * Never splits in the middle of a section.
 */
function splitIntoMessages(parts, maxLen = 4000) {
  const messages = [];
  let current = '';
  for (const part of parts) {
    if (current.length + part.length + 2 > maxLen) {
      if (current) messages.push(current.trim());
      current = part;
    } else {
      current += (current ? '\n\n' : '') + part;
    }
  }
  if (current) messages.push(current.trim());
  return messages;
}

// ──────────────────────────────────────────────
// Confidence mapping
// ──────────────────────────────────────────────

function confidenceLabel(confidence, thresholds) {
  if (confidence >= thresholds.confidenceHigh) return 'Ro';
  if (confidence >= thresholds.confidenceMedium) return 'Tam duoc';
  return 'Mo / khong chac';
}

// ──────────────────────────────────────────────
// Smart report formatters
// ──────────────────────────────────────────────

const intel = require('./report-intelligence');

/**
 * Format KPI dashboard (section 1 of evening report).
 */
function formatKPIDashboard({ data, weeklyAvg, capacityForecast }) {
  const avgStr = data.avgDuration > 0 ? formatDuration(data.avgDuration) : 'N/A';
  const fastStr = data.fastestVehicle ? formatHours(data.fastestVehicle.durationMinutes / 60) : 'N/A';
  const slowStr = data.slowestVehicle ? formatHours(data.slowestVehicle.durationMinutes / 60) : 'N/A';

  let s = `📊 BÁO CÁO CUỐI NGÀY — ${data.today}`;
  s += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n\n🔢 TỔNG QUAN`;
  s += `\n    Tồn kho: ${data.inWorkshopCount}/${capacityForecast.available + data.inWorkshopCount} │ Vào: ${data.totalIn} │ Ra: ${data.totalOut} │ Hoàn thành: ${data.completionRate}%`;
  s += `\n    TB thời gian: ${avgStr} │ Nhanh nhất: ${fastStr} │ Chậm nhất: ${slowStr}`;

  // vs yesterday
  const diffIn = data.totalIn - data.yesterdayIn;
  const diffOut = data.totalOut - data.yesterdayOut;
  const arrowIn  = diffIn > 0 ? `+${diffIn}↑` : diffIn < 0 ? `${diffIn}↓` : '→';
  const arrowOut = diffOut > 0 ? `+${diffOut}↑` : diffOut < 0 ? `${diffOut}↓` : '→';
  s += `\n\n    So hôm qua:  Vào ${arrowIn} │ Ra ${arrowOut}`;

  // vs 7-day avg
  if (weeklyAvg.avgDailyIn > 0) {
    const trend = intel.compareToBaseline(data.totalIn, weeklyAvg.avgDailyIn);
    if (Math.abs(trend.pctChange) <= 15) {
      s += `\n    So 7 ngày:   ✅ Bình thường (${trend.label})`;
    } else if (trend.pctChange > 0) {
      s += `\n    So 7 ngày:   ↑ Nhiều hơn ${Math.abs(trend.pctChange)}%`;
    } else {
      s += `\n    So 7 ngày:   ↓ Ít hơn ${Math.abs(trend.pctChange)}%`;
    }
  }

  // Capacity
  s += `\n\n    Capacity:    ${data.inWorkshopCount}/${capacityForecast.available + data.inWorkshopCount} (${capacityForecast.utilizationPct}%) → ${capacityForecast.recommendation}`;

  return s;
}

/**
 * Format action-required section (section 2).
 */
function formatActionRequired(urgentVehicles, warningVehicles, tz) {
  if (urgentVehicles.length === 0 && warningVehicles.length === 0) {
    return null;
  }

  let stt = 1;
  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n🚨 CẦN HÀNH ĐỘNG NGAY (${urgentVehicles.length + warningVehicles.length} xe)`;

  if (urgentVehicles.length > 0) {
    s += `\n\n    Khẩn >48h (${urgentVehicles.length} xe) — cần quyết định:`;
    for (const v of urgentVehicles) {
      const dateTime = extractDateTimeShort(v.timeIn, tz);
      s += `\n      ${stt++}. 🚨 ${v.plate} — ${formatHours(v.hoursIn)}h (Vào ${dateTime})`;
      s += `\n         👉 Liên hệ khách hoặc quyết định giữ/trả`;
    }
  }

  if (warningVehicles.length > 0) {
    s += `\n\n    Cảnh báo >24h (${warningVehicles.length} xe) — cần theo dõi:`;
    for (const v of warningVehicles) {
      const dateTime = extractDateTimeShort(v.timeIn, tz);
      s += `\n      ${stt++}. ⚠️ ${v.plate} — ${formatHours(v.hoursIn)} (Vào ${dateTime})`;
    }
  }

  return s;
}

/**
 * Format predictive alerts (section 3).
 */
function formatPredictiveAlerts(predictions, tz) {
  const { approaching24h, approaching48h } = predictions;
  if (approaching24h.length === 0 && approaching48h.length === 0) return null;

  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n⏰ SẮP CHẠM NGƯỠNG (12h tới)`;

  if (approaching24h.length > 0) {
    s += `\n\n    Chạm 24h: ${approaching24h.length} xe`;
    for (const v of approaching24h) {
      const eta = computeThresholdTime(v.timeIn, 24, tz);
      s += `\n      • ${v.plate} — ${formatHours(v.hoursIn)} → chạm lúc ${eta}`;
    }
  }

  if (approaching48h.length > 0) {
    s += `\n\n    Chạm 48h: ${approaching48h.length} xe`;
    for (const v of approaching48h) {
      const eta = computeThresholdTime(v.timeIn, 48, tz);
      s += `\n      • ${v.plate} — ${formatHours(v.hoursIn)} → chạm lúc ${eta}`;
    }
  }

  return s;
}

/**
 * Format today's entries with time buckets + exception highlighting (section 4).
 */
function formatTodayEntries(vehiclesInToday, vehiclesOut, durationStats, tz) {
  const totalToday = vehiclesInToday.length + vehiclesOut.filter(v => {
    // count vehicles that entered today and already exited
    return true; // we count from data.totalIn instead
  }).length;

  if (vehiclesInToday.length === 0) return null;

  // Split into morning/afternoon
  const morning = [];
  const afternoon = [];
  for (const v of vehiclesInToday) {
    const h = extractHour(v.timeIn);
    if (h < 12) morning.push(v);
    else afternoon.push(v);
  }

  // Find slow vehicles (exceeding p90 or > durationSlowHours)
  const p90Hours = durationStats.p90 > 0 ? durationStats.p90 / 60 : 8;
  const slowVehicles = vehiclesInToday.filter(v => {
    const hours = hoursSince(v.timeIn, tz);
    return hours > p90Hours;
  });

  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n📥 VÀO HÔM NAY, CHƯA RA (${vehiclesInToday.length} xe)`;

  if (morning.length > 0) {
    s += `\n\n    🌅 Sáng 6-12h: ${morning.length} xe`;
  }
  if (afternoon.length > 0) {
    s += `\n    ☀️ Chiều 12-18h: ${afternoon.length} xe`;
  }

  if (slowVehicles.length > 0) {
    const avgHoursStr = p90Hours > 0 ? formatHours(p90Hours) : 'N/A';
    s += `\n\n    ⚠️ Chậm hơn bình thường (${slowVehicles.length} xe):`;
    for (const v of slowVehicles.slice(0, 5)) {
      const hours = hoursSince(v.timeIn, tz);
      const dateTime = extractTime(v.timeIn);
      s += `\n      • 🟠 ${v.plate} — Vào ${dateTime} (${formatHours(hours)}) — TB là ${avgHoursStr}`;
    }
    if (slowVehicles.length > 5) {
      s += `\n      ... và ${slowVehicles.length - 5} xe nữa`;
    }
  }

  const normalCount = vehiclesInToday.length - slowVehicles.length;
  if (normalCount > 0) {
    s += `\n\n    Còn lại ${normalCount} xe đang sửa — tiến độ bình thường 🟢`;
  }

  return s;
}

/**
 * Format completed vehicles with buckets + progress bars (section 5).
 */
function formatCompletedSection(vehiclesOut, durationStats, weeklyAvg, tz) {
  if (vehiclesOut.length === 0) return null;

  const thresholds = { fast: 3, normal: 5, slow: 8 };
  const buckets = intel.bucketCompletedVehicles(vehiclesOut, thresholds);
  const total = vehiclesOut.length;

  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n✅ ĐÃ RA HÔM NAY (${total} xe) — phân bố tốc độ`;

  s += `\n\n    🟢 Nhanh (<3h):    ${String(buckets.fast.length).padStart(2)} xe ${intel.buildProgressBar(buckets.fast.length, total)}`;
  s += `\n    🟡 TB (3-5h):      ${String(buckets.normal.length).padStart(2)} xe ${intel.buildProgressBar(buckets.normal.length, total)}`;
  s += `\n    🟠 Chậm (5-8h):    ${String(buckets.slow.length).padStart(2)} xe ${intel.buildProgressBar(buckets.slow.length, total)}`;
  s += `\n    🔴 Rất chậm (>8h): ${String(buckets.critical.length).padStart(2)} xe ${intel.buildProgressBar(buckets.critical.length, total)}`;

  // fastest/slowest
  const sorted = [...vehiclesOut].filter(v => v.durationMinutes != null).sort((a, b) => a.durationMinutes - b.durationMinutes);
  if (sorted.length > 0) {
    const fastest = sorted[0];
    const slowest = sorted[sorted.length - 1];
    s += `\n\n    Nhanh nhất: 🟢 ${fastest.plate} — ${formatHours(fastest.durationMinutes / 60)}`;
    s += `\n    Chậm nhất:  🔴 ${slowest.plate} — ${formatHours(slowest.durationMinutes / 60)}`;
  }

  // average comparison
  const todayAvg = vehiclesOut.reduce((sum, v) => sum + (v.durationMinutes || 0), 0) / (total || 1);
  const todayAvgStr = formatHours(todayAvg / 60);
  const weekAvgStr = weeklyAvg.avgDuration > 0 ? formatHours(weeklyAvg.avgDuration / 60) : 'N/A';
  s += `\n    TB hôm nay: ${todayAvgStr} │ TB 7 ngày: ${weekAvgStr}`;

  // list critical vehicles (>8h)
  if (buckets.critical.length > 0) {
    s += `\n\n    🔴 Xe chậm nhất (>8h) — kiểm tra nguyên nhân:`;
    const critSorted = [...buckets.critical].sort((a, b) => (b.durationMinutes || 0) - (a.durationMinutes || 0));
    for (const v of critSorted.slice(0, 5)) {
      const tIn = extractTime(v.timeIn);
      const tOut = extractTime(v.timeOut);
      s += `\n      • ${v.plate} — ${formatHours(v.durationMinutes / 60)} (${tIn}→${tOut})`;
    }
  }

  return s;
}

/**
 * Format special attention section (section 6).
 */
function formatSpecialAttention(repeats, anomalies, tz) {
  if (repeats.length === 0 && anomalies.length === 0) return null;

  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n🔄 CHÚ Ý ĐẶC BIỆT`;

  if (repeats.length > 0) {
    s += `\n\n    Xe quay lại (14 ngày):`;
    for (const r of repeats.slice(0, 3)) {
      s += `\n      🔄 ${r.plate} — lần ${r.visitCount} trong 2 tuần`;
      s += `\n         ← Kiểm tra chất lượng sửa chữa lần trước`;
    }
  }

  if (anomalies.length > 0) {
    s += `\n\n    Xe bất thường (lâu hơn 90% xe khác):`;
    for (const a of anomalies.slice(0, 3)) {
      s += `\n      📊 ${a.plate} — ${formatHours(a.actual)} (p90 = ${formatHours(a.expectedMax / 60)})`;
      s += `\n         ← Có gì block? Thiếu phụ tùng?`;
    }
  }

  return s;
}

/**
 * Format end-of-day checklist (section 7).
 */
function formatChecklist(items) {
  let s = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  s += `\n📋 CHECKLIST CUỐI NGÀY`;
  for (const item of items) {
    s += `\n    ☐ ${item.text}`;
  }
  return s;
}

/**
 * Format morning briefing message.
 */
function formatMorningBriefing({ today, inWorkshopCount, urgentCount, warningCount, normalCount, capacityForecast, approaching24h, approaching48h, priorities }) {
  let s = `☀️ SÁNG NAY — ${today}`;
  s += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  // Tồn kho
  s += `\n\n🔢 TỒN KHO: ${inWorkshopCount} xe (capacity ${capacityForecast.available + inWorkshopCount} — còn ${capacityForecast.available} chỗ ${capacityForecast.utilizationPct < 70 ? '✅' : '⚠️'})`;
  if (urgentCount > 0) s += `\n   🚨 Khẩn >48h: ${urgentCount} xe → CẦN XỬ LÝ HÔM NAY`;
  if (warningCount > 0) s += `\n   ⚠️ >24h: ${warningCount} xe`;
  s += `\n   🔧 Bình thường: ${normalCount} xe`;

  // Sắp chạm ngưỡng
  if (approaching24h.length > 0 || approaching48h.length > 0) {
    s += `\n\n⏰ SẮP CHẠM NGƯỠNG:`;
    if (approaching24h.length > 0) s += `\n   Chạm 24h hôm nay: ${approaching24h.length} xe`;
    if (approaching48h.length > 0) {
      s += `\n   Chạm 48h hôm nay: ${approaching48h.length} xe`;
      for (const v of approaching48h.slice(0, 3)) {
        const eta = computeThresholdTime(v.timeIn, 48, 'Asia/Ho_Chi_Minh');
        s += `\n   • ${v.plate} — chạm 48h lúc ${eta} (còn ${formatHours(v.hoursUntil)}) ← GẤP`;
      }
    }
  }

  // Ưu tiên
  if (priorities.length > 0) {
    s += `\n\n📋 ƯU TIÊN:`;
    for (const p of priorities) {
      s += `\n   ${p.rank}. ${p.text}`;
    }
  }

  return s;
}

// ──────────────────────────────────────────────
// Internal helpers for smart formatters
// ──────────────────────────────────────────────

/**
 * Compute when a vehicle will hit a threshold.
 * @returns {string} "HH:mm" in local tz
 */
function computeThresholdTime(timeInStr, thresholdHours, tz) {
  const fmt = 'dd/MM/yyyy HH:mm:ss';
  const timeIn = DateTime.fromFormat(timeInStr, fmt, { zone: tz });
  if (!timeIn.isValid) return '??:??';
  const thresholdTime = timeIn.plus({ hours: thresholdHours });
  return thresholdTime.toFormat('HH:mm');
}

/**
 * Extract hour (0-23) from formatted datetime string.
 */
function extractHour(dateStr) {
  if (!dateStr) return 12;
  const match = dateStr.match(/(\d{2}):\d{2}:\d{2}$/);
  return match ? parseInt(match[1], 10) : 12;
}

// ──────────────────────────────────────────────
// Fuzzy Plate Matching
// ──────────────────────────────────────────────

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

/**
 * Find a similar plate from existingPlates if the OCR'd plate is off by 1-2 chars.
 * Returns the best match if edit distance <= 2 AND unambiguous (only 1 close match).
 * Returns null if no match or ambiguous.
 */
function findSimilarPlate(plate, existingPlates) {
  if (!plate || existingPlates.length === 0) return null;
  const matches = existingPlates
    .map(p => ({ plate: p, dist: levenshtein(plate, p) }))
    .filter(m => m.dist > 0 && m.dist <= 2)
    .sort((a, b) => a.dist - b.dist);
  if (matches.length === 1) return matches[0].plate;
  if (matches.length > 1 && matches[0].dist < matches[1].dist) return matches[0].plate;
  return null;
}

module.exports = {
  generateVehicleId,
  generateEventId,
  generateErrorId,
  nowFormatted,
  calcMinutesBetween,
  hoursSince,
  formatHours,
  formatDuration,
  normalizePlate,
  isValidVietnamPlate,
  parseMessage,
  parseSweepReply,
  confidenceLabel,
  TEXT_ONLY_ACTIONS,
  formatVehicleCompleted,
  formatVehicleInProgress,
  splitIntoMessages,
  extractTime,
  extractDateTimeShort,
  // Smart report formatters
  formatKPIDashboard,
  formatActionRequired,
  formatPredictiveAlerts,
  formatTodayEntries,
  formatCompletedSection,
  formatSpecialAttention,
  formatChecklist,
  formatMorningBriefing,
  computeThresholdTime,
  levenshtein,
  findSimilarPlate,
};
