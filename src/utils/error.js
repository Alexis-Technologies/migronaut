const { MigronautError } = require('../errors/index.js');
const { redactOutbound, redactUris } = require('./redact.js');

/** A write conflict, a transaction the server no longer knows, a lock not taken in time */
const TRANSIENT_TRANSACTION_CODES = new Set([112, 251, 24]);

/**
 * The server's own error behind what the driver threw. From 7.x the driver
 * replaces a refused write of code 20 (IllegalOperation) with an error of its
 * own — "This MongoDB deployment does not support retryable writes. Please
 * add retryWrites=false to your connection string.", with no code — and keeps
 * the server's under `originalError`. That message is advice for a storage
 * engine gone since MongoDB 4.2, and wrong for every refusal met today (a
 * transaction on a standalone server, a shard key changed without one): the
 * server's says what happened. (6.x did this only on a retried write, never
 * inside a transaction.) Any other error is its own.
 */
const serverErrorOf = (error) =>
  error?.originalError instanceof Error ? error.originalError : error;

/**
 * Human-readable message from any thrown value, with URI credentials masked.
 * The single chokepoint for turning caught errors into strings — using it
 * everywhere is what keeps driver messages that echo the connection URI from
 * leaking passwords into logs, error context, or `--json` output. It speaks
 * in the server's words where the driver put its own over them
 * ({@link serverErrorOf}).
 */
const errorText = (error) =>
  redactUris(error instanceof Error ? serverErrorOf(error).message : String(error));

/**
 * {@link errorText} joined with the wrapped cause: "Migration up failed: X"
 * says WHICH migration failed, and its `context.cause` says WHY — the half
 * forensics actually needs. Both halves are redacted (the cause is the raw
 * thrown message). What the changelog's failure trace and a failed span's
 * status message both carry.
 */
const errorWithCause = (error) => {
  const message = errorText(error);
  const cause =
    error instanceof MigronautError && typeof error.context?.cause === 'string'
      ? errorText(error.context.cause)
      : undefined;
  return cause ? `${message} — ${cause}` : message;
};

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
const isTransientTransaction = (error) => {
  const labelled = error?.hasErrorLabel?.('TransientTransactionError') === true;
  return labelled || TRANSIENT_TRANSACTION_CODES.has(error?.code);
};

/**
 * Whether the MongoDB driver threw this: every error class of `mongodb` is
 * named `Mongo…` (a duck test — the driver is not required here, and a kit
 * built on another copy of it must still be recognized).
 */
const isDriverError = (error) => error instanceof Error && `${error.name}`.startsWith('Mongo');

module.exports = {
  documentErrorText,
  errorText,
  errorWithCause,
  isDriverError,
  isTransientTransaction,
  serverErrorOf,
};
