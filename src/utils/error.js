const { MigronautError } = require('../errors/index.js');
const { redactUris } = require('./redact.js');

/**
 * Human-readable message from any thrown value, with URI credentials masked.
 * The single chokepoint for turning caught errors into strings — using it
 * everywhere is what keeps driver messages that echo the connection URI from
 * leaking passwords into logs, error context, or `--json` output.
 */
const errorText = (error) => redactUris(error instanceof Error ? error.message : String(error));

/**
 * {@link errorText} joined with the wrapped cause: "Migration up failed: X"
 * says WHICH migration failed, and its `context.cause` says WHY — the half
 * forensics actually needs. Both halves are redacted (the cause is the raw
 * thrown message). What the changelog's failure trace and a failed span's
 * status message both carry.
 */
function errorWithCause(error) {
  const message = errorText(error);
  const cause =
    error instanceof MigronautError && typeof error.context?.cause === 'string'
      ? errorText(error.context.cause)
      : undefined;
  return cause ? `${message} — ${cause}` : message;
}

module.exports = { errorText, errorWithCause };
