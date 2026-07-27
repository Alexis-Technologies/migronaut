const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;
const CLEAR_LINE = '\r\x1b[K';

/**
 * Minimal terminal spinner with the start(text)/stop() surface the CLI needs.
 * Renders only on an interactive TTY; on a pipe or redirect every method is
 * a no-op, so control sequences never leak into captured output. Writes to
 * stderr by default, keeping stdout clean for command output.
 */
function createSpinner(stream = process.stderr) {
  let timer = null;
  let frame = 0;
  let text = '';

  const render = () => {
    stream.write(`${CLEAR_LINE}${FRAMES[frame]} ${text}`);
    frame = (frame + 1) % FRAMES.length;
  };

  const start = (message) => {
    if (!stream.isTTY) return;
    text = message ?? '';
    if (timer === null) {
      timer = setInterval(render, INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
    render();
  };

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    stream.write(CLEAR_LINE);
  };

  /**
   * Run `fn` (which writes to the terminal) without splicing its output into
   * the middle of a spinner frame: clear the line, let it write, re-render.
   * A plain pass-through while the spinner is idle.
   */
  const interrupt = (fn) => {
    if (timer === null) {
      fn();
      return;
    }
    stream.write(CLEAR_LINE);
    fn();
    render();
  };

  return { start, stop, interrupt };
}

module.exports = { createSpinner };
