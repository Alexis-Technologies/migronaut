const { EventEmitter } = require('node:events');
const { mock } = require('node:test');

/** A logger that records nothing — the kit-shaped equivalent of `logger: null` */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A stand-in MigratorKit for the queue adapter's unit tests: an emitter with
 * the handful of methods the adapter calls, each a `mock.fn` so calls can be
 * asserted. `up`/`down` emit the lifecycle events a real run would, so what
 * the adapter forwards to a job can be checked without a database.
 */
function stubKit(overrides = {}) {
  const kit = new EventEmitter();
  const run = (direction, status) =>
    mock.fn(async (name, options = {}) => {
      kit.emit('run:start', { runId: 'run-1', command: direction });
      kit.emit('lock:acquired', { runId: 'run-1', acquireMs: 2 });
      kit.emit('migration:start', { migration: name, direction });
      kit.emit('migration:success', { migration: name, direction, durationMs: 5 });
      return [
        {
          file: name,
          status,
          duration: 5,
          ...(options.batch !== undefined ? { batch: options.batch } : {}),
        },
      ];
    });
  Object.assign(kit, {
    logger: silentLogger,
    connect: mock.fn(async () => {}),
    disconnect: mock.fn(async () => {}),
    stop: mock.fn(),
    list: mock.fn(async () => []),
    status: mock.fn(async () => []),
    audit: mock.fn(async () => ({ ok: true, failed: 0, warnings: 0, checks: [] })),
    lockInfo: mock.fn(async () => null),
    dryRun: mock.fn(async () => []),
    nextBatch: mock.fn(async () => 1),
    up: run('up', 'applied'),
    down: run('down', 'reverted'),
    ...overrides,
  });
  return kit;
}

module.exports = { silentLogger, stubKit };
