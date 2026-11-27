const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const errors = require('../../src/errors/index.js');
const { HookFailedError, MigronautError, NotAppliedError } = errors;

describe('MigronautError', () => {
  it('should set message, code and context from the options', () => {
    const err = new MigronautError('Bad config', {
      code: 'ALX_ERR_CONFIG_INVALID',
      context: { field: 'uri' },
    });
    assert.strictEqual(err.code, 'ALX_ERR_CONFIG_INVALID');
    assert.strictEqual(err.message, 'Bad config');
    assert.deepStrictEqual(err.context, { field: 'uri' });
    assert.strictEqual(err.name, 'MigronautError');
  });

  it('should be an instance of Error', () => {
    const err = new MigronautError('Bad config', { code: 'ALX_ERR_CONFIG_INVALID' });
    assert.ok(err instanceof Error);
  });

  it('should give every instance a context, empty when none is given', () => {
    const err = new MigronautError('Bad config', { code: 'ALX_ERR_CONFIG_INVALID' });
    assert.ok(Object.hasOwn(err, 'context'));
    assert.deepStrictEqual(err.context, {});
  });

  it('should capture a stack trace', () => {
    const err = new MigronautError('Bad config', { code: 'ALX_ERR_CONFIG_INVALID' });
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
    assert.ok(subclasses.length >= 22, 'expected the full error taxonomy');
  });

  it('should give every subclass a distinct code', () => {
    const codes = subclasses.map(([, Ctor]) => new Ctor('probe').code);
    assert.strictEqual(new Set(codes).size, codes.length);
  });

  for (const [name, Ctor] of subclasses) {
    describe(name, () => {
      it('should carry a typed code and extend MigronautError', () => {
        const err = new Ctor('Something happened', { context: { detail: 1 } });
        assert.ok(err instanceof MigronautError);
        assert.ok(err instanceof Error);
        assert.strictEqual(typeof err.code, 'string');
        assert.match(err.code, /^ALX_ERR_[A-Z_]+$/);
        assert.strictEqual(err.name, name);
        assert.strictEqual(err.message, 'Something happened');
        assert.deepStrictEqual(err.context, { detail: 1 });
      });

      it('should keep its own code over one given in the options', () => {
        const expected = new Ctor('probe').code;
        assert.strictEqual(new Ctor('probe', { code: 'ALX_ERR_CONFIG_INVALID' }).code, expected);
      });

      it('should give an empty context when none is given', () => {
        assert.deepStrictEqual(new Ctor('probe').context, {});
      });

      it('should be catchable as MigronautError with its code', () => {
        const expected = new Ctor('probe').code;
        try {
          throw new Ctor('boom');
        } catch (e) {
          assert.ok(e instanceof MigronautError);
          assert.strictEqual(e.code, expected);
        }
      });
    });
  }
});

describe('error cause chaining', () => {
  it('should keep the original Error (and its stack) as cause', () => {
    const root = new Error('the real reason');
    const wrapped = new MigronautError('Invalid configuration', {
      code: 'ALX_ERR_CONFIG_INVALID',
      cause: root,
    });
    assert.strictEqual(wrapped.cause, root);
    // The stack still points at where the failure actually happened.
    assert.match(wrapped.cause.stack, /the real reason/);
  });

  it('should not set cause when none is given', () => {
    const err = new NotAppliedError('nope', { context: { filename: 'a.js' } });
    assert.ok(!Object.hasOwn(err, 'cause'));
    assert.strictEqual(err.cause, undefined);
  });

  it('should chain the cause through a subclass', () => {
    const root = new TypeError('bad input');
    const err = new HookFailedError('The beforeAll hook failed', {
      cause: root,
      context: { hook: 'beforeAll' },
    });
    assert.strictEqual(err.cause, root);
    assert.strictEqual(err.context.hook, 'beforeAll');
    assert.strictEqual(err.code, 'ALX_ERR_HOOK_FAILED');
  });
});
