/**
 * Decide whether ANSI colors should be emitted to `stream`.
 * Precedence: FORCE_COLOR (any value but '0' forces on) > NO_COLOR (forces
 * off) > TERM=dumb (off) > the stream being an interactive TTY.
 */
function supportsColor(stream, env = process.env) {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') return force !== '0';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

const paint = (open, close) => (text) => `\x1b[${open}m${text}\x1b[${close}m`;
const identity = (text) => text;

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Remove ANSI SGR color codes from a string */
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Create the color palette for writing to `stream`: green/yellow/red/cyan/dim
 * wrapper functions plus an `enabled` flag. When colors are unsupported every
 * wrapper is the identity function, so call sites never need to branch.
 */
function createColors(stream, env = process.env) {
  const enabled = supportsColor(stream, env);
  if (!enabled) {
    return {
      enabled,
      green: identity,
      yellow: identity,
      red: identity,
      cyan: identity,
      dim: identity,
    };
  }
  return {
    enabled,
    green: paint(32, 39),
    yellow: paint(33, 39),
    red: paint(31, 39),
    cyan: paint(36, 39),
    dim: paint(2, 22),
  };
}

module.exports = { supportsColor, createColors, stripAnsi };
