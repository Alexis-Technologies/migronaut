const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mapLimit } = require('../../src/utils/concurrency.js');

/** Resolve after a tick, so overlapping calls are actually observable */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('mapLimit', () => {
  it('should preserve input order in the results', async () => {
    const items = [5, 1, 4, 2, 3];
    const out = await mapLimit(items, 2, async (n) => {
      // Later items finish first, so ordering cannot come from completion order.
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 10;
    });
    assert.deepStrictEqual(out, [50, 10, 40, 20, 30]);
  });

  it('should never exceed the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.strictEqual(peak, 4);
  });

  it('should still run concurrently up to the limit', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    // Sanity check against a limiter that accidentally serializes everything.
    assert.strictEqual(peak, 3);
  });

  it('should pass the index to the mapper', async () => {
    const seen = await mapLimit(['a', 'b', 'c'], 2, async (item, index) => `${index}:${item}`);
    assert.deepStrictEqual(seen, ['0:a', '1:b', '2:c']);
  });

  it('should return an empty array for no items', async () => {
    let called = false;
    const out = await mapLimit([], 4, async () => {
      called = true;
    });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(called, false);
  });

  it('should not start more workers than there are items', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapLimit([1, 2], 16, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.strictEqual(peak, 2);
  });

  it('should reject on the first failure, like Promise.all', async () => {
    await assert.rejects(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
      /boom/,
    );
  });

  it('should treat a limit below 1 as serial rather than stalling', async () => {
    const out = await mapLimit([1, 2, 3], 0, async (n) => n * 2);
    assert.deepStrictEqual(out, [2, 4, 6]);
  });
});
