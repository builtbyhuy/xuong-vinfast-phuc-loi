'use strict';

/**
 * Tests for matcher.js handler functions (handleHelp, handleTonKho,
 * handleDailyReport, handleManualExit, checkTimeAlerts).
 *
 * All DB/Sheets/Telegram calls are mocked via require-cache injection.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

// ── Mock DB ─────────────────────────────────────────────────────────────────

const dbMock = {
  _inWorkshop: [],
  _dailySummary: {},
  _productivityData: {},
  _fullReport: {},
  _forceExitResult: null,
  _weeklyAverages: { avgDailyIn: 10, avgDailyOut: 8, avgDuration: 300 },
  _inWorkshopWithHours: [],
  _repeatVisitors: [],
  _durationStats: { p50: 240, p75: 360, p90: 480, count: 100 },
  _pendingReviews: { count: 0, items: [] },

  initDb() {},
  testConnection: async () => {},
  processVehicleDecision: async () => ({ action: 'VAO', vehicle_id: 'LX-001', time_in_ts: new Date().toISOString(), seconds_in: 0 }),
  insertEvent: async () => {},
  updateEventResult: async () => {},
  insertReview: async () => {},
  isMessageProcessed: async () => false,
  getAllInWorkshop: async () => dbMock._inWorkshop,
  updateVehiclePriority: async () => {},
  getDailySummary: async () => dbMock._dailySummary,
  getProductivityData: async () => dbMock._productivityData,
  getAllMainRows: async () => [],
  getFullDailyReport: async () => dbMock._fullReport,
  forceExitByPlate: async () => dbMock._forceExitResult,
  expireStaleVehicles: async () => 0,
  forceExitVehicle: async () => null,
  countInWorkshop: async () => dbMock._inWorkshop.length,
  getWeeklyAverages: async () => dbMock._weeklyAverages,
  getInWorkshopWithHours: async () => dbMock._inWorkshopWithHours,
  getRepeatVisitors: async () => dbMock._repeatVisitors,
  getDurationStats: async () => dbMock._durationStats,
  getPendingReviews: async () => dbMock._pendingReviews,
};

// ── Mock Sheets Sync ────────────────────────────────────────────────────────

const sheetsMock = {
  syncLogInsert: () => {},
  syncLogResult: () => {},
  syncVehicleIn: () => {},
  syncVehicleOut: () => {},
  syncReviewInsert: () => {},
  syncPrioritiesBatch: () => {},
  syncDailyReport: () => {},
  syncDashboard: () => {},
};

// ── Mock Telegram ───────────────────────────────────────────────────────────

const telegramMock = {
  sendMessage: async () => {},
};

// ── Mock Logger ─────────────────────────────────────────────────────────────

const loggerMock = { info: () => {}, warn: () => {}, error: () => {} };

// ── Inject mocks before requiring matcher.js ────────────────────────────────

require.cache[require.resolve('../src/db')] = { exports: dbMock };
require.cache[require.resolve('../src/sheets-sync')] = { exports: sheetsMock };
require.cache[require.resolve('../src/telegram')] = { exports: telegramMock };
require.cache[require.resolve('../src/logger')] = { exports: loggerMock };

const matcher = require('../src/matcher');

after(() => {
  delete require.cache[require.resolve('../src/matcher')];
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/sheets-sync')];
  delete require.cache[require.resolve('../src/telegram')];
  delete require.cache[require.resolve('../src/logger')];
});

const config = {
  timezone: 'Asia/Ho_Chi_Minh',
  ocr: { confidenceHigh: 0.8, confidenceMedium: 0.5 },
  alerts: { warningHours: 24, urgentHours: 48, minWorkshopMinutes: 3 },
  manager: { chatIds: [], dailyReportHour: 18, morningReportHour: 7 },
  intelligence: {
    workshopCapacity: 130,
    durationFastHours: 3,
    durationNormalHours: 5,
    durationSlowHours: 8,
    predictiveBufferHours: 12,
    repeatVisitorDays: 14,
    durationStatsDays: 30,
    weeklyAvgDays: 7,
  },
  telegram: { botToken: 'fake' },
};

// ──────────────────────────────────────────────
// handleHelp
// ──────────────────────────────────────────────

describe('matcher.handleHelp', () => {
  it('returns help message with usage instructions', () => {
    const result = matcher.handleHelp();
    assert.ok(result.replyMessage.includes('Hướng dẫn sử dụng'));
    assert.ok(result.replyMessage.includes('BAOCAO'));
    assert.ok(result.replyMessage.includes('TONKHO'));
    assert.ok(result.replyMessage.includes('HELP'));
    assert.ok(result.replyMessage.includes('RA'));
  });
});

// ──────────────────────────────────────────────
// handleTonKho
// ──────────────────────────────────────────────

describe('matcher.handleTonKho', () => {
  beforeEach(() => {
    dbMock._inWorkshop = [];
  });

  it('returns empty message when no vehicles', async () => {
    const result = await matcher.handleTonKho(config);
    assert.ok(result.replyMessage.includes('không có xe'));
  });

  it('groups vehicles by priority', async () => {
    dbMock._inWorkshop = [
      { plate: '30A-URGENT', timeIn: '01/04/2026 08:00:00', priority: 'Khẩn', vehicleModel: '' },
      { plate: '30A-WARN', timeIn: '02/04/2026 08:00:00', priority: 'Cảnh báo', vehicleModel: '' },
      { plate: '30A-NORM', timeIn: '03/04/2026 08:00:00', priority: 'Bình thường', vehicleModel: '' },
    ];
    const result = await matcher.handleTonKho(config);
    assert.ok(result.replyMessage.includes('3 xe'));
    assert.ok(result.replyMessage.includes('Khẩn'));
    assert.ok(result.replyMessage.includes('Cảnh báo'));
    assert.ok(result.replyMessage.includes('Bình thường'));
  });
});

// ──────────────────────────────────────────────
// handleDailyReport
// ──────────────────────────────────────────────

describe('matcher.handleDailyReport', () => {
  beforeEach(() => {
    dbMock._dailySummary = {
      today: '03/04/2026', totalIn: 12, totalOut: 10,
      inWorkshop: 45, warningCount: 3, urgentCount: 1,
      pendingReview: 2, avgDuration: 240,
    };
    dbMock._inWorkshop = [];
  });

  it('returns daily summary report', async () => {
    const result = await matcher.handleDailyReport(config);
    assert.ok(result.replyMessage.includes('Báo cáo tổng hợp'));
    assert.ok(result.replyMessage.includes('12'));
    assert.ok(result.replyMessage.includes('10'));
    assert.ok(result.replyMessage.includes('Cảnh báo'));
    assert.ok(result.replyMessage.includes('Khẩn'));
  });

  it('includes workshop summary when vehicles present', async () => {
    dbMock._inWorkshop = [
      { plate: '30A-111', timeIn: '03/04/2026 08:00:00', priority: 'Bình thường', vehicleModel: '' },
    ];
    const result = await matcher.handleDailyReport(config);
    assert.ok(result.replyMessage.includes('TONKHO'));
  });
});

// ──────────────────────────────────────────────
// handleManualExit
// ──────────────────────────────────────────────

describe('matcher.handleManualExit', () => {
  it('returns not found when vehicle not in workshop', async () => {
    dbMock._forceExitResult = null;
    const result = await matcher.handleManualExit('30A-MISSING', 'TestUser', config);
    assert.ok(result.replyMessage.includes('Không tìm thấy') || result.replyMessage.includes('không tìm'));
  });

  it('returns success when vehicle exited', async () => {
    dbMock._forceExitResult = {
      vehicleId: 'LX-001', plate: '30A-12345',
      timeIn: '03/04/2026 08:00:00', duration: 360,
    };
    const result = await matcher.handleManualExit('30A-12345', 'TestUser', config);
    assert.ok(result.replyMessage.includes('30A-12345'));
    assert.ok(result.replyMessage.includes('RA'));
  });
});

// ──────────────────────────────────────────────
// checkTimeAlerts
// ──────────────────────────────────────────────

describe('matcher.checkTimeAlerts', () => {
  it('returns 0 when no priority changes needed', async () => {
    dbMock._inWorkshop = [
      { plate: '30A-111', timeIn: DateTime.now().setZone('Asia/Ho_Chi_Minh').toFormat('dd/MM/yyyy HH:mm:ss'), priority: 'Bình thường', vehicleId: 'LX-001' },
    ];
    const updated = await matcher.checkTimeAlerts(config);
    assert.equal(updated, 0);
  });
});

// ──────────────────────────────────────────────
// handleProductivityReport
// ──────────────────────────────────────────────

describe('matcher.handleProductivityReport', () => {
  beforeEach(() => {
    dbMock._productivityData = {
      today: '03/04/2026', yesterday: '02/04/2026',
      todayIn: 15, todayOut: 12, inWorkshop: 45,
      warningCount: 2, urgentCount: 1, pendingReview: 3,
      completedCount: 12, avgDuration: 300,
      fastestVehicle: { plate: '30A-FAST', duration: 60 },
      slowestVehicle: { plate: '30A-SLOW', duration: 720 },
      yesterdayIn: 10, yesterdayOut: 8, yesterdayAvgDuration: 280,
      completionRate: 80,
      timeSlots: { sang: 5, chieu: 7, toi: 3, dem: 0 },
    };
    dbMock._inWorkshop = [];
  });

  it('returns productivity report with all sections', async () => {
    const result = await matcher.handleProductivityReport(config);
    assert.ok(result.replyMessage.includes('năng suất'));
    assert.ok(result.replyMessage.includes('15'));
    assert.ok(result.replyMessage.includes('So sánh'));
    assert.ok(result.replyMessage.includes('Thời gian xử lý'));
    assert.ok(result.replyMessage.includes('Phân bố khung giờ'));
    assert.ok(result.replyMessage.includes('Cảnh báo'));
  });

  it('handles zero completed vehicles', async () => {
    dbMock._productivityData = {
      ...dbMock._productivityData,
      completedCount: 0, todayIn: 0, warningCount: 0, urgentCount: 0,
    };
    const result = await matcher.handleProductivityReport(config);
    assert.ok(!result.replyMessage.includes('Thời gian xử lý'));
  });
});

// ──────────────────────────────────────────────
// handleFullReport
// ──────────────────────────────────────────────

describe('matcher.handleFullReport', () => {
  beforeEach(() => {
    dbMock._fullReport = {
      today: '03/04/2026', yesterday: '02/04/2026',
      vehiclesOut: [], vehiclesInToday: [], inWorkshop: [],
      totalIn: 10, totalOut: 8, inWorkshopCount: 45,
      warningCount: 2, urgentCount: 1, pendingReview: 0,
      avgDuration: 240, yesterdayIn: 8, yesterdayOut: 7,
      yesterdayAvgDuration: 220, completionRate: 80,
      completedCount: 8, fastestVehicle: null, slowestVehicle: null,
      timeSlots: { sang: 4, chieu: 5, toi: 1, dem: 0 },
    };
    dbMock._inWorkshopWithHours = [];
    dbMock._repeatVisitors = [];
    dbMock._weeklyAverages = { avgDailyIn: 10, avgDailyOut: 8, avgDuration: 300 };
    dbMock._durationStats = { p50: 240, p75: 360, p90: 480, count: 100 };
    dbMock._pendingReviews = { count: 0, items: [] };
  });

  it('returns array of message parts', async () => {
    const result = await matcher.handleFullReport(config);
    assert.ok(Array.isArray(result.replyMessages));
    assert.ok(result.replyMessages.length >= 1);
    assert.ok(result.replyMessages[0].includes('BÁO CÁO CUỐI NGÀY'));
  });

  it('includes checklist section', async () => {
    const result = await matcher.handleFullReport(config);
    const allText = result.replyMessages.join('\n');
    assert.ok(allText.includes('CHECKLIST'));
  });
});

// ──────────────────────────────────────────────
// handleMorningBriefing
// ──────────────────────────────────────────────

describe('matcher.handleMorningBriefing', () => {
  beforeEach(() => {
    dbMock._inWorkshopWithHours = [
      { plate: '30A-111', hoursIn: 10, timeIn: '03/04/2026 06:00:00', priority: 'Bình thường', vehicleModel: '' },
    ];
    dbMock._weeklyAverages = { avgDailyIn: 10, avgDailyOut: 8, avgDuration: 300 };
  });

  it('returns morning briefing message', async () => {
    const result = await matcher.handleMorningBriefing(config);
    assert.ok(Array.isArray(result.replyMessages));
    const allText = result.replyMessages.join('\n');
    assert.ok(allText.includes('SÁNG NAY'));
    assert.ok(allText.includes('TỒN KHO'));
  });
});

// ──────────────────────────────────────────────
// processVehicleEvent — VAO path
// ──────────────────────────────────────────────

describe('matcher.processVehicleEvent - VAO', () => {
  it('processes a valid VAO event', async () => {
    const dashboardConfigs = [];
    sheetsMock.syncDashboard = (cfg) => dashboardConfigs.push(cfg);
    dbMock.processVehicleDecision = async () => ({
      action: 'VAO', vehicle_id: 'LX-TEST', time_in_ts: new Date().toISOString(), seconds_in: 0,
    });

    const event = {
      messageId: 'test_123',
      senderId: '12345',
      senderName: 'Test User',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '30A-12345', confidence: 0.95, vehicleModel: 'VF 8' },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, true);
    assert.ok(result.replyMessage.includes('VÀO'));
    assert.ok(result.replyMessage.includes('30A-12345'));
    assert.ok(result.replyMessage.includes('VF 8'));
    assert.deepEqual(dashboardConfigs, [config], 'committed entry must request the dashboard replacement path');
  });
});

// ──────────────────────────────────────────────
// processVehicleEvent — OCR failures
// ──────────────────────────────────────────────

describe('matcher.processVehicleEvent - OCR failures', () => {
  it('handles no plate detected', async () => {
    const event = {
      messageId: 'test_no_plate',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '', confidence: 0 },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, false);
    assert.ok(result.replyMessage.includes('không đọc được'));
  });

  it('handles low confidence OCR', async () => {
    const event = {
      messageId: 'test_low_conf',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '30A-12345', confidence: 0.3 },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, false);
    assert.ok(result.replyMessage.includes('chưa chắc chắn'));
  });

  it('handles invalid plate format', async () => {
    const event = {
      messageId: 'test_bad_plate',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: 'INVALID', confidence: 0.9 },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, false);
    assert.ok(result.replyMessage.includes('không đúng định dạng'));
  });
});

// ──────────────────────────────────────────────
// processVehicleEvent — RA path
// ──────────────────────────────────────────────

describe('matcher.processVehicleEvent - RA', () => {
  it('processes a valid RA event', async () => {
    const dashboardConfigs = [];
    sheetsMock.syncDashboard = (cfg) => dashboardConfigs.push(cfg);
    dbMock.processVehicleDecision = async () => ({
      action: 'RA', vehicle_id: 'LX-002', time_in_ts: new Date(Date.now() - 7200000).toISOString(), seconds_in: 7200,
    });

    const event = {
      messageId: 'test_ra',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '30A-12345', confidence: 0.95, vehicleModel: '' },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, true);
    assert.ok(result.replyMessage.includes('RA'));
    assert.ok(result.replyMessage.includes('Thời gian lưu'));
    assert.deepEqual(dashboardConfigs, [config], 'committed exit must request the dashboard replacement path');
  });
});

// ──────────────────────────────────────────────
// processVehicleEvent — RA_DUPLICATE path
// ──────────────────────────────────────────────

describe('matcher.processVehicleEvent - RA_DUPLICATE', () => {
  it('rejects RA when vehicle just entered', async () => {
    dbMock.processVehicleDecision = async () => ({
      action: 'RA_DUPLICATE', vehicle_id: 'LX-003', time_in_ts: new Date().toISOString(), seconds_in: 30,
    });

    const event = {
      messageId: 'test_dup',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '30A-12345', confidence: 0.95, vehicleModel: '' },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, false);
    assert.ok(result.replyMessage.includes('Đã nhận ảnh xe'));
  });
});

// ──────────────────────────────────────────────
// checkTimeAlerts — priority change path
// ──────────────────────────────────────────────

describe('matcher.checkTimeAlerts - priority changes', () => {
  it('updates priority for vehicles exceeding thresholds', async () => {
    let priorityUpdated = false;
    dbMock.updateVehiclePriority = async () => { priorityUpdated = true; };
    dbMock._inWorkshop = [
      {
        plate: '30A-OLD',
        timeIn: DateTime.now().setZone('Asia/Ho_Chi_Minh').minus({ hours: 50 }).toFormat('dd/MM/yyyy HH:mm:ss'),
        priority: 'Bình thường',
        vehicleId: 'LX-OLD',
      },
    ];
    const updated = await matcher.checkTimeAlerts(config);
    assert.ok(updated > 0);
    assert.ok(priorityUpdated);
  });

  it('upgrades to warning when between 24-48h', async () => {
    let newPriority = null;
    dbMock.updateVehiclePriority = async (_id, p) => { newPriority = p; };
    dbMock._inWorkshop = [
      {
        plate: '30A-WARN',
        timeIn: DateTime.now().setZone('Asia/Ho_Chi_Minh').minus({ hours: 30 }).toFormat('dd/MM/yyyy HH:mm:ss'),
        priority: 'Bình thường',
        vehicleId: 'LX-WARN',
      },
    ];
    await matcher.checkTimeAlerts(config);
    assert.equal(newPriority, 'Cảnh báo');
  });
});

// ──────────────────────────────────────────────
// handleProductivityReport — with workshop vehicles
// ──────────────────────────────────────────────

describe('matcher.handleProductivityReport - workshop vehicles', () => {
  it('includes workshop summary when vehicles present', async () => {
    dbMock._productivityData = {
      today: '03/04/2026', yesterday: '02/04/2026',
      todayIn: 10, todayOut: 8, inWorkshop: 3,
      warningCount: 0, urgentCount: 0, pendingReview: 0,
      completedCount: 8, avgDuration: 300,
      fastestVehicle: null, slowestVehicle: null,
      yesterdayIn: 8, yesterdayOut: 6, yesterdayAvgDuration: 0,
      completionRate: 80,
      timeSlots: { sang: 5, chieu: 5, toi: 0, dem: 0 },
    };
    dbMock._inWorkshop = [
      { plate: '30A-111', timeIn: '03/04/2026 08:00:00', priority: 'Bình thường', vehicleModel: '' },
      { plate: '30A-222', timeIn: '02/04/2026 08:00:00', priority: 'Cảnh báo', vehicleModel: '' },
    ];
    const result = await matcher.handleProductivityReport(config);
    assert.ok(result.replyMessage.includes('30A'));
  });
});

// ──────────────────────────────────────────────
// processVehicleEvent — RPC failure
// ──────────────────────────────────────────────

describe('matcher.processVehicleEvent - RPC failure', () => {
  it('handles RPC error gracefully', async () => {
    dbMock.processVehicleDecision = async () => { throw new Error('DB down'); };

    const event = {
      messageId: 'test_rpc_fail',
      senderId: '12345', senderName: 'Test',
      imageUrl: 'https://example.com/img.jpg',
      ocrResult: { plateText: '30A-12345', confidence: 0.95, vehicleModel: '' },
    };
    const result = await matcher.processVehicleEvent(event, config);
    assert.equal(result.success, false);
    assert.ok(result.replyMessage.includes('lỗi'));
  });
});
