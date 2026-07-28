/**
 * Decide whether ANSI colors should be emitted to `stream`.
 *
 * Precedence, most specific signal first:
 *   MIGRONAUT_FORCE_COLOR > MIGRONAUT_NO_COLOR > FORCE_COLOR > NO_COLOR >
 *   TERM=dumb > the stream being an interactive TTY.
 *
 * The MIGRONAUT_* pair exists so a project can pin migronaut's own output
 * without disturbing every other tool in the same shell; the unprefixed pair
 * stays honored underneath, because NO_COLOR/FORCE_COLOR are ecosystem-wide
 * conventions (no-color.org) that a CLI is expected to obey. Same value
 * semantics in both tiers: a *FORCE_COLOR that is set and non-empty decides
 * ('0' off, anything else on); a *NO_COLOR that is set and non-empty forces off.
 *
 * There is deliberately no MIGRONAUT_TERM — TERM describes what the terminal
 * can render, not what migronaut should do, and MIGRONAUT_NO_COLOR already
 * covers the override case.
 */
function supportsColor(stream, env = process.env) {
  const ownForce = env.MIGRONAUT_FORCE_COLOR;
  if (ownForce !== undefined && ownForce !== '') return ownForce !== '0';
  if (env.MIGRONAUT_NO_COLOR !== undefined && env.MIGRONAUT_NO_COLOR !== '') return false;
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
