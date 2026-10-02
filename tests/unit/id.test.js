// Strict on purpose: the receiver test below needs a callee that sees the
// `this` it was actually called with, not one coerced to the global object.
'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { MAX_ID_LENGTH, assertId, createIdGenerator, randomId } = require('../../src/utils/id.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('randomId', () => {
  it('should mint a UUID, different every time', () => {
    const first = randomId();
    assert.match(first, UUID);
    assert.notStrictEqual(randomId(), first);
  });

  it('should stay under the limit it shares with every other id', () => {
    assert.strictEqual(MAX_ID_LENGTH, 128);
    assert.ok(randomId().length <= MAX_ID_LENGTH);
  });
});

describe('assertId', () => {
  it('should hand a usable id back unchanged', () => {
    assert.strictEqual(assertId('01J9Z3K5Q8'), '01J9Z3K5Q8');
    assert.strictEqual(assertId('x'), 'x');
    assert.strictEqual(assertId('g'.repeat(MAX_ID_LENGTH)).length, MAX_ID_LENGTH);
  });

  it('should take any characters — an id is only ever stored and compared', () => {
    // The lock stores the token under $literal, so a leading `$` is no field path.
    for (const id of ['$owner', 'run.2026', 'запуск-1', 'a:b', 'with space']) {
      assert.strictEqual(assertId(id), id);
    }
  });

  it('should refuse an empty string and one over the limit, reporting the length', () => {
    for (const id of ['', 'g'.repeat(MAX_ID_LENGTH + 1)]) {
      assert.throws(
        () => assertId(id),
        (error) => {
          assert.ok(error instanceof ConfigInvalidError);
          assert.match(error.message, /non-empty string of at most 128 characters/);
          assert.deepStrictEqual(error.context, { length: id.length });
          return true;
        },
      );
    }
  });

  it('should refuse anything that is not a string, reporting what came back', () => {
    for (const [value, type] of [
      [undefined, 'undefined'],
      [null, 'object'],
      [42, 'number'],
      [{ toString: () => 'id' }, 'object'],
      [Symbol('id'), 'symbol'],
    ]) {
      assert.throws(
        () => assertId(value),
        (error) => {
          assert.strictEqual(error.code, 'CONFIG_INVALID');
          assert.deepStrictEqual(error.context, { returned: type });
          return true;
        },
      );
    }
  });
});

describe('createIdGenerator', () => {
  it('should keep the default when no generator is configured', () => {
    assert.strictEqual(createIdGenerator(undefined), randomId);
    assert.strictEqual(createIdGenerator(), randomId);
  });

  it('should refuse a generator that is not a function', () => {
    for (const value of ['ulid', null, 5, {}, true]) {
      assert.throws(
        () => createIdGenerator(value),
        (error) => {
          assert.ok(error instanceof ConfigInvalidError);
          assert.strictEqual(error.message, 'generateId must be a function');
          assert.deepStrictEqual(error.context, { generateId: typeof value });
          return true;
        },
      );
    }
  });

  it('should mint through the configured generator', () => {
    let count = 0;
    const newId = createIdGenerator(() => `run_${++count}`);
    assert.deepStrictEqual([newId(), newId()], ['run_1', 'run_2']);
  });

  it('should call the generator bare — no arguments, no receiver', () => {
    // What lets `generateId: ulid` / `generateId: nanoid` work as is: their
    // first parameter is a seed time or a size, and an argument of ours would
    // be read as one.
    const calls = [];
    function generator(...args) {
      calls.push({ args, receiver: this });
      return 'id';
    }
    createIdGenerator(generator)('ignored', 21);
    assert.deepStrictEqual(calls, [{ args: [], receiver: undefined }]);
  });

  it('should check every id the generator returns', () => {
    const values = ['ok', '', 'ok-again', 7];
    const newId = createIdGenerator(() => values.shift());
    assert.strictEqual(newId(), 'ok');
    assert.throws(() => newId(), ConfigInvalidError);
    assert.strictEqual(newId(), 'ok-again');
    assert.throws(() => newId(), /non-empty string/);
  });

  it('should wrap a throwing generator, keeping the original error as the cause', () => {
    const failure = new Error('entropy pool closed');
    const newId = createIdGenerator(() => {
      throw failure;
    });
    assert.throws(
      () => newId(),
      (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.strictEqual(error.message, 'generateId threw');
        assert.strictEqual(error.cause, failure);
        assert.deepStrictEqual(error.context, { cause: 'entropy pool closed' });
        return true;
      },
    );
  });

  it('should mask credentials a throwing generator echoes', () => {
    const newId = createIdGenerator(() => {
      throw new Error('cannot reach mongodb://admin:hunter2@db.internal/ids');
    });
    assert.throws(
      () => newId(),
      (error) => {
        assert.ok(!error.context.cause.includes('hunter2'));
        return true;
      },
    );
  });

  it('should refuse an async generator instead of storing its promise as an id', () => {
    const newId = createIdGenerator(async () => 'too-late');
    assert.throws(
      () => newId(),
      (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.match(error.message, /must be synchronous/);
        return true;
      },
    );
  });

  it('should not leave an unhandled rejection behind a rejected promise', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const newId = createIdGenerator(() => Promise.reject(new Error('never observed')));
      assert.throws(() => newId(), /must be synchronous/);
      // Unhandled rejections are reported after the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('should treat any thenable as a promise', () => {
    const newId = createIdGenerator(() => ({ then: () => {} }));
    assert.throws(() => newId(), /must be synchronous/);
  });
});
