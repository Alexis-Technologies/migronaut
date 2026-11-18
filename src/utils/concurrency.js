/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result.
 *
 * `Promise.all` over a whole list starts everything at once. For per-file
 * reads that means thousands of simultaneous open descriptors (EMFILE) once a
 * project has thousands of migrations; for writes it means an unbounded fan-out
 * at one connection pool. Failures still reject on the first error, matching
 * `Promise.all` — the point here is pacing, not error handling.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = [];
  for (let i = 0; i < width; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Wait for `promise` to settle — fulfilled or rejected, it does not matter
 * which — for at most `ms`. Resolves to whether it did; never rejects.
 *
 * For a wait that must not outlast its use: a best-effort write to a service
 * that is away (a job's log row, with a Redis that queues commands without a
 * limit) would otherwise hold whatever comes after it for as long as the
 * outage lasts. The promise itself goes on; only the wait ends.
 */
async function settledWithin(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { mapLimit, settledWithin };
