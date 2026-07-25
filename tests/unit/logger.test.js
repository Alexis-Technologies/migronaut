const assert = require('node:assert/strict');
const { afterEach, describe, it, mock } = require('node:test');
const { createLogger, resolveLogger, silentLogger } = require('../../src/utils/logger.js');

afterEach(() => {
  mock.restoreAll();
});

describe('silentLogger', () => {
  it('should expose all logger methods as no-ops', () => {
    assert.doesNotThrow(() => {
      silentLogger.info('x');
      silentLogger.success('x');
      silentLogger.warn('x');
      silentLogger.error('x');
      silentLogger.dim('x');
    });
  });
});

describe('createLogger', () => {
  it('should write info/success/dim to stdout', () => {
    const spy = mock.method(process.stdout, 'write', () => true);
    const logger = createLogger();
    logger.info('hello');
    logger.success('done');
    logger.dim('faded');
    assert.strictEqual(spy.mock.callCount(), 3);
  });

  it('should write warn/error to stderr', () => {
    const spy = mock.method(process.stderr, 'write', () => true);
    const logger = createLogger();
    logger.warn('careful');
    logger.error('boom');
    assert.strictEqual(spy.mock.callCount(), 2);
  });
});

describe('resolveLogger', () => {
  it('should return the silent logger when given null', () => {
    assert.strictEqual(resolveLogger(null), silentLogger);
  });

  it('should return a default logger when given undefined', () => {
    const logger = resolveLogger(undefined);
    assert.strictEqual(typeof logger.info, 'function');
    assert.notStrictEqual(logger, silentLogger);
  });

  it('should return the provided custom logger unchanged', () => {
    assert.strictEqual(resolveLogger(silentLogger), silentLogger);
  });
});
