const { MigronautError } = require('../errors/index.js');
const { redactOutbound, redactUris } = require('./redact.js');

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

/**
 * {@link errorText} for an error about the application's data — a background
 * migration's document errors and failed slices, kept in its state and
 * logged: the values a server error quotes (an E11000's duplicate key — an
 * email, a phone number) are masked too. Migronaut never logs a document's
 * contents; the index name still says which constraint was violated.
 */
const documentErrorText = (error) => redactOutbound(errorText(error));

/**
 * Whether a failed transaction is worth running again as it is: the server's
 * `TransientTransactionError` label, or a write conflict (112), a transaction
 * the server no longer knows (251), a lock it could not take in time (24).
 *
 * One answer for the background engine and for the sandbox that previews it:
 * they had one each, and the dry run did not retry on 251 and 24 where the
 * real run does — a preview that fails where the migration would not. (What
 * converge asks of an error is something else — "is it unknown what the
 * server did?", "is this read worth another try?" — and has its own tables.)
 */
const isTransientTransaction = (error) =>
  error?.hasErrorLabel?.('TransientTransactionError') === true ||
  error?.code === 112 ||
  error?.code === 251 ||
  error?.code === 24;

module.exports = { documentErrorText, errorText, errorWithCause, isTransientTransaction };
