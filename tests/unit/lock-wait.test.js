const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  assertLockWaitOptions,
  jitteredDelay,
  withLockWait,
} = require('../../src/core/lock-wait.js');
const {
  ConfigInvalidError,
  LockAlreadyHeldError,
  LockLostError,
  RunAbortedError,
} = require('../../src/errors/index.js');

/** A refusal as lock.js produces it — the holder's lockedAt is what the wait loop watches */
const held = (lockedAt = new Date(0)) =>
  new LockAlreadyHeldError('Migration lock is already held', { holder: { lockedAt } });

/** An attempt that is refused `refusals` times, then succeeds */
function refusedThenFree(refusals, makeError = () => held()) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= refusals) throw makeError(calls);
    return 'done';
  };
}

const fast = { onLockHeld: 'wait', lockPollIntervalMs: 2, lockWaitTimeoutMs: 1000 };

describe('withLockWait', () => {
  it('should return the first attempt untouched when the lock is free', async () => {
    const outcome = await withLockWait(async () => 'done', fast);
    assert.deepStrictEqual(outcome, { result: 'done', waited: false, waitedMs: 0, attempts: 1 });
  });

  it('should hand the attempt number to the attempt', async () => {
    const seen = [];
    await withLockWait(async (attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw held();
    }, fast);
    assert.deepStrictEqual(seen, [1, 2, 3]);
  });

  it('should poll again while the lock is held, then report how long it waited', async () => {
    const outcome = await withLockWait(refusedThenFree(2), fast);
    assert.strictEqual(outcome.result, 'done');
    assert.strictEqual(outcome.waited, true);
    assert.strictEqual(outcome.attempts, 3);
    assert.ok(outcome.waitedMs >= 2, 'two sleeps of at least 1ms each were planned');
  });

  it("should rethrow the refusal at once under onLockHeld: 'throw' (the default)", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      throw held();
    };
    await assert.rejects(withLockWait(attempt), LockAlreadyHeldError);
    await assert.rejects(withLockWait(attempt, { onLockHeld: 'throw' }), LockAlreadyHeldError);
    assert.strictEqual(calls, 2);
  });

  it('should rethrow anything that is not lock contention without retrying', async () => {
    let calls = 0;
    const boom = new Error('boom');
    await assert.rejects(
      withLockWait(async () => {
        calls += 1;
        throw boom;
      }, fast),
      (error) => error === boom,
    );
    assert.strictEqual(calls, 1);
  });

  it('should give up with the original refusal once a stalled holder outlasts the budget', async () => {
    let calls = 0;
    const started = Date.now();
    await assert.rejects(
      withLockWait(
        async () => {
          calls += 1;
          throw held();
        },
        { onLockHeld: 'wait', lockPollIntervalMs: 5, lockWaitTimeoutMs: 40 },
      ),
      LockAlreadyHeldError,
    );
    assert.ok(calls > 1, 'it polled before giving up');
    assert.ok(Date.now() - started < 1000, 'the budget bounded the wait');
  });

  it("should re-arm the budget while the holder's heartbeat advances", async () => {
    // Each refusal reports a newer lockedAt — a live, progressing peer. A
    // budget shorter than the total wait must therefore NOT run out.
    const attempt = refusedThenFree(8, (call) => held(new Date(call * 1000)));
    const outcome = await withLockWait(attempt, {
      onLockHeld: 'wait',
      lockPollIntervalMs: 10,
      lockWaitTimeoutMs: 25,
    });
    assert.strictEqual(outcome.attempts, 9);
  });

  it('should tolerate a refusal that carries no holder', async () => {
    const attempt = refusedThenFree(1, () => new LockAlreadyHeldError('held'));
    const outcome = await withLockWait(attempt, fast);
    assert.strictEqual(outcome.attempts, 2);
  });

  it('should log the first wait at info and every poll at debug', async () => {
    const lines = { info: [], debug: [] };
    const logger = {
      info: (msg) => lines.info.push(msg),
      debug: (msg, fields) => lines.debug.push(fields),
    };
    await withLockWait(refusedThenFree(2), { ...fast, logger });
    assert.strictEqual(lines.info.length, 1);
    assert.match(lines.info[0], /waiting/);
    assert.strictEqual(lines.debug.length, 2);
    assert.deepStrictEqual(Object.keys(lines.debug[0]), ['attempts', 'waitedMs', 'nextDelayMs']);
  });

  it('should report each wait through onWait, holder included', async () => {
    const waits = [];
    const lockedAt = new Date(5);
    await withLockWait(
      refusedThenFree(2, () => held(lockedAt)),
      { ...fast, onWait: (info) => waits.push(info) },
    );
    assert.strictEqual(waits.length, 2);
    assert.strictEqual(waits[0].attempts, 1);
    assert.strictEqual(waits[0].waitedMs, 0);
    assert.strictEqual(waits[0].holder.lockedAt, lockedAt);
    assert.ok(waits[1].waitedMs > 0);
  });

  describe('abort signal', () => {
    it('should not start an attempt when already aborted', async () => {
      let calls = 0;
      await assert.rejects(
        withLockWait(
          async () => {
            calls += 1;
          },
          { ...fast, signal: AbortSignal.abort('shutting down') },
        ),
        (error) => {
          assert.ok(error instanceof RunAbortedError);
          assert.strictEqual(error.context.reason, 'shutting down');
          return true;
        },
      );
      assert.strictEqual(calls, 0);
    });

    it('should interrupt the sleep between attempts', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = withLockWait(
        async () => {
          throw held();
        },
        { onLockHeld: 'wait', lockPollIntervalMs: 5000, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.strictEqual(error.context.attempts, 1);
        return true;
      });
      assert.ok(Date.now() - started < 2000, 'the 5s poll sleep was cut short');
    });

    it("should reject with the signal's own typed reason when it has one", async () => {
      const reason = new LockLostError('lost');
      await assert.rejects(
        withLockWait(async () => 'never', { ...fast, signal: AbortSignal.abort(reason) }),
        (error) => error === reason,
      );
    });

    it('should describe an abort that carries no reason', async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        withLockWait(async () => 'never', { ...fast, signal: controller.signal }),
        RunAbortedError,
      );
    });
  });
});

describe('assertLockWaitOptions', () => {
  it('should accept the defaults and explicit positive numbers', () => {
    assertLockWaitOptions();
    assertLockWaitOptions({});
    assertLockWaitOptions({ lockWaitTimeoutMs: 1, lockPollIntervalMs: 0.5 });
    assert.ok(DEFAULT_LOCK_WAIT_TIMEOUT_MS > DEFAULT_LOCK_POLL_INTERVAL_MS);
  });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, '500', null]) {
    it(`should reject ${String(value)} for either budget, naming the option`, () => {
      assert.throws(
        () => assertLockWaitOptions({ lockWaitTimeoutMs: value }),
        (error) =>
          error instanceof ConfigInvalidError && Object.hasOwn(error.context, 'lockWaitTimeoutMs'),
      );
      assert.throws(
        () => assertLockWaitOptions({ lockPollIntervalMs: value }),
        (error) =>
          error instanceof ConfigInvalidError && Object.hasOwn(error.context, 'lockPollIntervalMs'),
      );
    });
  }
});

describe('jitteredDelay', () => {
  it('should stay within ±25% of the base and never drop below 1ms', () => {
    for (let run = 0; run < 200; run++) {
      const value = jitteredDelay(100);
      assert.ok(value >= 75 && value <= 125, `out of range: ${value}`);
    }
    assert.ok(jitteredDelay(0.1) >= 1);
  });
});
