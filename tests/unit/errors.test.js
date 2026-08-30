const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const errors = require('../../src/errors/index.js');
const { HookFailedError, MigronautError, NotAppliedError } = errors;

describe('MigronautError', () => {
  it('should set code, message and context', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config', { field: 'uri' });
    assert.strictEqual(err.code, 'CONFIG_INVALID');
    assert.strictEqual(err.message, 'Bad config');
    assert.deepStrictEqual(err.context, { field: 'uri' });
    assert.strictEqual(err.name, 'MigronautError');
  });

  it('should be an instance of Error', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.ok(err instanceof Error);
  });

  it('should leave context undefined when not provided', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.strictEqual(err.context, undefined);
  });

  it('should capture a stack trace', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.notStrictEqual(err.stack, undefined);
  });
});

describe('domain error classes', () => {
  // Derived from the module's exports, so the per-class contract test is
  // complete by construction — a hand-written case list here silently omitted
  // five newer subclasses, the same drift the config test eliminated by
  // deriving its env list from ENV_KEYS.
  const subclasses = Object.entries(errors).filter(
    ([name, Ctor]) => name !== 'MigronautError' && typeof Ctor === 'function',
  );

  it('should cover every exported subclass (sanity)', () => {
    assert.ok(subclasses.length >= 19, 'expected the full error taxonomy');
  });

  it('should give every subclass a distinct code', () => {
    const codes = subclasses.map(([, Ctor]) => new Ctor('probe').code);
    assert.strictEqual(new Set(codes).size, codes.length);
  });

  for (const [name, Ctor] of subclasses) {
    it(`${name} should carry a typed code and extend MigronautError`, () => {
      const err = new Ctor('Something happened', { detail: 1 });
      assert.ok(err instanceof MigronautError);
      assert.ok(err instanceof Error);
      assert.strictEqual(typeof err.code, 'string');
      assert.match(err.code, /^[A-Z_]+$/);
      assert.strictEqual(err.name, name);
      assert.strictEqual(err.message, 'Something happened');
      assert.deepStrictEqual(err.context, { detail: 1 });
    });

    it(`${name} should be catchable as MigronautError with its code`, () => {
      const expected = new Ctor('probe').code;
      try {
        throw new Ctor('boom');
      } catch (e) {
        assert.ok(e instanceof MigronautError);
        assert.strictEqual(e.code, expected);
      }
    });
  }
});

describe('error cause chaining', () => {
  it('should keep the original Error (and its stack) as cause', () => {
    const root = new Error('the real reason');
    const wrapped = new MigronautError('CONFIG_INVALID', 'Invalid configuration', undefined, {
      cause: root,
    });
    assert.strictEqual(wrapped.cause, root);
    // The stack still points at where the failure actually happened.
    assert.match(wrapped.cause.stack, /the real reason/);
  });

  it('should leave cause undefined when none is given', () => {
    assert.strictEqual(new NotAppliedError('nope').cause, undefined);
  });

  it('should chain the cause through a subclass', () => {
    const root = new TypeError('bad input');
    const err = new HookFailedError(
      'The beforeAll hook failed',
      { hook: 'beforeAll' },
      {
        cause: root,
      },
    );
    assert.strictEqual(err.cause, root);
    assert.strictEqual(err.context.hook, 'beforeAll');
    assert.strictEqual(err.code, 'HOOK_FAILED');
  });
});
