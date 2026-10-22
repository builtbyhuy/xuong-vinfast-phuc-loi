'use strict';

/**
 * Targeted tests for the RPC-failure hardening slice in matcher.js.
 *
 * Verifies:
 * 1. processVehicleEvent marks the event as error state when the RPC throws
 * 2. A user-facing retry message is returned (not silence)
 * 3. RA_DUPLICATE log includes minWorkshopMinutes
 * 4. || 15 fallback is gone — minWorkshopSecs uses config value directly
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Minimal stubs (inject before requiring matcher.js) ───────────────────────

// Stub luxon — matcher.js uses it only in the fmtIso helper.
// NOTE: require.resolve('luxon') will throw if node_modules is absent.
// Run `npm install` first, then these stubs override the real module.
const luxonPath = require.resolve('luxon');
require.cache[luxonPath] = {
  exports: {
    DateTime: {
      fromISO: () => ({ toFormat: () => '14/03/2026 10:00:00' }),
    },
  },
};

const logCalls = { info: [], error: [] };
require.cache[require.resolve('../src/logger')] = {
  exports: {
    info:  (...a) => logCalls.info.push(a),
    warn:  () => {},
    error: (...a) => logCalls.error.push(a),
  },
};

const dbStub = {
  _rpcError:        null,
  _rpcResult:       null,
  _updatedResult:   null,
  insertEvent:      async () => {},
  updateEventResult: async (_id, result) => { dbStub._updatedResult = result; },
  insertReview:     async () => {},
  getAllInWorkshop: async () => [],
};
require.cache[require.resolve('../src/db')] = { exports: dbStub };

const syncCalls = { logResult: [], dashboard: [] };
require.cache[require.resolve('../src/sheets-sync')] = {
  exports: {
    syncLogInsert:    () => {},
    syncLogResult:    (_id, result) => syncCalls.logResult.push(result),
    syncReviewInsert: () => {},
    syncVehicleIn:    () => {},
    syncVehicleOut:   () => {},
    syncDashboard:    (config) => syncCalls.dashboard.push(config),
  },
};

// utils — minimal stub (avoids luxon/crypto dependency in tests)
require.cache[require.resolve('../src/utils')] = {
  exports: {
    nowFormatted:       () => '14/03/2026 10:00:00',
    generateEventId:    () => 'SK-TEST-0001',
    generateVehicleId:  () => 'LX-TEST-0001',
    generateErrorId:    () => 'ERR-TEST-0001',
    confidenceLabel:    () => 'Ro',
    isValidVietnamPlate: (p) => /^\d{2}[A-Z]-\d{4,5}$/.test(p),
    formatDuration:     (m) => `${m} phut`,
    hoursSince:         () => 1,
    formatHours:        () => '1h',
    findSimilarPlate:   () => null,
  },
};

const { processVehicleEvent } = require('../src/matcher');

// ── Shared test config ────────────────────────────────────────────────────────

const baseConfig = {
  timezone: 'Asia/Ho_Chi_Minh',
  alerts:   { minWorkshopMinutes: 3, warningHours: 24, urgentHours: 48 },
  ocr:      { confidenceHigh: 0.8, confidenceMedium: 0.5 },
};

const goodEvent = {
  messageId: 'chat1_msg1',
  senderId:  'user1',
  senderName: 'Guard A',
  imageUrl:  'http://img/1.jpg',
  ocrResult: { plateText: '30A-12345', confidence: 0.9 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('matcher.processVehicleEvent — RPC failure hardening', () => {
  beforeEach(() => {
    dbStub._rpcError      = null;
    dbStub._rpcResult     = null;
    dbStub._updatedResult = null;
    logCalls.info.length  = 0;
    logCalls.error.length = 0;
    syncCalls.logResult.length = 0;
    syncCalls.dashboard.length = 0;
    dbStub.insertEvent = async () => {};
    dbStub.processVehicleDecision = async () => {
      if (dbStub._rpcError) throw new Error(dbStub._rpcError);
      return dbStub._rpcResult;
    };
  });

  it('returns a retry reply when RPC throws', async () => {
    dbStub._rpcError = 'deadlock detected';

    const result = await processVehicleEvent(goodEvent, baseConfig);

    assert.equal(result.success, false);
    assert.match(result.replyMessage, /Vui lòng gửi lại ảnh/);
    assert.match(result.replyMessage, /30A-12345/);
    assert.deepEqual(syncCalls.dashboard, [], 'failed decisions must not refresh the success dashboard');
  });

  it('marks event as error state in DB when RPC throws', async () => {
    dbStub._rpcError = 'connection timeout';

    await processVehicleEvent(goodEvent, baseConfig);

    assert.equal(dbStub._updatedResult, 'Loi he thong - RPC that bai');
  });

  it('syncs error result to sheets when RPC throws', async () => {
    dbStub._rpcError = 'connection timeout';

    await processVehicleEvent(goodEvent, baseConfig);

    assert.ok(syncCalls.logResult.includes('Loi he thong - RPC that bai'));
  });

  it('logs error with eventId, plate, and error message when RPC throws', async () => {
    dbStub._rpcError = 'connection timeout';

    await processVehicleEvent(goodEvent, baseConfig);

    const errLog = logCalls.error.find(([msg]) => msg === 'processVehicleDecision RPC failed');
    assert.ok(errLog, 'should log processVehicleDecision RPC failed');
    assert.equal(errLog[1].plate, '30A-12345');
    assert.match(errLog[1].error, /connection timeout/);
  });

  it('RA_DUPLICATE log includes minWorkshopMinutes', async () => {
    dbStub._rpcResult = {
      action: 'RA_DUPLICATE',
      vehicle_id: 'LX-001',
      time_in_ts: new Date().toISOString(),
      seconds_in: 45,
    };

    await processVehicleEvent(goodEvent, baseConfig);

    const dupLog = logCalls.info.find(([msg]) => msg === 'RA rejected - vehicle just entered');
    assert.ok(dupLog, 'should log RA_DUPLICATE');
    assert.equal(dupLog[1].minWorkshopMinutes, 3);
    assert.equal(dupLog[1].secondsInWorkshop, 45);
  });

  it('uses explicit nonzero and zero minWorkshopMinutes without a fallback override', async () => {
    // A falsy zero is the case that would expose an accidental `|| 15` fallback.
    for (const minutes of [5, 0]) {
      const config = { ...baseConfig, alerts: { ...baseConfig.alerts, minWorkshopMinutes: minutes } };
      let capturedSecs;
      dbStub.processVehicleDecision = async (_plate, _vid, _now, _img, secs) => {
        capturedSecs = secs;
        return { action: 'VAO', vehicle_id: 'LX-X', time_in_ts: new Date().toISOString(), seconds_in: 0 };
      };

      await processVehicleEvent(goodEvent, config);

      assert.equal(capturedSecs, minutes * 60, `must preserve the explicit ${minutes}-minute setting`);
    }
    assert.equal(syncCalls.dashboard.length, 2);
  });
});

// ── Nested failure: updateEventResult throws inside RPC error path ────────────

describe('matcher.processVehicleEvent — nested failure in RPC error path', () => {
  beforeEach(() => {
    logCalls.info.length  = 0;
    logCalls.error.length = 0;
    syncCalls.logResult.length = 0;
    syncCalls.dashboard.length = 0;
    dbStub.insertEvent = async () => {};
    // Default: RPC always fails, updateEventResult succeeds
    dbStub.processVehicleDecision = async () => { throw new Error('deadlock'); };
    dbStub.updateEventResult = async () => {};
  });

  it('guard still gets retry reply when updateEventResult throws', async () => {
    dbStub.updateEventResult = async () => { throw new Error('DB write failed'); };

    const result = await processVehicleEvent(goodEvent, baseConfig);

    assert.equal(result.success, false);
    assert.match(result.replyMessage, /Vui lòng gửi lại ảnh/);
    assert.match(result.replyMessage, /30A-12345/);
  });

  it('logs secondary write failure with eventId and plate when updateEventResult throws', async () => {
    dbStub.updateEventResult = async () => { throw new Error('connection refused'); };

    await processVehicleEvent(goodEvent, baseConfig);

    const writeErrLog = logCalls.error.find(
      ([msg]) => msg === 'updateEventResult failed during RPC error path'
    );
    assert.ok(writeErrLog, 'must log the secondary write failure');
    assert.equal(writeErrLog[1].plate, '30A-12345');
    assert.match(writeErrLog[1].error, /connection refused/);
  });

  it('sheets syncLogResult is still called when updateEventResult throws', async () => {
    dbStub.updateEventResult = async () => { throw new Error('DB write failed'); };

    await processVehicleEvent(goodEvent, baseConfig);

    assert.ok(
      syncCalls.logResult.includes('Loi he thong - RPC that bai'),
      'sheets sync must still be triggered for best-effort mirror'
    );
  });

  it('guard reply is returned even if both RPC and DB error-state write fail', async () => {
    // Simulate total DB outage: RPC fails AND error-state write fails
    dbStub.processVehicleDecision = async () => { throw new Error('DB unavailable'); };
    dbStub.updateEventResult = async () => { throw new Error('DB unavailable'); };

    const result = await processVehicleEvent(goodEvent, baseConfig);

    // Guard must still receive a reply — never silent failure
    assert.equal(result.success, false);
    assert.ok(result.replyMessage, 'replyMessage must not be empty');
  });

  it('normal RPC+write success path is unaffected', async () => {
    // Confirm the happy path still works after the nested try/catch was added
    dbStub.processVehicleDecision = async () => ({
      action: 'VAO', vehicle_id: 'LX-001', time_in_ts: new Date().toISOString(), seconds_in: 0,
    });
    dbStub.updateEventResult = async () => {};

    const result = await processVehicleEvent(goodEvent, baseConfig);

    assert.equal(result.success, true);
    assert.match(result.replyMessage, /VÀO xưởng/);
    assert.deepEqual(syncCalls.dashboard, [baseConfig]);
  });
});
