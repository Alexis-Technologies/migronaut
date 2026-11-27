/**
 * One real turn of the loop: every promise callback queued so far runs. Tests
 * that mock `setTimeout`/`setInterval` leave `setImmediate` real for this.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Drive mocked timers forward in `stepMs` steps, flushing between them so an
 * async timer callback (a lock renewal awaiting its mock database) settles
 * before the next tick — until `promise` settles, or `maxMs` of mocked time
 * passed. Returns (or rejects with) what `promise` did.
 */
const settleWithTimers = async (timers, promise, { stepMs = 10, maxMs = 10_000 } = {}) => {
  let isSettled = false;
  const tracked = promise.finally(() => {
    isSettled = true;
  });
  // Handled at the end; a rejection meanwhile is not an unhandled one.
  tracked.catch(() => undefined);
  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    // Set by the promise, between two ticks.
    if (isSettled) return tracked;
    timers.tick(stepMs);
    await flush();
  }
  if (isSettled) return tracked;
  throw new Error(`still pending after ${maxMs} ms of mocked time`);
};

module.exports = { flush, settleWithTimers };
