const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createColors, supportsColor } = require('../../src/utils/colors.js');

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe('supportsColor', () => {
  it('should enable colors on a TTY with a clean env', () => {
    assert.strictEqual(supportsColor(tty, {}), true);
  });

  it('should disable colors on a non-TTY stream', () => {
    assert.strictEqual(supportsColor(pipe, {}), false);
    assert.strictEqual(supportsColor(undefined, {}), false);
  });

  it('should let NO_COLOR beat a TTY', () => {
    assert.strictEqual(supportsColor(tty, { NO_COLOR: '1' }), false);
  });

  it('should ignore an empty NO_COLOR', () => {
    assert.strictEqual(supportsColor(tty, { NO_COLOR: '' }), true);
  });

  it('should let FORCE_COLOR beat a non-TTY', () => {
    assert.strictEqual(supportsColor(pipe, { FORCE_COLOR: '1' }), true);
  });

  it('should let FORCE_COLOR=0 disable colors on a TTY', () => {
    assert.strictEqual(supportsColor(tty, { FORCE_COLOR: '0' }), false);
  });

  it('should let FORCE_COLOR beat NO_COLOR', () => {
    assert.strictEqual(supportsColor(pipe, { FORCE_COLOR: '1', NO_COLOR: '1' }), true);
  });

  it('should disable colors when TERM is dumb', () => {
    assert.strictEqual(supportsColor(tty, { TERM: 'dumb' }), false);
  });

  it('should let MIGRONAUT_NO_COLOR beat a TTY', () => {
    assert.strictEqual(supportsColor(tty, { MIGRONAUT_NO_COLOR: '1' }), false);
  });

  it('should ignore an empty MIGRONAUT_NO_COLOR', () => {
    assert.strictEqual(supportsColor(tty, { MIGRONAUT_NO_COLOR: '' }), true);
  });

  it('should let MIGRONAUT_FORCE_COLOR beat a non-TTY', () => {
    assert.strictEqual(supportsColor(pipe, { MIGRONAUT_FORCE_COLOR: '1' }), true);
  });

  it('should let MIGRONAUT_FORCE_COLOR=0 disable colors on a TTY', () => {
    assert.strictEqual(supportsColor(tty, { MIGRONAUT_FORCE_COLOR: '0' }), false);
  });

  it('should let the prefixed pair outrank the unprefixed one', () => {
    // A project pinning migronaut's own output must win over whatever the shell
    // or CI runner exported for every tool.
    assert.strictEqual(supportsColor(pipe, { MIGRONAUT_FORCE_COLOR: '1', NO_COLOR: '1' }), true);
    assert.strictEqual(supportsColor(tty, { MIGRONAUT_NO_COLOR: '1', FORCE_COLOR: '1' }), false);
    assert.strictEqual(supportsColor(tty, { MIGRONAUT_FORCE_COLOR: '0', FORCE_COLOR: '1' }), false);
  });

  it('should keep honoring the unprefixed pair when no prefixed one is set', () => {
    // no-color.org compatibility is not traded away for the prefix.
    const empty = { MIGRONAUT_FORCE_COLOR: '', MIGRONAUT_NO_COLOR: '' };
    assert.strictEqual(supportsColor(tty, { ...empty, NO_COLOR: '1' }), false);
    assert.strictEqual(supportsColor(pipe, { ...empty, FORCE_COLOR: '1' }), true);
  });
});

describe('createColors', () => {
  it('should return identity functions when disabled', () => {
    const colors = createColors(pipe, {});
    assert.strictEqual(colors.enabled, false);
    assert.strictEqual(colors.green('text'), 'text');
    assert.strictEqual(colors.yellow('text'), 'text');
    assert.strictEqual(colors.red('text'), 'text');
    assert.strictEqual(colors.cyan('text'), 'text');
    assert.strictEqual(colors.dim('text'), 'text');
  });

  it('should wrap text in SGR codes when enabled', () => {
    const colors = createColors(tty, {});
    assert.strictEqual(colors.enabled, true);
    assert.strictEqual(colors.green('ok'), '\x1b[32mok\x1b[39m');
    assert.strictEqual(colors.yellow('warn'), '\x1b[33mwarn\x1b[39m');
    assert.strictEqual(colors.red('bad'), '\x1b[31mbad\x1b[39m');
    assert.strictEqual(colors.cyan('head'), '\x1b[36mhead\x1b[39m');
    assert.strictEqual(colors.dim('faded'), '\x1b[2mfaded\x1b[22m');
  });
});
