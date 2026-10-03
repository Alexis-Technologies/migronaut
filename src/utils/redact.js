/**
 * Credential redaction for anything that leaves the process — error messages,
 * stacks, `--json` payloads, log lines. The MongoDB driver echoes the raw
 * connection URI in several parse errors, so every captured message must pass
 * through here before it can be printed or serialized.
 *
 * Regex-based, not `new URL()`: multi-host mongodb URIs fail WHATWG parsing,
 * and the URI may sit anywhere inside a larger message (unlike
 * `maskUriCredentials` in template.js, which is anchored to a whole-string URI).
 */
const URI_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]*):([^@/\s]+)@/g;

/**
 * Query parameters whose value is a secret. The userinfo form is not the only
 * place a MongoDB URI carries credentials: TLS key passphrases and proxy
 * passwords travel as plain query parameters and would otherwise survive
 * redaction into logs, error context and `--json` output.
 */
const URI_QUERY_SECRETS =
  /([?&](?:tlsCertificateKeyFilePassword|proxyPassword|sslKeyPassword)=)[^&\s]+/gi;

/**
 * `authMechanismProperties` is a comma-separated `KEY:VALUE` list; only the
 * values of secret-bearing keys (AWS_SESSION_TOKEN et al.) are masked, so
 * non-secret properties (SERVICE_NAME, …) stay readable.
 */
const AUTH_MECHANISM_PROPS = /([?&]authMechanismProperties=)([^&\s]+)/gi;
const SENSITIVE_PROP_KEY = /TOKEN|SECRET|PASSWORD/i;

/**
 * Mask credentials anywhere in `text`: `scheme://user:secret@` (an empty
 * username still hides the password), secret-bearing query parameters, and
 * secret values inside `authMechanismProperties`.
 */
function redactUris(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(URI_CREDENTIALS, '$1$2:****@')
    .replace(URI_QUERY_SECRETS, '$1****')
    .replace(AUTH_MECHANISM_PROPS, (_match, prefix, value) => {
      const pairs = value.split(',');
      for (let i = 0; i < pairs.length; i++) {
        const colon = pairs[i].indexOf(':');
        if (colon === -1) continue;
        const key = pairs[i].slice(0, colon);
        if (SENSITIVE_PROP_KEY.test(key)) pairs[i] = `${key}:****`;
      }
      return `${prefix}${pairs.join(',')}`;
    });
}

/**
 * The document values a server error can quote: an E11000 duplicate-key
 * message ends with the offending key's values — an email, a phone number —
 * which is the database's data, not an error's. Everything from `dup key: {`
 * to the last `}` on that line is masked; the index name before it still says
 * which constraint was violated.
 */
const DUPLICATE_KEY_VALUES = /(dup key: )\{[^\n]*\}/g;

/**
 * For text that leaves the process for a third party — a tracing backend, a
 * queue that keeps failed jobs and serves them to dashboards: credentials
 * masked (as everywhere) and the data values a server error quotes, too.
 * Local log lines keep the values; they are what a developer debugs with.
 */
function redactOutbound(text) {
  if (typeof text !== 'string') return text;
  return redactUris(text).replace(DUPLICATE_KEY_VALUES, '$1{ <redacted> }');
}

/**
 * Redact every string reachable from `value` (plain objects and arrays only —
 * class instances are left alone rather than cloned into broken shapes).
 * Returns a copy; never mutates the input.
 */
function redactDeep(value) {
  if (typeof value === 'string') return redactUris(value);
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index++) copy[index] = redactDeep(value[index]);
    return copy;
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = redactDeep(value[key]);
    return copy;
  }
  return value;
}

module.exports = { redactDeep, redactOutbound, redactUris };
