'use strict';

/**
 * Tests for sheets-sync.js (WRITE-ONLY mirror)
 *
 * Core guarantee: ALL functions are fire-and-forget.
 * Errors from Sheets MUST be swallowed and logged — never propagated.
 * No Sheets READ operations — DB is source of truth.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockSheets = {
  appendMainRow:           async () => {},
  appendLogRow:            async () => {},
  appendReviewRow:         async () => {},
  archiveCompletedVehicle: async () => {},
  deleteMainRow:           async () => {},
  batchUpdatePriorities:   async () => {},
};

let lastLoggedError = null;
const mockLogger = {
  info:  () => {},
  warn:  () => {},
  error: (_msg, meta) => { lastLoggedError = meta; },
};
const dashboardCalls = [];
const mockDashboard = {
  refreshDashboard: async (config) => { dashboardCalls.push(config); },
};

before(() => {
  require.cache[require.resolve('../src/sheets')] = { exports: mockSheets };
  require.cache[require.resolve('../src/logger')] = { exports: mockLogger };
  require.cache[require.resolve('../src/sheets-dashboard')] = { exports: mockDashboard };
});

after(() => {
  delete require.cache[require.resolve('../src/sheets-sync')];
  delete require.cache[require.resolve('../src/sheets')];
  delete require.cache[require.resolve('../src/logger')];
  delete require.cache[require.resolve('../src/sheets-dashboard')];
});

const sheetsSync = require('../src/sheets-sync');

function tick(ms = 20) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('sheets-sync — fire-and-forget guarantee', () => {
  beforeEach(() => {
    lastLoggedError = null;
    mockSheets.appendMainRow           = async () => {};
    mockSheets.appendLogRow            = async () => {};
    mockSheets.appendReviewRow         = async () => {};
    mockSheets.archiveCompletedVehicle = async () => {};
    mockSheets.deleteMainRow           = async () => {};
    mockSheets.batchUpdatePriorities   = async () => {};
    dashboardCalls.length = 0;
    mockDashboard.refreshDashboard = async (config) => { dashboardCalls.push(config); };
  });

  it('syncVehicleIn — returns undefined synchronously (fire-and-forget)', () => {
    const result = sheetsSync.syncVehicleIn({ vehicleId: 'LX-001', plate: '30A-12345' });
    assert.equal(result, undefined);
  });

  it('syncVehicleIn — does not throw when sheets succeeds', async () => {
    sheetsSync.syncVehicleIn({ vehicleId: 'LX-001', plate: '30A-12345' });
    await tick();
    assert.equal(lastLoggedError, null);
  });

  it('syncVehicleIn — avoids an append that the dashboard rewrite would replace', async () => {
    let appendCalls = 0;
    mockSheets.appendMainRow = async () => { appendCalls++; };

    sheetsSync.syncVehicleIn({ vehicleId: 'LX-002', plate: '51F1-99999' });
    await tick();

    assert.equal(appendCalls, 0, 'new entries must be rendered by the dashboard, not appended twice');
    assert.equal(lastLoggedError, null);
  });

  it('syncLogInsert — swallows sheets error', async () => {
    mockSheets.appendLogRow = async () => { throw new Error('Quota exceeded'); };

    sheetsSync.syncLogInsert({ eventId: 'SK-001' });
    await tick();

    assert.ok(lastLoggedError, 'error must be logged');
    assert.ok(lastLoggedError.error.includes('Quota exceeded'));
  });

  it('syncLogResult — is a no-op (log is append-only)', async () => {
    sheetsSync.syncLogResult('SK-001', 'VAO: 30A-12345');
    await tick();
    assert.equal(lastLoggedError, null);
  });

  it('syncReviewInsert — swallows sheets error', async () => {
    mockSheets.appendReviewRow = async () => { throw new Error('Auth expired'); };

    sheetsSync.syncReviewInsert({ errorId: 'ERR-001' });
    await tick();

    assert.ok(lastLoggedError);
  });

  it('syncVehicleOut — archives vehicle (write-only, no reads)', async () => {
    let archiveCalled = false;
    mockSheets.archiveCompletedVehicle = async (rowData) => {
      archiveCalled = true;
      assert.equal(rowData.plate, '30A-12345');
      assert.equal(rowData.status, 'Đã ra xưởng');
    };

    sheetsSync.syncVehicleOut('30A-12345', 'LX-001', {
      status: 'Đã ra xưởng',
      timeOut: '08/03/2026 10:00:00',
    });
    await tick();

    assert.ok(archiveCalled, 'archiveCompletedVehicle must be called');
    assert.equal(lastLoggedError, null);
  });

  it('syncVehicleOut — swallows archive error', async () => {
    mockSheets.archiveCompletedVehicle = async () => { throw new Error('API error'); };

    sheetsSync.syncVehicleOut('30A-12345', 'LX-001', { status: 'Đã ra xưởng' });
    await tick();

    assert.ok(lastLoggedError);
  });

  it('syncVehiclePriority — is a no-op (batch handles this)', async () => {
    sheetsSync.syncVehiclePriority('30A-12345', 'Khẩn', new Date().toISOString());
    await tick();
    assert.equal(lastLoggedError, null);
  });

  it('syncPrioritiesBatch — leaves priority cells to the full dashboard rewrite', async () => {
    let batchCalls = 0;
    mockSheets.batchUpdatePriorities = async () => { batchCalls++; };

    sheetsSync.syncPrioritiesBatch([
      { plate: '30A-111', priority: 'Khẩn', updatedAt: '2026-03-28' },
      { plate: '30A-222', priority: 'Cảnh báo', updatedAt: '2026-03-28' },
    ]);
    await tick();

    assert.equal(batchCalls, 0, 'a separate priority write would be overwritten by the dashboard');
    assert.equal(lastLoggedError, null);
  });

  it('syncDashboard — coalesces pending refreshes and uses the latest config', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const first = { timezone: 'UTC' };
    const latest = { timezone: 'Asia/Ho_Chi_Minh' };

    assert.equal(sheetsSync.syncDashboard(first), undefined);
    sheetsSync.syncDashboard(latest);
    t.mock.timers.tick(29_999);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dashboardCalls, [], 'must not refresh before the throttle window');

    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dashboardCalls, [latest]);
    assert.ok(sheetsSync.getDashboardHealth() instanceof Date);
    assert.equal(lastLoggedError, null);

    sheetsSync.syncDashboard(first);
    t.mock.timers.tick(30_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dashboardCalls, [latest, first], 'a completed refresh must not block the next window');
  });

  it('syncDashboard — logs refresh failure without advancing successful health', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    sheetsSync.syncDashboardImmediate({ timezone: 'UTC' });
    await new Promise(resolve => setImmediate(resolve));
    const lastSuccess = sheetsSync.getDashboardHealth();
    assert.ok(lastSuccess instanceof Date);
    mockDashboard.refreshDashboard = async () => { throw new Error('Dashboard write failed'); };

    sheetsSync.syncDashboard({ timezone: 'Asia/Ho_Chi_Minh' });
    t.mock.timers.tick(30_000);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(lastLoggedError.context, 'dashboard-refresh');
    assert.match(lastLoggedError.error, /Dashboard write failed/);
    assert.equal(sheetsSync.getDashboardHealth(), lastSuccess, 'a failure must not look like fresh reporting');
  });

  it('syncDashboardImmediate — cancels pending refresh and uses immediate config', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = { timezone: 'UTC' };
    const immediate = { timezone: 'Asia/Ho_Chi_Minh' };
    sheetsSync.syncDashboard(pending);
    assert.equal(sheetsSync.syncDashboardImmediate(immediate), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dashboardCalls, [immediate]);

    t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dashboardCalls, [immediate], 'cancelled pending work must not duplicate the immediate refresh');
    assert.equal(lastLoggedError, null);
  });
});
