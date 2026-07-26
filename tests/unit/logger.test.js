const assert = require('node:assert/strict');
const { afterEach, describe, it, mock } = require('node:test');
const { createLogger, resolveLogger, silentLogger } = require('../../src/utils/logger.js');

afterEach(() => {
  mock.restoreAll();
});

describe('silentLogger', () => {
  it('should expose all logger methods as no-ops', () => {
    assert.doesNotThrow(() => {
      silentLogger.debug('x');
      silentLogger.info('x');
      silentLogger.warn('x');
      silentLogger.error('x');
    });
  });
});

describe('createLogger', () => {
  it('should write info to stdout and drop debug at the default level', () => {
    const spy = mock.method(process.stdout, 'write', () => true);
    const logger = createLogger();
    logger.debug('faded');
    logger.info('hello');
    // debug is opt-in via --verbose; only the info line is written.
    assert.strictEqual(spy.mock.callCount(), 1);
    assert.match(spy.mock.calls[0].arguments[0], /hello/);
  });

  it('should write debug/info to stdout at the debug level', () => {
    const spy = mock.method(process.stdout, 'write', () => true);
    const logger = createLogger(process.stdout, 'debug');
    logger.debug('faded');
    logger.info('hello');
    assert.strictEqual(spy.mock.callCount(), 2);
  });

  it('should keep errors at the quiet level but drop info', () => {
    const out = mock.method(process.stdout, 'write', () => true);
    const err = mock.method(process.stderr, 'write', () => true);
    const logger = createLogger(process.stdout, 'error');
    logger.info('chatter');
    logger.warn('careful');
    logger.error('boom');
    // --quiet silences the commentary; a failure must still be reported.
    assert.strictEqual(out.mock.callCount(), 0);
    assert.strictEqual(err.mock.callCount(), 1);
    assert.match(err.mock.calls[0].arguments[0], /boom/);
  });

  it('should ignore the structured fields argument', () => {
    const spy = mock.method(process.stdout, 'write', () => true);
    createLogger().info('hello', { migration: 'a.ts', durationMs: 5 });
    assert.strictEqual(spy.mock.callCount(), 1);
    assert.match(spy.mock.calls[0].arguments[0], /^hello\n$/);
  });

  it('should write warn/error to stderr', () => {
    const spy = mock.method(process.stderr, 'write', () => true);
    const logger = createLogger();
    logger.warn('careful');
    logger.error('boom');
    assert.strictEqual(spy.mock.callCount(), 2);
  });

  it('should write to a custom stream for debug/info only', () => {
    const lines = [];
    const stream = {
      isTTY: false,
      write: (chunk) => {
        lines.push(chunk);
        return true;
      },
    };
    const spy = mock.method(process.stderr, 'write', () => true);
    const logger = createLogger(stream);
    logger.info('to-stream');
    logger.error('to-stderr');
    assert.deepStrictEqual(lines, ['to-stream\n']);
    assert.strictEqual(spy.mock.callCount(), 1);
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

  it('should delegate every method of a custom four-method logger', () => {
    const calls = [];
    const custom = {
      debug: (msg) => calls.push(['debug', msg]),
      info: (msg) => calls.push(['info', msg]),
      warn: (msg) => calls.push(['warn', msg]),
      error: (msg) => calls.push(['error', msg]),
    };
    const logger = resolveLogger(custom);
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    assert.deepStrictEqual(calls, [
      ['debug', 'a'],
      ['info', 'b'],
      ['warn', 'c'],
      ['error', 'd'],
    ]);
  });

  it('should bind a pino-style child once with a component field', () => {
    const childCalls = [];
    const sinkCalls = [];
    const pinoLike = {
      child: (bindings) => {
        childCalls.push(bindings);
        return {
          debug: (msg) => sinkCalls.push(['debug', msg]),
          info: (msg) => sinkCalls.push(['info', msg]),
          warn: (msg) => sinkCalls.push(['warn', msg]),
          error: (msg) => sinkCalls.push(['error', msg]),
        };
      },
      info: () => {
        throw new Error('root logger must not be used when child exists');
      },
    };
    const logger = resolveLogger(pinoLike);
    resolveLogger(pinoLike);
    logger.info('applied');
    logger.debug('detail');
    assert.deepStrictEqual(childCalls, [{ component: 'migronaut' }]);
    assert.deepStrictEqual(sinkCalls, [
      ['info', 'applied'],
      ['debug', 'detail'],
    ]);
  });

  it('should fall back to info for missing methods', () => {
    const calls = [];
    const minimal = { info: (msg) => calls.push(msg) };
    const logger = resolveLogger(minimal);
    logger.debug('a');
    logger.warn('b');
    logger.error('c');
    assert.deepStrictEqual(calls, ['a', 'b', 'c']);
  });

  it('should swallow exceptions thrown by the user logger', () => {
    const logger = resolveLogger({
      info: () => {
        throw new Error('sink exploded');
      },
    });
    assert.doesNotThrow(() => logger.info('x'));
  });

  it('should silence a structurally unfit logger value', () => {
    assert.strictEqual(resolveLogger({}), silentLogger);
    assert.strictEqual(resolveLogger('loud'), silentLogger);
    assert.strictEqual(resolveLogger(true), silentLogger);
  });

  it('should work with a real pino instance', async () => {
    const { Writable } = require('node:stream');
    const pino = require('pino');
    const lines = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = resolveLogger(pino({ level: 'debug' }, sink));
    logger.info('✔ Applied 0001-a.js');
    logger.debug('Loaded config from migronaut.config.js');
    // pino flushes synchronously to a custom destination stream
    const entries = lines
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].component, 'migronaut');
    assert.strictEqual(entries[0].msg, '✔ Applied 0001-a.js');
    assert.strictEqual(entries[1].component, 'migronaut');
  });

  it('should pass structured fields to pino in its own (obj, msg) order', async () => {
    const { Writable } = require('node:stream');
    const pino = require('pino');
    const lines = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = resolveLogger(pino({ level: 'debug' }, sink));
    logger.info('✔ Applied 0001-a.js', { migration: '0001-a.js', durationMs: 42 });
    const entry = JSON.parse(lines.join('').trim());
    // Fields land as real JSON keys, not baked into the message string.
    assert.strictEqual(entry.msg, '✔ Applied 0001-a.js');
    assert.strictEqual(entry.migration, '0001-a.js');
    assert.strictEqual(entry.durationMs, 42);
  });

  it('should pass fields as the second argument to a plain logger', () => {
    const calls = [];
    const logger = resolveLogger({
      debug: (...args) => calls.push(args),
      info: (...args) => calls.push(args),
      warn: (...args) => calls.push(args),
      error: (...args) => calls.push(args),
    });
    logger.info('msg', { migration: 'a.ts' });
    logger.warn('plain');
    // (msg, fields) for a non-pino logger; a one-arg logger is unaffected.
    assert.deepStrictEqual(calls[0], ['msg', { migration: 'a.ts' }]);
    assert.deepStrictEqual(calls[1], ['plain']);
  });
});
