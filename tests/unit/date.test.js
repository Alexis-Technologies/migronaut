const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { formatDateTime, formatStamp } = require('../../src/utils/date.js');

describe('formatStamp', () => {
  it('should render a local-time compact timestamp with zero-padding', () => {
    // 2024-05-06 07:08:09 local time
    const date = new Date(2024, 4, 6, 7, 8, 9);
    assert.strictEqual(formatStamp(date), '20240506070809');
  });

  it('should not pad a four-digit year or two-digit parts', () => {
    const date = new Date(2024, 11, 31, 23, 59, 59);
    assert.strictEqual(formatStamp(date), '20241231235959');
  });
});

describe('formatDateTime', () => {
  it('should render a human-readable local-time timestamp', () => {
    const date = new Date(2024, 4, 6, 7, 8, 9);
    assert.strictEqual(formatDateTime(date), '2024-05-06 07:08:09');
  });

  it('should zero-pad single-digit month, day, and time parts', () => {
    const date = new Date(2024, 0, 1, 0, 0, 0);
    assert.strictEqual(formatDateTime(date), '2024-01-01 00:00:00');
  });
});
