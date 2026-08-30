const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runMigrations } = require('../../src/core/run.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');

/**
 * Every rejection below must happen *before* anything connects — a NaN
 * interval used to turn the lock-wait loop into an unbounded tight retry
 * (`Math.max(1, NaN)` is NaN, and `NaN > deadline` is always false), so these
 * tests double as proof the validation runs up front.
 */
const config = { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null };

describe('runMigrations option validation', () => {
  const badNumbers = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative number', -5],
    ['a string', '500'],
    ['null', null],
  ];

  for (const [label, value] of badNumbers) {
    it(`should reject ${label} as lockWaitTimeoutMs before connecting`, async () => {
      await assert.rejects(runMigrations(config, { lockWaitTimeoutMs: value }), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.ok(Object.hasOwn(error.context, 'lockWaitTimeoutMs'));
        return true;
      });
    });

    it(`should reject ${label} as lockPollIntervalMs before connecting`, async () => {
      await assert.rejects(runMigrations(config, { lockPollIntervalMs: value }), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.ok(Object.hasOwn(error.context, 'lockPollIntervalMs'));
        return true;
      });
    });
  }
});

describe('runMigrations onKit validation', () => {
  it('should reject a non-function onKit before connecting', async () => {
    await assert.rejects(runMigrations(config, { onKit: 'listen' }), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.match(error.message, /onKit/);
      return true;
    });
  });
});
