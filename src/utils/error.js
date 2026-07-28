const { redactUris } = require('./redact.js');

/**
 * Human-readable message from any thrown value, with URI credentials masked.
 * The single chokepoint for turning caught errors into strings — using it
 * everywhere is what keeps driver messages that echo the connection URI from
 * leaking passwords into logs, error context, or `--json` output.
 */
const errorText = (error) => redactUris(error instanceof Error ? error.message : String(error));

module.exports = { errorText };
