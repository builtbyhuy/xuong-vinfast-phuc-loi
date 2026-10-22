'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const {
  normalizePlate,
  isValidVietnamPlate,
  parseMessage,
  calcMinutesBetween,
  confidenceLabel,
  generateVehicleId,
  generateEventId,
  generateErrorId,
  formatDuration,
  TEXT_ONLY_ACTIONS,
} = require('../src/utils');

// ──────────────────────────────────────────────
// Test: normalizePlate
// ──────────────────────────────────────────────

describe('normalizePlate', () => {
  it('chuan hoa bien so co ban', () => {
    assert.equal(normalizePlate('30A 12345'), '30A-12345');
    assert.equal(normalizePlate('30a-12345'), '30A-12345');
    assert.equal(normalizePlate(' 51F1 99999 '), '51F1-99999');
  });

  it('xu ly ky tu dac biet', () => {
    assert.equal(normalizePlate('30A.123.45'), '30A-12345');
    assert.equal(normalizePlate('30A-123-45'), '30A-12345');
  });

  it('tra ve empty string cho input rong', () => {
    assert.equal(normalizePlate(''), '');
    assert.equal(normalizePlate(null), '');
    assert.equal(normalizePlate(undefined), '');
  });
});

// ──────────────────────────────────────────────
// Test: isValidVietnamPlate
// ──────────────────────────────────────────────

describe('isValidVietnamPlate', () => {
  it('chap nhan bien xe con', () => {
    assert.equal(isValidVietnamPlate('30A-12345'), true);
    assert.equal(isValidVietnamPlate('51F1-99999'), true);
    assert.equal(isValidVietnamPlate('98A1-12345'), true);
  });

  it('chap nhan bien khong co gach ngang', () => {
    assert.equal(isValidVietnamPlate('30A12345'), true);
  });

  it('tu choi bien sai format', () => {
    assert.equal(isValidVietnamPlate('ABC123'), false);
    assert.equal(isValidVietnamPlate('1A-123'), false);
    assert.equal(isValidVietnamPlate(''), false);
    assert.equal(isValidVietnamPlate(null), false);
  });
});

// ──────────────────────────────────────────────
// Test: parseMessage - TONKHO
// ──────────────────────────────────────────────

describe('parseMessage - TONKHO', () => {
  it('nhan dien TONKHO', () => {
    assert.equal(parseMessage('TONKHO').action, 'TONKHO');
  });

  it('nhan dien tonkho (lowercase)', () => {
    assert.equal(parseMessage('tonkho').action, 'TONKHO');
  });

  it('nhan dien TON KHO (co dau cach)', () => {
    assert.equal(parseMessage('TON KHO').action, 'TONKHO');
  });

  it('nhan dien "ton kho" voi dau tieng Viet', () => {
    assert.equal(parseMessage('tồn kho').action, 'TONKHO');
  });
});

// ──────────────────────────────────────────────
// Test: parseMessage - HELP
// ──────────────────────────────────────────────

describe('parseMessage - HELP', () => {
  it('nhan dien HELP', () => {
    assert.equal(parseMessage('HELP').action, 'HELP');
  });

  it('nhan dien help (lowercase)', () => {
    assert.equal(parseMessage('help').action, 'HELP');
  });

  it('nhan dien HUONGDAN', () => {
    assert.equal(parseMessage('HUONGDAN').action, 'HELP');
  });

  it('nhan dien HUONG DAN (co dau cach)', () => {
    assert.equal(parseMessage('HUONG DAN').action, 'HELP');
  });

  it('nhan dien "huong dan" voi dau tieng Viet', () => {
    assert.equal(parseMessage('hướng dẫn').action, 'HELP');
  });
});

// ──────────────────────────────────────────────
// Test: parseMessage - BAOCAO
// ──────────────────────────────────────────────

describe('parseMessage - BAOCAO', () => {
  it('nhan dien BAOCAO', () => {
    assert.equal(parseMessage('BAOCAO').action, 'BAOCAO');
  });

  it('nhan dien baocao (lowercase)', () => {
    assert.equal(parseMessage('baocao').action, 'BAOCAO');
  });

  it('nhan dien BAO CAO (co dau cach)', () => {
    assert.equal(parseMessage('BAO CAO').action, 'BAOCAO');
  });

  it('nhan dien "bao cao" voi dau tieng Viet (bug case)', () => {
    assert.equal(parseMessage('báo cáo').action, 'BAOCAO');
  });

  it('nhan dien "Báo Cáo" mixed case voi dau', () => {
    assert.equal(parseMessage('Báo Cáo').action, 'BAOCAO');
  });
});

// ──────────────────────────────────────────────
// Test: parseMessage - NANGSUAT
// ──────────────────────────────────────────────

describe('parseMessage - NANGSUAT', () => {
  it('nhan dien NANGSUAT', () => {
    assert.equal(parseMessage('NANGSUAT').action, 'NANGSUAT');
  });

  it('nhan dien nangsuat (lowercase)', () => {
    assert.equal(parseMessage('nangsuat').action, 'NANGSUAT');
  });

  it('nhan dien NANG SUAT (co dau cach)', () => {
    assert.equal(parseMessage('NANG SUAT').action, 'NANGSUAT');
  });

  it('nhan dien "nang suat" voi dau tieng Viet', () => {
    assert.equal(parseMessage('năng suất').action, 'NANGSUAT');
  });
});

