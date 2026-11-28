const os = require('node:os');
const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { resolveUsername } = require('../../src/utils/user.js');

const original = process.env.MIGRONAUT_USER;

afterEach(() => {
  if (original === undefined) delete process.env.MIGRONAUT_USER;
  else process.env.MIGRONAUT_USER = original;
});

const setOverride = (value) => {
  if (value === undefined) delete process.env.MIGRONAUT_USER;
  else process.env.MIGRONAUT_USER = value;
};

describe('resolveUsername', () => {
  it('should report the OS username when no override is set', () => {
    setOverride(undefined);
    assert.strictEqual(resolveUsername(), os.userInfo().username);
  });

  it('should let MIGRONAUT_USER override the OS username', () => {
    // In CI the OS user is a meaningless `runner`/`root`; the identity worth
    // stamping on the changelog is the deploy actor, and only the caller knows it.
    setOverride('deploy-bot');
    assert.strictEqual(resolveUsername(), 'deploy-bot');
  });

  it('should ignore an empty MIGRONAUT_USER', () => {
    // `MIGRONAUT_USER=` in a CI template must not record an empty author.
    setOverride('');
    assert.strictEqual(resolveUsername(), os.userInfo().username);
  });
});
