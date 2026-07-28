/**
 * Terminal control-character sanitization for untrusted text.
 *
 * Cell values, lock-holder fields and migration filenames come from the
 * changelog, the lock collection and the filesystem — sources anyone with
 * write access to the database (or a malicious PR) can influence — so ESC and
 * friends must never reach the terminal, where they could move the cursor,
 * clear the screen, or restyle everything printed after them.
 */

/** Control characters stripped from untrusted values (tab and newline survive) */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/**
 * SGR color sequences (`ESC[…m`) to preserve, or a control character to drop.
 * Colors are the one escape family migronaut itself emits (tables, log
 * levels); every other sequence — cursor movement, screen clearing, OSC
 * titles — has no legitimate reason to be in a log line.
 */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const SGR_OR_CONTROL = /(\u001b\[[0-9;]*m)|[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/**
 * Strip every terminal control character from an untrusted value. For data
 * that should carry no styling at all (table cells, spinner text) — apply
 * before adding migronaut's own colors, so those survive.
 */
function sanitize(text) {
  return String(text).replace(CONTROL_CHARS, '');
}

/**
 * Strip control characters while preserving SGR color sequences. For the
 * terminal logger's write path, where trusted colored output (a rendered
 * table) and untrusted substrings (a migration name inside a message) arrive
 * in the same string.
 */
function sanitizeTerminal(text) {
  return String(text).replace(SGR_OR_CONTROL, (_match, sgr) => sgr ?? '');
}

module.exports = { sanitize, sanitizeTerminal };