// ──────────────────────────────────────────────
// Test: parseMessage - unknown text
// ──────────────────────────────────────────────

describe('parseMessage - unknown', () => {
  it('tra null cho text khong co tu khoa', () => {
    assert.equal(parseMessage('xin chao').action, null);
    assert.equal(parseMessage('').action, null);
    assert.equal(parseMessage(null).action, null);
  });
});

// ──────────────────────────────────────────────
// Test: TEXT_ONLY_ACTIONS
// ──────────────────────────────────────────────

describe('TEXT_ONLY_ACTIONS', () => {
  it('chua dung cac command text-only', () => {
    assert.ok(TEXT_ONLY_ACTIONS.includes('TONKHO'));
    assert.ok(TEXT_ONLY_ACTIONS.includes('HELP'));
    assert.ok(TEXT_ONLY_ACTIONS.includes('BAOCAO'));
    assert.ok(TEXT_ONLY_ACTIONS.includes('NANGSUAT'));
  });
});

// ──────────────────────────────────────────────
// Test: calcMinutesBetween
// ──────────────────────────────────────────────

describe('calcMinutesBetween', () => {
  it('tinh dung so phut', () => {
    assert.equal(calcMinutesBetween('12/02/2026 08:00:00', '12/02/2026 10:30:00'), 150);
  });

  it('tra empty string cho input invalid', () => {
    assert.equal(calcMinutesBetween('invalid', '12/02/2026 10:30:00'), '');
  });
});

// ──────────────────────────────────────────────
// Test: formatDuration
// ──────────────────────────────────────────────

describe('formatDuration', () => {
  it('format phut thuong', () => {
    assert.equal(formatDuration(30), '30 phut');
    assert.equal(formatDuration(0), '0 phut');
  });

  it('format gio + phut', () => {
    assert.equal(formatDuration(150), '2 gio 30 phut');
    assert.equal(formatDuration(60), '1 gio 0 phut');
  });

  it('format string number', () => {
    assert.equal(formatDuration('90'), '1 gio 30 phut');
  });

  it('tra empty string cho invalid', () => {
    assert.equal(formatDuration(''), '');
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(undefined), '');
  });
});

// ──────────────────────────────────────────────
// Test: confidenceLabel
// ──────────────────────────────────────────────

describe('confidenceLabel', () => {
  const thresholds = { confidenceHigh: 0.8, confidenceMedium: 0.5 };

  it('Ro khi confidence >= 0.8', () => {
    assert.equal(confidenceLabel(0.9, thresholds), 'Ro');
    assert.equal(confidenceLabel(0.8, thresholds), 'Ro');
  });

  it('Tam duoc khi 0.5 <= confidence < 0.8', () => {
    assert.equal(confidenceLabel(0.6, thresholds), 'Tam duoc');
    assert.equal(confidenceLabel(0.5, thresholds), 'Tam duoc');
  });

  it('Mo khi confidence < 0.5', () => {
    assert.equal(confidenceLabel(0.3, thresholds), 'Mo / khong chac');
    assert.equal(confidenceLabel(0, thresholds), 'Mo / khong chac');
  });
});

// ──────────────────────────────────────────────
// Test: ID generation
// ──────────────────────────────────────────────

describe('ID generation', () => {
  it('tao ID dung format', () => {
    const tz = 'Asia/Ho_Chi_Minh';
    assert.match(generateVehicleId(tz), /^LX-\d{12}-[A-F0-9]{32}$/);
    assert.match(generateEventId(tz), /^SK-\d{12}-[A-F0-9]{32}$/);
    assert.match(generateErrorId(tz), /^ERR-\d{12}-[A-F0-9]{32}$/);
  });

  for (const [prefix, generateId] of [
    ['LX', generateVehicleId],
    ['SK', generateEventId],
    ['ERR', generateErrorId],
  ]) {
    it(`${prefix}: distinguishes same-second IDs when the first two random bytes repeat`, (t) => {
      const fixedNow = DateTime.fromISO('2026-10-22T10:20:30+07:00');
      t.mock.method(DateTime, 'now', () => fixedNow);
      let sequence = 0;
      t.mock.method(crypto, 'randomBytes', (size) => {
        // Valid entropy samples share their first 16 bits but differ in the tail.
        // Respect the requested size: the old two-byte generator loses the tail.
        const sample = Buffer.from('A1B20000000000000000000000000000', 'hex');
        sample.writeUInt32BE(sequence++, 12);
        return sample.subarray(0, size);
      });

      const ids = Array.from({ length: 100 }, () => generateId('Asia/Ho_Chi_Minh'));
      assert.equal(new Set(ids).size, 100);
      assert.ok(ids.every(id => id.startsWith(`${prefix}-261022102030-`)));
    });
  }
});
