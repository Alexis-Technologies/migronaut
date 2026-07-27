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
const URI_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g;

/** Mask `scheme://user:secret@` as `scheme://user:****@` anywhere in `text` */
function redactUris(text) {
  if (typeof text !== 'string') return text;
  return text.replace(URI_CREDENTIALS, '$1$2:****@');
}

/**
 * Redact every string reachable from `value` (plain objects and arrays only —
 * class instances are left alone rather than cloned into broken shapes).
 * Returns a copy; never mutates the input.
 */
function redactDeep(value) {
  if (typeof value === 'string') return redactUris(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = redactDeep(value[key]);
    return copy;
  }
  return value;
}

module.exports = { redactUris, redactDeep };
