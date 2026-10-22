'use strict';

const { DateTime } = require('luxon');
const db         = require('./db');
const sheetsSync = require('./sheets-sync');
const utils      = require('./utils');
const intel      = require('./report-intelligence');
const { buildDailyExcelReport } = require('./excel-report');
const logger     = require('./logger');

/**
 * Xu ly 1 su kien xe vao/ra.
 *
 * The DB's process_vehicle() RPC takes a transaction lock for the plate before
 * its active-row lookup (migration 003). This also covers concurrent first
 * entries; SELECT FOR UPDATE alone cannot lock an absent row.
 */
async function processVehicleEvent(event, config) {
  const tz  = config.timezone;
  const now = utils.nowFormatted(tz);       // dd/MM/yyyy HH:mm:ss  (for display + Sheets)
  const nowIso = new Date().toISOString();  // UTC ISO               (for DB)

  const eventId   = utils.generateEventId(tz);
  const vehicleId = utils.generateVehicleId(tz);

  const { messageId, senderId, senderName, imageUrl, ocrResult } = event;
  let plate          = ocrResult.plateText;
  const confidence   = ocrResult.confidence;
  const vehicleModel = ocrResult.vehicleModel || '';
  const confLabel    = utils.confidenceLabel(confidence, config.ocr);
  const messageKey = `[MSG_ID:${messageId}]`;

  // ── Step 1: Always record in NHẬT KÝ first ──────────────────────────────
  await db.insertEvent({
    eventId,
    timestamp:        nowIso,
    recordType:       'Chưa xác định',
    plateAI:          plate,
    confidenceLabel:  confLabel,
    imageUrl,
    sender:           senderName || senderId,
    messageKey,
    result:           '',
  });

  // Mirror to Sheets asynchronously (fire-and-forget)
  sheetsSync.syncLogInsert({
    eventId,
    timestamp:        now,   // Sheets stores formatted string
    recordType:       'Chưa xác định',
    plateAI:          plate,
    confidenceLabel:  confLabel,
    imageUrl,
    sender:           senderName || senderId,
    originalMessage:  messageKey,
    result:           '',
  });

  // ── Step 2: Validate OCR result ─────────────────────────────────────────

  if (!plate) {
    const errorId = utils.generateErrorId(tz);
    await db.insertReview({
      errorId, eventId, timestamp: nowIso, imageUrl, plateAI: '',
      reason:       'Anh mo / khong thay bien so',
      suggestion:   'Chup lai anh',
      reviewStatus: 'Chưa xử lý',
    });
    await db.updateEventResult(eventId, 'Khong doc duoc bien so');
    sheetsSync.syncReviewInsert({ errorId, eventId, timestamp: now, imageUrl, plateAI: '', reason: 'Anh mo / khong thay bien so', suggestion: 'Chup lai anh', reviewStatus: 'Chưa xử lý' });
    sheetsSync.syncLogResult(eventId, 'Khong doc duoc bien so');

    return {
      success: false,
      replyMessage: 'Xin lỗi, không đọc được biển số trong ảnh.\nVui lòng chụp lại rõ hơn, chụp thẳng vào biển số nhé.',
      eventId,
    };
  }

  if (confidence < config.ocr.confidenceMedium) {
    const errorId = utils.generateErrorId(tz);
    await db.insertReview({
      errorId, eventId, timestamp: nowIso, imageUrl, plateAI: plate,
      reason:       'OCR doc khong chac',
      suggestion:   'Chup lai anh',
      reviewStatus: 'Chưa xử lý',
    });
    await db.updateEventResult(eventId, 'OCR mo - chuyen kiem tra');
    sheetsSync.syncReviewInsert({ errorId, eventId, timestamp: now, imageUrl, plateAI: plate, reason: 'OCR doc khong chac', suggestion: 'Chup lai anh', reviewStatus: 'Chưa xử lý' });
    sheetsSync.syncLogResult(eventId, 'OCR mo - chuyen kiem tra');

    return {
      success: false,
      replyMessage: `Xin lỗi, đọc biển số chưa chắc chắn: ${plate}\nVui lòng chụp lại ảnh rõ hơn nhé.`,
      eventId,
    };
  }

  if (!utils.isValidVietnamPlate(plate)) {
    const errorId = utils.generateErrorId(tz);
    await db.insertReview({
      errorId, eventId, timestamp: nowIso, imageUrl, plateAI: plate,
      reason:       'Bien so khong dung dinh dang',
      suggestion:   'Chup lai anh',
      reviewStatus: 'Chưa xử lý',
    });
    await db.updateEventResult(eventId, 'Bien so sai format');
    sheetsSync.syncReviewInsert({ errorId, eventId, timestamp: now, imageUrl, plateAI: plate, reason: 'Bien so khong dung dinh dang', suggestion: 'Chup lai anh', reviewStatus: 'Chưa xử lý' });
    sheetsSync.syncLogResult(eventId, 'Bien so sai format');

    return {
      success: false,
      replyMessage: `Xin lỗi, biển số đọc được (${plate}) không đúng định dạng.\nVui lòng chụp lại ảnh rõ hơn nhé.`,
      eventId,
    };
  }

  // ── Step 2b: Fuzzy plate matching ──────────────────────────────────────────
  // If this plate isn't in the workshop but a similar one is, use the similar one.
  const workshopVehicles = await db.getAllInWorkshop(tz);
  const workshopPlates = workshopVehicles.map(v => v.plate);
  if (!workshopPlates.includes(plate)) {
    const similarPlate = utils.findSimilarPlate(plate, workshopPlates);
    if (similarPlate) {
      logger.info('Fuzzy plate match applied', { original: plate, matched: similarPlate });
      plate = similarPlate;
    }
  }

  // ── Step 3: VAO/RA decision (PostgreSQL RPC with a per-plate transaction lock) ─

  const minWorkshopSecs = config.alerts.minWorkshopMinutes * 60;
  let decision;
  try {
    decision = await db.processVehicleDecision(plate, vehicleId, nowIso, imageUrl, minWorkshopSecs, vehicleModel);
  } catch (err) {
    logger.error('processVehicleDecision RPC failed', { eventId, plate, error: err.message });

    // Best-effort: mark event as error state.
    // If this write also fails (e.g. DB is down), log it and continue —
    // never let a secondary failure suppress the guard-facing retry reply.
    try {
      await db.updateEventResult(eventId, 'Loi he thong - RPC that bai');
    } catch (writeErr) {
      logger.error('updateEventResult failed during RPC error path', {
        eventId, plate, error: writeErr.message,
      });
    }

    // Fire-and-forget — already handles its own errors internally via fire()
    sheetsSync.syncLogResult(eventId, 'Loi he thong - RPC that bai');

    return {
      success: false,
      replyMessage: `⚠️ Xin lỗi, hệ thống gặp lỗi khi xử lý xe ${plate}.\nVui lòng gửi lại ảnh để thử lại nhé.`,
      eventId,
    };
  }

  if (decision.action === 'VAO') {
    await db.updateEventResult(eventId, 'Da ghi VAO danh sach');
    sheetsSync.syncLogResult(eventId, 'Da ghi VAO danh sach');
    sheetsSync.syncVehicleIn({
      vehicleId: decision.vehicle_id,
      plate,
      vehicleModel,
      timeIn:    now,
      timeOut:   '',
      duration:  '',
      imageIn:   imageUrl,
      imageOut:  '',
      status:    'Đang trong xưởng',
      priority:  'Bình thường',
      note:      '',
      updatedAt: now,
    });
    sheetsSync.syncDashboard(config);

    logger.info('Vehicle IN processed', { vehicleId: decision.vehicle_id, plate });
    let replyMsg = `Cảm ơn! ✅ Đã ghi nhận xe VÀO xưởng\nBiển số: ${plate}`;
    if (vehicleModel) replyMsg += `\nLoại xe: ${vehicleModel}`;
    replyMsg += `\nLúc: ${now}\nMã lượt: ${decision.vehicle_id}`;
    return {
      success: true,
      replyMessage: replyMsg,
      eventId,
    };
  }

  if (decision.action === 'RA_DUPLICATE') {
    await db.updateEventResult(eventId, 'Chua du thoi gian - bo qua RA');
    sheetsSync.syncLogResult(eventId, 'Chua du thoi gian - bo qua RA');

    logger.info('RA rejected - vehicle just entered', {
      plate, secondsInWorkshop: Math.round(decision.seconds_in),
      minWorkshopMinutes: config.alerts.minWorkshopMinutes,
    });
    return {
      success: false,
      replyMessage: `✅ Đã nhận ảnh xe ${plate}. Xe đang được theo dõi trong xưởng.`,
      eventId,
    };
  }

  // RA — update is already committed in the RPC
  const duration    = Math.round(decision.seconds_in / 60);
  const durationStr = utils.formatDuration(duration);

  await db.updateEventResult(eventId, 'Da ghep cap thanh cong');
  sheetsSync.syncLogResult(eventId, 'Da ghep cap thanh cong');
  sheetsSync.syncVehicleOut(plate, decision.vehicle_id, {
    timeOut:   now,
    duration:  String(duration),
    imageOut:  imageUrl,
    status:    'Đã ra xưởng',
    priority:  'Bình thường',
    updatedAt: now,
  });
  sheetsSync.syncDashboard(config);

  logger.info('Vehicle OUT processed', { vehicleId: decision.vehicle_id, plate, duration });
  let replyMsgOut = `Cảm ơn! 🏁 Đã ghi nhận xe RA xưởng\nBiển số: ${plate}`;
  if (vehicleModel) replyMsgOut += `\nLoại xe: ${vehicleModel}`;
  replyMsgOut += `\nLúc: ${now}\nThời gian lưu: ${durationStr}\nMã lượt: ${decision.vehicle_id}`;
  return {
    success: true,
    replyMessage: replyMsgOut,
    eventId,
  };
}

