const assert = require('node:assert/strict');
const { afterEach, describe, it, mock } = require('node:test');
const { createSpinner } = require('../../src/cli/spinner.js');

const CLEAR_LINE = '\r\x1b[K';

const createStream = (isTTY) => {
  const chunks = [];
  return {
    chunks,
    isTTY,
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
  };
};

afterEach(() => {
  mock.timers.reset();
});

describe('createSpinner', () => {
  it('should render frames prefixed with a clear-line sequence on a TTY', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const stream = createStream(true);
    const spinner = createSpinner(stream);
    spinner.start('Working…');
    mock.timers.tick(80 * 3);
    assert.strictEqual(stream.chunks.length, 4);
    for (const chunk of stream.chunks) {
      assert.ok(chunk.startsWith(CLEAR_LINE));
      assert.ok(chunk.includes('Working…'));
    }
    const frames = new Set(stream.chunks.map((chunk) => chunk.slice(CLEAR_LINE.length, -9)));
    assert.ok(frames.size > 1);
  });

  it('should clear the line on stop and become inert', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const stream = createStream(true);
    const spinner = createSpinner(stream);
    spinner.start('Working…');
    spinner.stop();
    assert.strictEqual(stream.chunks.at(-1), CLEAR_LINE);
    const count = stream.chunks.length;
    mock.timers.tick(800);
    spinner.stop();
    assert.strictEqual(stream.chunks.length, count);
  });

  it('should update the text when start is called again', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const stream = createStream(true);
    const spinner = createSpinner(stream);
    spinner.start('First');
    spinner.start('Second');
    assert.ok(stream.chunks.at(-1).includes('Second'));
    spinner.stop();
  });

  it('should be a complete no-op on a non-TTY stream', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const stream = createStream(false);
    const spinner = createSpinner(stream);
    spinner.start('Hidden');
    mock.timers.tick(800);
    spinner.stop();
    assert.deepStrictEqual(stream.chunks, []);
  });
});
