const { setTimeout: sleep } = require('node:timers/promises');

/**
 * Poll `check` until it returns a truthy value, and return that value — the one
 * wait every polling test shares. Past `timeoutMs` it rejects naming `what`,
 * with `explain(lastValue)` after it when given: a wait that timed out says
 * where it was stuck.
 */
const waitFor = async (what, check, { timeoutMs = 10_000, intervalMs = 20, explain } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      const detail = explain === undefined ? '' : ` — ${explain(value)}`;
      throw new Error(`timed out waiting for ${what}${detail}`);
    }
    await sleep(intervalMs);
  }
};

module.exports = { sleep, waitFor };