// ──────────────────────────────────────────────
// TONKHO - Xem xe dang trong xuong
// ──────────────────────────────────────────────

async function handleTonKho(config) {
  const tz       = config.timezone;
  const vehicles = await db.getAllInWorkshop(tz);

  if (vehicles.length === 0) {
    return { replyMessage: '🟢 Hiện không có xe nào trong xưởng.' };
  }

  const urgent  = [];
  const warning = [];
  const normal  = [];
  let stt = 1;

  for (const v of vehicles) {
    const line = { stt: stt++, text: utils.formatVehicleInProgress(v, tz) };
    if (v.priority === 'Khẩn')         urgent.push(line);
    else if (v.priority === 'Cảnh báo') warning.push(line);
    else                                normal.push(line);
  }

  let msg = `🔧 Tồn kho: ${vehicles.length} xe trong xưởng`;
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  if (urgent.length > 0) {
    msg += `\n\n🚨 Khẩn >48h (${urgent.length}):`;
    for (const v of urgent) msg += `\n  ${v.stt}. ${v.text}`;
  }
  if (warning.length > 0) {
    msg += `\n\n⚠️ Cảnh báo >24h (${warning.length}):`;
    for (const v of warning) msg += `\n  ${v.stt}. ${v.text}`;
  }
  if (normal.length > 0) {
    msg += `\n\n🔧 Bình thường (${normal.length}):`;
    for (const v of normal) msg += `\n  ${v.stt}. ${v.text}`;
  }

  return { replyMessage: msg };
}

// ──────────────────────────────────────────────
// HELP
// ──────────────────────────────────────────────

