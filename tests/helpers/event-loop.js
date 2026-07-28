/**
 * Hold the event loop open until the returned function is called.
 *
 * Needed by the handful of unit tests whose awaited promise can only settle
 * from an `unref()`ed timer — the migration timeout in `runner.js` and the lock
 * heartbeat/deadline in `lock.js`. Those `unref()` calls are deliberate: neither
 * timer should be the reason a process stays alive. In production that costs
 * nothing, because an open MongoClient keeps its own sockets ref'd for the whole
 * run. In these tests the driver is a plain mock object, so the unref'ed timer
 * is the *only* pending handle: the loop drains, and Node's test runner cancels
 * the test with "Promise resolution is still pending but the event loop has
 * already resolved" — taking the rest of the file's suite with it.
 *
 * Node 24 happens to keep the loop alive here and Node 22 does not, so without
 * this the suite passes locally and fails on the engines floor.
 *
 * @returns {() => void} releases the loop; safe to call more than once
 */
function keepEventLoopAlive() {
  // A long ref'd timer is enough: any ref'd handle stops the loop draining.
  const handle = setTimeout(() => {}, 60_000);
  return () => clearTimeout(handle);
}

module.exports = { keepEventLoopAlive };
