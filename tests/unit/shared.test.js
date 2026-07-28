const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const {
  EXIT_CODES,
  attachSignalHandlers,
  exitCodeFor,
  partialFromOpts,
  resolveLevel,
} = require('../../src/cli/shared.js');
const { ConfigInvalidError, LockAlreadyHeldError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');

describe('partialFromOpts', () => {
  it('should map the CLI flags onto config keys', () => {
    const partial = partialFromOpts({
      uri: 'mongodb://x:27017',
      db: 'shop',
      dir: './migrations',
      strict: true,
    });
    assert.deepStrictEqual(partial, {
      uri: 'mongodb://x:27017',
      dbName: 'shop',
      migrationsDir: './migrations',
      strict: true,
    });
  });

  it('should omit keys for absent flags instead of writing undefined', () => {
    // An `undefined` value would still be an own key and shadow the config
    // file's value in the merge.
    assert.deepStrictEqual(partialFromOpts({}), {});
  });

  it('should let --no-env win over --env-file', () => {
    const partial = partialFromOpts({ env: false, envFile: '.env.ci' });
    assert.strictEqual(partial.envFile, false);
  });

  it('should pass --env-file through when --no-env is absent', () => {
    assert.strictEqual(partialFromOpts({ envFile: '.env.ci' }).envFile, '.env.ci');
  });
});

describe('exitCodeFor', () => {
  it('should map a typed error to its dedicated code', () => {
    assert.strictEqual(exitCodeFor(new LockAlreadyHeldError('held')), 3);
    assert.strictEqual(exitCodeFor(new ConfigInvalidError('bad')), 6);
  });

  it('should collapse a non-Migronaut error to 1', () => {
    assert.strictEqual(exitCodeFor(new Error('boom')), 1);
    assert.strictEqual(exitCodeFor('string failure'), 1);
  });
});

describe('resolveLevel', () => {
  it('should map the verbosity flags to logger levels', () => {
    assert.strictEqual(resolveLevel({}), 'info');
    assert.strictEqual(resolveLevel({ verbose: true }), 'debug');
    assert.strictEqual(resolveLevel({ quiet: true }), 'error');
  });

  it('should let --verbose win when both flags are passed', () => {
    // The operator asking for more output and less output at once gets more —
    // debugging is the likelier intent.
    assert.strictEqual(resolveLevel({ verbose: true, quiet: true }), 'debug');
  });
});

describe('EXIT_CODES', () => {
  it('should reserve 0 and 1 and use distinct codes', () => {
    const values = Object.values(EXIT_CODES);
    assert.ok(values.every((value) => value >= 2));
    assert.strictEqual(new Set(values).size, values.length);
  });

  it('should give the idempotency cases their own codes', () => {
    // "already initialized" / "already imported" must be distinguishable from
    // a crash without parsing stderr — that is what typed exit codes are for.
    assert.strictEqual(typeof EXIT_CODES.CONFIG_FILE_EXISTS, 'number');
    assert.strictEqual(typeof EXIT_CODES.IMPORT_TARGET_NOT_EMPTY, 'number');
  });
});

describe('attachSignalHandlers', () => {
  it('should add and cleanly remove one handler per signal', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    const migrator = { stop: mock.fn() };
    const detach = attachSignalHandlers(migrator, undefined, silentLogger);
    assert.strictEqual(process.listenerCount('SIGINT'), before.SIGINT + 1);
    assert.strictEqual(process.listenerCount('SIGTERM'), before.SIGTERM + 1);
    detach();
    // The stated purpose of detach: a long-lived process calling the CLI
    // repeatedly must not accumulate handlers.
    assert.strictEqual(process.listenerCount('SIGINT'), before.SIGINT);
    assert.strictEqual(process.listenerCount('SIGTERM'), before.SIGTERM);
  });

  it('should route the first signal into migrator.stop with the signal name', () => {
    const migrator = { stop: mock.fn() };
    const warn = mock.fn();
    const detach = attachSignalHandlers(migrator, undefined, { ...silentLogger, warn });
    try {
      // Invoke our handler directly (the most recently attached listener) —
      // process.emit('SIGINT') would also fire any listeners the test runner
      // itself installed.
      const handler = process.listeners('SIGINT').at(-1);
      handler();
      assert.strictEqual(migrator.stop.mock.callCount(), 1);
      assert.match(migrator.stop.mock.calls[0].arguments[0], /SIGINT/);
      assert.strictEqual(warn.mock.callCount(), 1);
    } finally {
      detach();
    }
  });
});