function handleHelp() {
  const msg =
    `📋 Hướng dẫn sử dụng\n` +
    `\n— Ghi nhận xe —` +
    `\nChụp ảnh biển số → Gửi vào đây (không cần gõ gì thêm)` +
    `\n  Lần 1: Tự động ghi xe VÀO xưởng` +
    `\n  Lần 2: Tự động ghi xe RA + thời gian lưu` +
    `\n\n— Ghi nhận xe ra (thủ công) —` +
    `\nRA 30A-12345 — Ghi nhận xe ra xưởng (chỉ quản lý)` +
    `\n\n— Báo cáo —` +
    `\nBAOCAO — Báo cáo tổng hợp (năng suất + tồn kho + chi tiết xe)` +
    `\nTONKHO — Xem nhanh tồn kho` +
    `\n\n— Khác —` +
    `\nHELP — Xem hướng dẫn này`;

  return { replyMessage: msg };
}

// ──────────────────────────────────────────────
// Kiem tra canh bao thoi gian luu (24h/48h)
// ──────────────────────────────────────────────

async function checkTimeAlerts(config) {
  const tz       = config.timezone;
  const nowIso   = new Date().toISOString();
  const now      = utils.nowFormatted(tz);
  const vehicles = await db.getAllInWorkshop(tz);
  let updated    = 0;
  const priorityChanges = [];

  for (const v of vehicles) {
    const hours      = utils.hoursSince(v.timeIn, tz);
    let newPriority  = 'Bình thường';

    if (hours >= config.alerts.urgentHours)       newPriority = 'Khẩn';
    else if (hours >= config.alerts.warningHours) newPriority = 'Cảnh báo';

    if (newPriority !== v.priority) {
      await db.updateVehiclePriority(v.vehicleId, newPriority, nowIso);
      priorityChanges.push({ plate: v.plate, priority: newPriority, updatedAt: now });
      updated++;

      logger.info('Alert level changed', {
        plate: v.plate, vehicleId: v.vehicleId,
        hours: Math.round(hours * 10) / 10, newPriority,
      });

      if (newPriority !== 'Bình thường') {
        const icon     = newPriority === 'Khẩn' ? '🚨 Khẩn' : '⚠️ Cảnh báo';
        const alertMsg =
          `${icon} — Xe ${v.plate} đã trong xưởng ${utils.formatHours(hours)}.\n` +
          `Vào lúc: ${v.timeIn}\nMã lượt: ${v.vehicleId}`;
        notifyManagers(alertMsg, config).catch(err => {
          logger.error('Manager alert failed', { error: err.message });
        });
      }
    }
  }

  // Batch sync all priority changes to Sheets (2 API calls instead of N*2)
  if (priorityChanges.length > 0) {
    sheetsSync.syncPrioritiesBatch(priorityChanges);
  }

  return updated;
}

// ──────────────────────────────────────────────
// Format danh sach xe trong xuong (compact)
// ──────────────────────────────────────────────

function formatWorkshopSummary(vehicles, tz) {
  const urgent  = [];
  const warning = [];
  const buckets = { '24-48h': 0, '12-24h': 0, '6-12h': 0, '<6h': 0 };

  for (const v of vehicles) {
    const hours = utils.hoursSince(v.timeIn, tz);
    const label = `${v.plate} — ${utils.formatHours(hours)}`;

    if (v.priority === 'Khẩn') {
      urgent.push(label);
    } else if (v.priority === 'Cảnh báo') {
      warning.push(label);
    } else if (hours >= 24)      buckets['24-48h']++;
    else if (hours >= 12) buckets['12-24h']++;
    else if (hours >= 6)  buckets['6-12h']++;
    else                  buckets['<6h']++;
  }

  let msg = '';

  if (urgent.length > 0) {
    msg += `\n\n🚨 Khẩn (>48h):`;
    for (const v of urgent) msg += `\n  ${v}`;
  }
  if (warning.length > 0) {
    msg += `\n\n⚠️ Cảnh báo (>24h):`;
    for (const v of warning) msg += `\n  ${v}`;
  }

  const normalCount = vehicles.length - urgent.length - warning.length;
  if (normalCount > 0) {
    msg += `\n\n🔧 Xe còn lại (${normalCount}):`;
    for (const [range, count] of Object.entries(buckets)) {
      if (count > 0) msg += `\n  ${range}: ${count} xe`;
    }
  }

  return msg;
}

// ──────────────────────────────────────────────
// Bao cao tu dong cuoi ngay
// ──────────────────────────────────────────────

async function handleDailyReport(config) {
  const tz      = config.timezone;
  const summary = await db.getDailySummary(tz);
  const avgStr  = utils.formatDuration(summary.avgDuration);

  let msg = `📊 Báo cáo tổng hợp — ${summary.today}\n`;
  msg += `\nXe vào hôm nay: ${summary.totalIn}`;
  msg += `\nXe ra hôm nay: ${summary.totalOut}`;
  msg += `\nĐang trong xưởng: ${summary.inWorkshop}`;

  if (summary.warningCount > 0) msg += `\n⚠️ Cảnh báo (>24h): ${summary.warningCount}`;
  if (summary.urgentCount > 0)  msg += `\n🚨 Khẩn (>48h): ${summary.urgentCount}`;
  if (summary.avgDuration > 0)  msg += `\nTB hoàn thành: ${avgStr}`;
  if (summary.pendingReview > 0) msg += `\n\n⚠️ Cần kiểm tra: ${summary.pendingReview} mục chưa xử lý`;

  const inWorkshop = await db.getAllInWorkshop(tz);
  if (inWorkshop.length > 0) {
    msg += formatWorkshopSummary(inWorkshop, tz);
  }

  msg += `\n\nGõ TONKHO để xem danh sách đầy đủ.`;
  return { replyMessage: msg };
}

