const os = require('node:os');
const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { safeUsername } = require('../../src/utils/user.js');

let saved;

afterEach(() => {
  if (saved === undefined) delete process.env.MIGRONAUT_USER;
  else process.env.MIGRONAUT_USER = saved;
  saved = undefined;
});

const setOverride = (value) => {
  saved = process.env.MIGRONAUT_USER;
  if (value === undefined) delete process.env.MIGRONAUT_USER;
  else process.env.MIGRONAUT_USER = value;
};

describe('safeUsername', () => {
  it('should report the OS username when no override is set', () => {
    setOverride(undefined);
    assert.strictEqual(safeUsername(), os.userInfo().username);
  });

  it('should let MIGRONAUT_USER override the OS username', () => {
    // In CI the OS user is a meaningless `runner`/`root`; the identity worth
    // stamping on the changelog is the deploy actor, and only the caller knows it.
    setOverride('deploy-bot');
    assert.strictEqual(safeUsername(), 'deploy-bot');
  });

  it('should ignore an empty MIGRONAUT_USER', () => {
    // `MIGRONAUT_USER=` in a CI template must not record an empty author.
    setOverride('');
    assert.strictEqual(safeUsername(), os.userInfo().username);
  });
});