async function sendScheduledDailyReport(config) {
  const report = await handleDailyReport(config);
  await notifyManagers(report.replyMessage, config);
  logger.info('Scheduled daily report sent');
}

// ──────────────────────────────────────────────
// Thong bao cho quan ly qua Telegram
// ──────────────────────────────────────────────

async function notifyManagers(message, config) {
  const { sendMessage } = require('./telegram');
  const chatIds = config.manager.chatIds;
  if (chatIds.length === 0) return;

  for (const chatId of chatIds) {
    await sendMessage(chatId, message);
  }
  logger.info('Notified managers', { count: chatIds.length });
}

// ──────────────────────────────────────────────
// BAO CAO NANG SUAT
// ──────────────────────────────────────────────

async function handleProductivityReport(config) {
  const tz   = config.timezone;
  const data = await db.getProductivityData(tz);

  let msg = `📊 Báo cáo năng suất xưởng — ${data.today}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  msg += `\n📊 Tổng quan:`;
  msg += `\n  Xe tiếp nhận hôm nay: ${data.todayIn}`;
  msg += `\n  Xe hoàn thành hôm nay: ${data.todayOut}`;
  msg += `\n  Đang trong xưởng: ${data.inWorkshop}`;
  msg += `\n  Tỷ lệ hoàn thành: ${data.completionRate}%`;

  msg += `\n\n📈 So sánh với hôm qua (${data.yesterday}):`;
  const diffIn  = data.todayIn  - data.yesterdayIn;
  const diffOut = data.todayOut - data.yesterdayOut;
  const arrowIn  = diffIn  > 0 ? `+${diffIn} ↑`  : diffIn  < 0 ? `${diffIn} ↓`  : '= bằng';
  const arrowOut = diffOut > 0 ? `+${diffOut} ↑` : diffOut < 0 ? `${diffOut} ↓` : '= bằng';
  msg += `\n  Tiếp nhận: ${data.yesterdayIn} → ${data.todayIn} (${arrowIn})`;
  msg += `\n  Hoàn thành: ${data.yesterdayOut} → ${data.todayOut} (${arrowOut})`;

  if (data.completedCount > 0) {
    const avgStr = utils.formatDuration(data.avgDuration);
    msg += `\n\n⏱ Thời gian xử lý:`;
    msg += `\n  Trung bình: ${avgStr}`;
    if (data.fastestVehicle) msg += `\n  Nhanh nhất: ${data.fastestVehicle.plate} (${utils.formatDuration(data.fastestVehicle.duration)})`;
    if (data.slowestVehicle) msg += `\n  Chậm nhất: ${data.slowestVehicle.plate} (${utils.formatDuration(data.slowestVehicle.duration)})`;
    if (data.yesterdayAvgDuration > 0) {
      const diffAvg  = data.avgDuration - data.yesterdayAvgDuration;
      const avgArrow = diffAvg > 0
        ? `chậm hơn ${utils.formatDuration(Math.abs(diffAvg))}`
        : diffAvg < 0
          ? `nhanh hơn ${utils.formatDuration(Math.abs(diffAvg))}`
          : 'bằng hôm qua';
      msg += `\n  So với hôm qua: ${avgArrow}`;
    }
  }

  if (data.todayIn > 0) {
    msg += `\n\n🕐 Phân bố khung giờ tiếp nhận:`;
    msg += `\n  Sáng (6h–12h): ${data.timeSlots.sang} xe`;
    msg += `\n  Chiều (12h–18h): ${data.timeSlots.chieu} xe`;
    msg += `\n  Tối (18h–24h): ${data.timeSlots.toi} xe`;
    if (data.timeSlots.dem > 0) msg += `\n  Đêm (0h–6h): ${data.timeSlots.dem} xe`;
  }

  if (data.warningCount > 0 || data.urgentCount > 0) {
    msg += `\n\n⚠️ Cảnh báo:`;
    if (data.warningCount > 0) msg += `\n  Quá 24h: ${data.warningCount} xe`;
    if (data.urgentCount > 0)  msg += `\n  🚨 Khẩn quá 48h: ${data.urgentCount} xe`;
  }

  if (data.inWorkshop > 0) {
    const inWorkshop = await db.getAllInWorkshop(tz);
    msg += formatWorkshopSummary(inWorkshop, tz);
  }

  if (data.pendingReview > 0) msg += `\n\n📋 Cần kiểm tra thủ công: ${data.pendingReview} mục`;

  msg += `\n\nGõ TONKHO để xem danh sách đầy đủ.`;
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  return { replyMessage: msg };
}

async function sendScheduledProductivityReport(config) {
  const report = await handleProductivityReport(config);
  await notifyManagers(report.replyMessage, config);
  logger.info('Scheduled productivity report sent');
}

// ──────────────────────────────────────────────
// BAO CAO TONG HOP (gop BAOCAO + NANGSUAT + TONKHO)
// ──────────────────────────────────────────────

async function handleFullReport(config) {
  const tz = config.timezone;
  const alertThresholds = config.alerts;
  const intConfig = config.intelligence || {};
  const maxCapacity = intConfig.workshopCapacity || 130;

  // Fetch ALL data in parallel
  const [data, weeklyAvg, workshopVehicles, repeatData, durationStats, pendingReviews] =
    await Promise.all([
      db.getFullDailyReport(tz),
      db.getWeeklyAverages(tz, intConfig.weeklyAvgDays || 7),
      db.getInWorkshopWithHours(tz),
      db.getRepeatVisitors(tz, intConfig.repeatVisitorDays || 14),
      db.getDurationStats(tz, intConfig.durationStatsDays || 30),
      db.getPendingReviews(),
    ]);

  // Compute intelligence
  const capacityForecast = intel.computeCapacityForecast(
    data.inWorkshopCount, weeklyAvg.avgDailyIn, maxCapacity,
  );

  const urgentVehicles = workshopVehicles.filter(v => v.hoursIn >= alertThresholds.urgentHours);
  const warningVehicles = workshopVehicles.filter(v =>
    v.hoursIn >= alertThresholds.warningHours && v.hoursIn < alertThresholds.urgentHours,
  );

  const predictions = intel.computePredictiveAlerts(
    workshopVehicles, alertThresholds, intConfig.predictiveBufferHours || 12,
  );

  const repeats = intel.detectRepeatVisitors(repeatData);
  const anomalies = intel.detectAnomalies(
    workshopVehicles, durationStats.p90 > 0 ? durationStats.p90 / 60 : 0,
  );

  // Build 7 sections
  const parts = [];

  // [1] KPI Dashboard
  parts.push(utils.formatKPIDashboard({ data, weeklyAvg, capacityForecast }));

  // [2] Action Required
  const actionSection = utils.formatActionRequired(urgentVehicles, warningVehicles, tz);
  if (actionSection) parts.push(actionSection);

  // [3] Predictive Alerts
  const predictSection = utils.formatPredictiveAlerts(predictions, tz);
  if (predictSection) parts.push(predictSection);

  // [4] Today's entries (exception-based)
  const todaySection = utils.formatTodayEntries(data.vehiclesInToday, data.vehiclesOut, durationStats, tz);
  if (todaySection) parts.push(todaySection);

  // [5] Completed vehicles with buckets
  const completedSection = utils.formatCompletedSection(data.vehiclesOut, durationStats, weeklyAvg, tz);
  if (completedSection) parts.push(completedSection);

  // [6] Special attention
  const specialSection = utils.formatSpecialAttention(repeats, anomalies, tz);
  if (specialSection) parts.push(specialSection);

  // [7] Checklist
  const checklistItems = intel.generateChecklist({
    inWorkshopCount: data.inWorkshopCount,
    capacityForecast,
    urgentCount: urgentVehicles.length,
    warningCount: warningVehicles.length,
    predictive24hCount: predictions.approaching24h.length,
    pendingReviewCount: pendingReviews.count,
    slowTodayCount: data.vehiclesInToday.filter(v => {
      const hours = utils.hoursSince(v.timeIn, tz);
      return hours > (durationStats.p90 > 0 ? durationStats.p90 / 60 : 8);
    }).length,
  });
  parts.push(utils.formatChecklist(checklistItems));

  const replyMessages = utils.splitIntoMessages(parts);

  // Fire-and-forget: sync to Google Sheets
  syncDailyReportToSheets(data, tz);

  return { replyMessages };
}

// ──────────────────────────────────────────────
// MORNING BRIEFING (7:00 AM)
// ──────────────────────────────────────────────

async function handleMorningBriefing(config) {
  const tz = config.timezone;
  const alertThresholds = config.alerts;
  const intConfig = config.intelligence || {};
  const maxCapacity = intConfig.workshopCapacity || 130;

  const [workshopVehicles, weeklyAvg] = await Promise.all([
    db.getInWorkshopWithHours(tz),
    db.getWeeklyAverages(tz, intConfig.weeklyAvgDays || 7),
  ]);

  const now = DateTime.now().setZone(tz);
  const urgentVehicles = workshopVehicles.filter(v => v.hoursIn >= alertThresholds.urgentHours);
  const warningVehicles = workshopVehicles.filter(v =>
    v.hoursIn >= alertThresholds.warningHours && v.hoursIn < alertThresholds.urgentHours,
  );
  const normalCount = workshopVehicles.length - urgentVehicles.length - warningVehicles.length;

  const capacityForecast = intel.computeCapacityForecast(
    workshopVehicles.length, weeklyAvg.avgDailyIn, maxCapacity,
  );

  const predictions = intel.computePredictiveAlerts(
    workshopVehicles, alertThresholds, intConfig.predictiveBufferHours || 12,
  );

  const priorities = intel.computeMorningPriorities({
    urgentVehicles,
    approaching48h: predictions.approaching48h,
    capacityForecast,
  });

  const msg = utils.formatMorningBriefing({
    today: now.toFormat('dd/MM/yyyy HH:mm'),
    inWorkshopCount: workshopVehicles.length,
    urgentCount: urgentVehicles.length,
    warningCount: warningVehicles.length,
    normalCount,
    capacityForecast,
    approaching24h: predictions.approaching24h,
    approaching48h: predictions.approaching48h,
    priorities,
  });

  return { replyMessages: [msg] };
}

async function sendScheduledMorningBriefing(config) {
  try {
    const report = await handleMorningBriefing(config);
    for (const msg of report.replyMessages) {
      await notifyManagers(msg, config);
    }
    logger.info('Morning briefing sent');
  } catch (err) {
    logger.error('Morning briefing failed', { error: err.message });
  }
}

function syncDailyReportToSheets(data, tz) {
  const tabName = `BC ${data.today.replace(/\//g, '-')}`;
  const sheetRows = [];
  const sectionRowIndices = []; // 1-based row indices of section headers
  let stt = 1;

  // Helper: format duration minutes to "Xh Yp"
  const fmtDur = (mins) => {
    if (mins == null) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}p`;
  };

  // Helper: generate note for vehicle
  const genNote = (v) => {
    const hours = utils.hoursSince(v.timeIn, tz);
    if (hours >= 48) return '>48h cần XL';
    if (hours >= 24) return '>24h theo dõi';
    return '';
  };

  // 1. Section: TỒN KHO TỪ TRƯỚC
  const oldStock = data.inWorkshop.filter(v =>
    !data.vehiclesInToday.some(vi => vi.vehicleId === v.vehicleId)
  );
  if (oldStock.length > 0) {
    sectionRowIndices.push(sheetRows.length + 1); // +1 for header row offset
    sheetRows.push({
      stt: '', type: `TỒN KHO TỪ TRƯỚC (${oldStock.length} xe)`,
      plate: '', vehicleModel: '', timeIn: '', timeOut: '', duration: '',
      priority: '', status: '', note: '',
    });
    for (const v of oldStock) {
      const hours = utils.hoursSince(v.timeIn, tz);
      sheetRows.push({
        stt: String(stt++), type: 'TỒN KHO',
        plate: v.plate, vehicleModel: v.vehicleModel || '', timeIn: v.timeIn, timeOut: '',
        duration: utils.formatHours(hours),
        priority: v.priority, status: 'Đang trong xưởng',
        note: genNote(v),
      });
    }
  }

  // 2. Section: VÀO HÔM NAY
  if (data.vehiclesInToday.length > 0) {
    sectionRowIndices.push(sheetRows.length + 1);
    sheetRows.push({
      stt: '', type: `VÀO HÔM NAY (${data.vehiclesInToday.length} xe)`,
      plate: '', vehicleModel: '', timeIn: '', timeOut: '', duration: '',
      priority: '', status: '', note: '',
    });
    for (const v of data.vehiclesInToday) {
      const hours = utils.hoursSince(v.timeIn, tz);
      sheetRows.push({
        stt: String(stt++), type: 'VÀO HÔM NAY',
        plate: v.plate, vehicleModel: v.vehicleModel || '', timeIn: v.timeIn, timeOut: '',
        duration: utils.formatHours(hours),
        priority: v.priority, status: 'Đang trong xưởng',
        note: genNote(v),
      });
    }
  }

  // 3. Section: ĐÃ RA HÔM NAY
  if (data.vehiclesOut.length > 0) {
    sectionRowIndices.push(sheetRows.length + 1);
    sheetRows.push({
      stt: '', type: `ĐÃ RA HÔM NAY (${data.vehiclesOut.length} xe)`,
      plate: '', vehicleModel: '', timeIn: '', timeOut: '', duration: '',
      priority: '', status: '', note: '',
    });
    for (const v of data.vehiclesOut) {
      sheetRows.push({
        stt: String(stt++), type: 'ĐÃ RA',
        plate: v.plate, vehicleModel: v.vehicleModel || '', timeIn: v.timeIn, timeOut: v.timeOut,
        duration: v.durationMinutes != null ? fmtDur(v.durationMinutes) : '',
        priority: v.priority, status: 'Đã ra xưởng',
        note: '',
      });
    }
  }

  // 4. Summary row
  const summaryRowIndex = sheetRows.length + 1; // +1 for header
  const avgStr = data.avgDuration > 0 ? fmtDur(data.avgDuration) : '';
  sheetRows.push({
    stt: '', type: 'TỔNG KẾT',
    plate: `Tồn: ${data.inWorkshopCount} xe`,
    timeIn: `Vào: ${data.totalIn}`,
    timeOut: `Ra: ${data.totalOut}`,
    duration: avgStr ? `TB: ${avgStr}` : '',
    priority: '', status: `Hoàn thành: ${data.completionRate}%`,
    note: '',
  });

  sheetsSync.syncDailyReport(tabName, sheetRows, sectionRowIndices, summaryRowIndex);
}

async function sendScheduledFullReport(config) {
  const report = await handleFullReport(config);
  for (const msg of report.replyMessages) {
    await notifyManagers(msg, config);
  }
  logger.info('Scheduled full daily report sent', { parts: report.replyMessages.length });
}

// ──────────────────────────────────────────────
// NHAC XAC NHAN XE RA cuoi ca (17:00)
// ──────────────────────────────────────────────

async function sendEndOfDayReminder(config) {
  const tz       = config.timezone;
  const vehicles = await db.getAllInWorkshop(tz);

  // Filter xe vào hôm nay hoặc hôm qua mà chưa ra
  const { DateTime } = require('luxon');
  const now       = DateTime.now().setZone(tz);
  const yesterday = now.minus({ days: 1 });

  const recentVehicles = vehicles.filter(v => {
    if (!v.timeIn) return false;
    const match = v.timeIn.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return false;
    const day = parseInt(match[1]), month = parseInt(match[2]);
    const isToday     = day === now.day && month === now.month;
    const isYesterday = day === yesterday.day && month === yesterday.month;
    return isToday || isYesterday;
  });

  if (recentVehicles.length === 0) {
    logger.info('End-of-day reminder: no recent vehicles pending exit');
    return;
  }

  let msg = `🔔 Nhắc xác nhận xe ra xưởng\n`;
  msg += `\nCó ${recentVehicles.length} xe chưa ghi nhận RA:\n`;

  for (const v of recentVehicles) {
    const hours = utils.hoursSince(v.timeIn, tz);
    msg += `\n${v.plate} — vào lúc ${utils.extractTime(v.timeIn)} (${utils.formatHours(hours)} trước)`;
  }

  msg += `\n\n👉 Xe nào đã ra, chụp lại ảnh biển số gửi vào đây.`;
  msg += `\n👉 Hoặc gõ: RA 30A-12345 để ghi nhận thủ công.`;

  await notifyManagers(msg, config);
  logger.info('End-of-day reminder sent', { count: recentVehicles.length });
}

// ──────────────────────────────────────────────
// RA THU CONG (manual exit via text command)
// ──────────────────────────────────────────────

async function handleManualExit(plate, senderName, config) {
  const nowIso = new Date().toISOString();
  const result = await db.forceExitByPlate(plate, nowIso);

  if (!result) {
    return { replyMessage: `Xin lỗi, không tìm thấy xe ${plate} đang trong xưởng.` };
  }

  const durationStr = utils.formatDuration(result.duration);
  logger.info('Manual exit processed', { plate, vehicleId: result.vehicleId, by: senderName });

  // Sync to Sheets
  const now = utils.nowFormatted(config.timezone);
  sheetsSync.syncVehicleOut(plate, result.vehicleId, {
    timeOut: now,
    duration: String(result.duration),
    status: 'Đã ra xưởng',
    note: `RA thủ công bởi ${senderName}`,
    updatedAt: now,
  });

  return {
    replyMessage:
      `Cảm ơn! ✅ Đã ghi nhận xe RA xưởng (thủ công)\n` +
      `Biển số: ${plate}\n` +
      `Vào lúc: ${result.timeIn}\n` +
      `Thời gian lưu: ${durationStr}\n` +
      `Ghi nhận bởi: ${senderName}`,
  };
}

// ──────────────────────────────────────────────
// BAO CAO KE TOAN
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// EVENING SWEEP — fix ghost vehicles via human-in-the-loop
// ──────────────────────────────────────────────
//
// Why this exists:
// Bảo vệ luôn chụp ảnh xe VÀO nhưng hay quên chụp xe RA → DB tích lũy "ghost
// vehicles" → "Đang trong xưởng" hiển thị nhiều hơn thực tế. Auto-close >72h
// chỉ xử lý sau 3 ngày.
//
// Solution: tận dụng workflow có sẵn (bảo vệ chiều đi vòng kiểm tra thủ công).
// Mỗi 18h bot push danh sách xe nghi ngờ (>warningHours, mặc định 24h) vào
// nhóm Telegram. Bảo vệ đi vòng → reply số xe đã ra (vd "1 3 5") → bot tự
// đóng. Mặc định "không reply" = vẫn còn (an toàn, không đóng nhầm).
//
// Session state: lưu in-memory Map (chatId → session) ở server.js, expire
// sau 4h. Render starter plan không sleep nên session sống đủ lâu.

/**
 * Build evening sweep prompt and send to manager chats.
 * Stores session state for each chat so subsequent digit replies can be parsed.
 *
 * @param {Object} config - app config
 * @param {Map} sweepSessions - in-memory store, keyed by chatId
 * @param {Function} sendMessageFn - telegram send function (injected for testability)
 */
async function sendEveningSweepPrompt(config, sweepSessions, sendMessageFn) {
  const tz = config.timezone;
  const warningHours = config.alerts?.warningHours || 24;
  const managerChatIds = config.manager.chatIds;
  const todayStr = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');

  if (!managerChatIds || managerChatIds.length === 0) {
    logger.info('Evening sweep skipped — no manager chat IDs configured');
    return { sent: 0, suspect: 0 };
  }

  // Find suspect vehicles (>warningHours, sorted oldest first so guard sees worst cases at top)
  const allInWorkshop = await db.getInWorkshopWithHours(tz);
  const suspect = allInWorkshop
    .filter(v => v.hoursIn >= warningHours)
    .sort((a, b) => b.hoursIn - a.hoursIn);

  let messageText;
  if (suspect.length === 0) {
    messageText =
      `✅ ${DateTime.now().setZone(tz).toFormat('HH:mm dd/MM')} — Không có xe nghi đã ra.\n` +
      `Tất cả xe trong xưởng đều mới (≤${warningHours}h). Cảm ơn các anh đã chụp đầy đủ!`;
  } else {
    const lines = suspect.map((v, i) => {
      const idx = (i + 1).toString().padStart(2, ' ');
      const hours = `${Math.round(v.hoursIn)}h`.padStart(4, ' ');
      const model = v.vehicleModel || '—';
      return `${idx}.  ${v.plate}  (${model}, ${hours})`;
    });

    messageText =
      `🔍 Anh đi vòng giúp em check ${suspect.length} xe nghi đã ra:\n\n` +
      lines.join('\n') + '\n\n' +
      `Reply số xe ĐÃ RA, vd: 1 3 5\n` +
      `(không trả lời = vẫn còn trong xưởng — không bị đóng)`;
  }

  // Send to each manager chat + create session (for non-empty lists only)
  let sent = 0;
  for (const chatId of managerChatIds) {
    try {
      await sendMessageFn(chatId, messageText);
      sent++;

      if (suspect.length > 0) {
        sweepSessions.set(String(chatId), {
          date: todayStr,
          createdAt: Date.now(),
          expiresAt: Date.now() + 4 * 60 * 60 * 1000, // 4h window
          vehicles: suspect.map(v => ({
            vehicleId: v.vehicleId,
            plate: v.plate,
            vehicleModel: v.vehicleModel,
            hoursIn: v.hoursIn,
          })),
        });
      } else {
        // Clear any stale session for this chat
        sweepSessions.delete(String(chatId));
      }
    } catch (err) {
      logger.error('Evening sweep send failed', { chatId, error: err.message });
    }
  }

  logger.info('Evening sweep prompt sent', { sent, suspect: suspect.length });
  return { sent, suspect: suspect.length };
}

/**
 * Process a sweep reply (e.g. "1 3 5") for a given chat.
 *
 * @param {number[]} indices - parsed 1-based indices
 * @param {string|number} chatId
 * @param {Map} sweepSessions
 * @param {string} senderName
 * @param {Object} config
 * @returns {Promise<{replyMessage: string}>}
 */
async function processSweepReply(indices, chatId, sweepSessions, senderName, config) {
  const session = sweepSessions.get(String(chatId));
  if (!session) {
    return null; // not in sweep mode → caller falls through to normal parsing
  }

  // Expire check
  if (Date.now() > session.expiresAt) {
    sweepSessions.delete(String(chatId));
    return null;
  }

  const max = session.vehicles.length;
  const valid = indices.filter(i => i >= 1 && i <= max);
  const invalid = indices.filter(i => i < 1 || i > max);

  if (valid.length === 0) {
    return {
      replyMessage:
        `⚠️ Số ${invalid.join(', ')} không có trong danh sách (chỉ có 1-${max}).\n` +
        `Reply lại số xe ĐÃ RA, vd: 1 3 5`,
    };
  }

  // Force-exit each selected vehicle
  const nowIso = new Date().toISOString();
  const closed = [];
  const failed = [];

  for (const i of valid) {
    const v = session.vehicles[i - 1];
    try {
      const result = await db.forceExitVehicle(v.vehicleId, nowIso);
      if (result) {
        closed.push(`${i}. ${v.plate}`);
        // Sync to Sheets
        const nowFmt = utils.nowFormatted(config.timezone);
        sheetsSync.syncVehicleOut(v.plate, v.vehicleId, {
          timeOut: nowFmt,
          duration: '',
          status: 'Đã ra xưởng',
          note: `Sweep 18h — ${senderName}`,
          updatedAt: nowFmt,
        });
      } else {
        failed.push(`${i}. ${v.plate} (đã được đóng trước đó)`);
      }
    } catch (err) {
      logger.error('Sweep force-exit failed', { plate: v.plate, error: err.message });
      failed.push(`${i}. ${v.plate} (lỗi: ${err.message})`);
    }
  }

  // Mark these indices as processed so re-replies don't double-process
  const remaining = session.vehicles.filter((_, idx) => !valid.includes(idx + 1));
  if (remaining.length === 0) {
    sweepSessions.delete(String(chatId));
  } else {
    session.vehicles = remaining;
    // NOTE: indices in the new session are RE-NUMBERED. If user replies again,
    // they'll be reading from the original list. We accept this trade-off:
    // most replies are 1 batch. For multi-batch, send a fresh prompt.
    sweepSessions.delete(String(chatId)); // safer: force fresh prompt for next round
  }

  let reply = `✅ Đã đóng ${closed.length} xe:\n${closed.join('\n')}`;
  if (failed.length > 0) {
    reply += `\n\n⚠️ Không đóng được:\n${failed.join('\n')}`;
  }
  if (invalid.length > 0) {
    reply += `\n\nℹ️ Số ${invalid.join(', ')} không có trong list, đã bỏ qua.`;
  }
  reply += `\n\nGhi nhận bởi: ${senderName}`;

  logger.info('Sweep reply processed', {
    chatId,
    closed: closed.length,
    failed: failed.length,
    invalid: invalid.length,
  });

  return { replyMessage: reply };
}

async function handleAccountingReport(fileUrl, config) {
  const { downloadAndParseExcel } = require('./excel');
  const { generateAccountingReport } = require('./accounting');

  const orders = await downloadAndParseExcel(fileUrl);
  if (orders.length === 0) {
    return { messages: ['File Excel không có dữ liệu hợp lệ. Vui lòng kiểm tra lại nhé.'] };
  }

  const messages = await generateAccountingReport(orders, config);
  return { messages };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function fmtIso(isoTs, tz) {
  if (!isoTs) return '';
  return DateTime.fromISO(isoTs, { zone: tz }).toFormat('dd/MM/yyyy HH:mm:ss');
}

/**
 * Tạo file Excel báo cáo nhật ký hàng ngày và gửi vào nhóm Telegram.
 * Thay thế báo cáo text cũ — gửi file .xlsx trực tiếp.
 */
async function sendDailyExcelReport(config) {
  const tz = config.timezone;
  const { DateTime: Dt } = require('luxon');
  const now = Dt.now().setZone(tz);

  const [todayVehicles, inWorkshopVehicles] = await Promise.all([
    db.getTodayActivity(tz),
    db.getAllInWorkshop(tz),
  ]);

  const buffer = await buildDailyExcelReport(todayVehicles, inWorkshopVehicles, tz);
  const fileName = `Báo-cáo-${now.toFormat('dd-MM-yyyy')}.xlsx`;

  const totalIn = todayVehicles.filter(v => {
    const tIn = v.timeInISO ? Dt.fromISO(v.timeInISO, { zone: tz }) : null;
    return tIn && tIn >= now.startOf('day') && tIn < now.plus({ days: 1 }).startOf('day');
  }).length;
  const totalOut = todayVehicles.filter(v => {
    const tOut = v.timeOutISO ? Dt.fromISO(v.timeOutISO, { zone: tz }) : null;
    return tOut && tOut >= now.startOf('day') && tOut < now.plus({ days: 1 }).startOf('day');
  }).length;

  const caption =
    `📊 Báo cáo ngày ${now.toFormat('dd/MM/yyyy')}\n` +
    `Vào: ${totalIn} • Ra: ${totalOut} • Trong xưởng: ${inWorkshopVehicles.length}`;

  const { sendDocument } = require('./telegram');
  const chatIds = config.manager.chatIds;
  for (const chatId of chatIds) {
    await sendDocument(chatId, buffer, fileName, caption);
  }

  // Đồng bộ tab BC vào Sheets (giữ nguyên)
  syncDailyReportToSheets(
    await db.getFullDailyReport(tz),
    tz,
  );

  logger.info('Báo cáo Excel hàng ngày đã gửi', { fileName, chatIds: chatIds.length });
}

module.exports = {
  processVehicleEvent,
  checkTimeAlerts,
  handleTonKho,
  handleHelp,
  handleDailyReport,
  sendScheduledDailyReport,
  handleProductivityReport,
  handleAccountingReport,
  handleFullReport,
  sendScheduledFullReport,
  sendDailyExcelReport,
  handleMorningBriefing,
  sendScheduledMorningBriefing,
  handleManualExit,
  sendEndOfDayReminder,
  sendEveningSweepPrompt,
  processSweepReply,
};
