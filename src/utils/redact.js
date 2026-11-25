const { isPlainObject } = require('./canonical.js');

/**
 * Credential redaction for anything that leaves the process — error messages,
 * stacks, `--json` payloads, log lines. The MongoDB driver echoes the raw
 * connection URI in several parse errors, so every captured message must pass
 * through here before it can be printed or serialized.
 *
 * A scan of the text, not `new URL()`: multi-host mongodb URIs fail WHATWG parsing,
 * and the URI may sit anywhere inside a larger message (unlike
 * `maskUriCredentials` in template.js, which is anchored to a whole-string URI).
 *
 * Found from each `://` outwards, not by one pattern tried at every position:
 * that pattern (`scheme://user:secret@`, the scheme unbounded) was retried
 * from every character of a long run of scheme characters — quadratic, and
 * 400 KB of letters held the event loop for two minutes, heartbeat timers
 * included. This walk reads each character a bounded number of times.
 */

/** `user:secret@` right after a `://` — sticky, so it is tried there and nowhere else */
const USERINFO = /([^:@/\s]*):[^@/\s]+@/y;

/** The same cut short: a text that ends inside the secret, its `@` past the cut */
const CUT_USERINFO = /([^:@/\s]*):[^@/\s]+$/y;

const isLetter = (code) => (code >= 97 && code <= 122) || (code >= 65 && code <= 90);

const isDigit = (code) => code >= 48 && code <= 57;

/** `+`, `-` and `.`: the punctuation a URI scheme may hold */
const SCHEME_PUNCTUATION = new Set([43, 45, 46]);

/** A character a URI scheme may hold after its first letter: a letter, a digit, `+`, `-`, `.` */
const isSchemeChar = (code) => isLetter(code) || isDigit(code) || SCHEME_PUNCTUATION.has(code);

/** Whether a scheme ends right before `at` — a letter, then scheme characters only */
const schemeEndsAt = (text, at) => {
  for (let i = at - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (isLetter(code)) return true;
    if (!isSchemeChar(code)) return false;
  }
  return false;
};

/**
 * Mask the secret of every `scheme://user:secret@` in `text` (an empty
 * username still hides the password). With `cut`, a secret the text ends
 * inside is masked too: its `@` was past the cut.
 */
const maskCredentials = (text, cut = false) => {
  let at = text.indexOf('://');
  if (at === -1) return text;
  let masked = '';
  let from = 0;
  while (at !== -1) {
    const start = at + 3;
    let next = start;
    if (schemeEndsAt(text, at)) {
      USERINFO.lastIndex = start;
      let match = USERINFO.exec(text);
      let tail = '@';
      if (match === null && cut) {
        CUT_USERINFO.lastIndex = start;
        match = CUT_USERINFO.exec(text);
        tail = '';
      }
      if (match !== null) {
        next = start + match[0].length;
        masked += `${text.slice(from, start)}${match[1]}:****${tail}`;
        from = next;
      }
    }
    at = text.indexOf('://', next);
  }
  return from === 0 ? text : masked + text.slice(from);
};

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
const redactUris = (text) => {
  if (typeof text !== 'string') return text;
  return maskCredentials(text)
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
};

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
const redactOutbound = (text) => {
  if (typeof text !== 'string') return text;
  return redactUris(text).replace(DUPLICATE_KEY_VALUES, '$1{ <redacted> }');
};

/**
 * A duplicate key whose closing brace was past a cut: the pattern above
 * would stop at an inner brace and leave the rest, so the unfinished tail of
 * the last line is masked as a whole.
 */
const CUT_DUPLICATE_KEY_VALUES = /(dup key: )\{[^\n]*$/;

/**
 * {@link redactOutbound} for a text that is kept only up to `limit`
 * characters: redaction reads no more than twice that, so its cost follows
 * what is kept, not what a migration happened to pass in (a megabyte of
 * base64 in a log field, a thousand fields of it). Returns the masked text —
 * not yet cut to `limit`, since masking changes its length — and `cut`:
 * whether the input was longer than what was read.
 */
const redactWithin = (text, limit) => {
  const cut = text.length > limit * 2;
  if (!cut) return { text: redactOutbound(text), cut };
  const head = maskCredentials(text.slice(0, limit * 2), true).replace(
    CUT_DUPLICATE_KEY_VALUES,
    '$1{ <redacted> }',
  );
  return { text: redactOutbound(head), cut };
};

/**
 * Set `key` on a copy as an own property. A plain assignment of `__proto__` —
 * a key `JSON.parse` happily makes — would replace the copy's prototype and
 * lose the key instead.
 */
const put = (target, key, value) => {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
};

/**
 * Redact every string reachable from `value` (plain objects and arrays only —
 * class instances are left alone rather than cloned into broken shapes).
 * Returns a copy; never mutates the input.
 */
const redactDeep = (value) => {
  if (typeof value === 'string') return redactUris(value);
  if (Array.isArray(value)) {
    const copy = [];
    for (let index = 0; index < value.length; index++) copy.push(redactDeep(value[index]));
    return copy;
  }
  if (isPlainObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) put(copy, key, redactDeep(value[key]));
    return copy;
  }
  return value;
};

/**
 * How much of a value {@link redactBounded} copies: nesting, entries in all,
 * the length of one string and of one piece of binary data. What a migration
 * hands to `ctx.logger` is the application's own data, of any size and shape —
 * a cycle included — and a subscriber stores it; these keep one call's copy
 * small and finite.
 */
const BOUNDS = Object.freeze({ depth: 8, entries: 1000, string: 4096, bytes: 4096 });

/** Stands in for what {@link redactBounded} left out */
const TRUNCATED = '[truncated]';

/** The size of binary data — a Buffer or another Uint8Array, a BSON Binary — or undefined */
const byteLength = (item) => {
  if (item instanceof Uint8Array) return item.byteLength;
  if (item._bsontype === 'Binary') return item.position;
  return undefined;
};

/**
 * An Error as data: its name, its message — credentials and the values a
 * server error quotes masked, as for anything that leaves the process — and
 * its code. Not the stack, and not what else it carries: a driver error's raw
 * server response repeats the offending document's values (`keyValue`,
 * `errmsg`), and its `message` is not even enumerable, so the error itself
 * would be stored as an empty document.
 */
const errorData = (error) => {
  const data = {
    name: String(error.name),
    message: redactOutbound(typeof error.message === 'string' ? error.message : ''),
  };
  if (typeof error.code === 'number' || typeof error.code === 'string') data.code = error.code;
  if (typeof error.codeName === 'string') data.codeName = error.codeName;
  return data;
};

/**
 * {@link redactDeep} within {@link BOUNDS}, for data that leaves the process
 * as a document: every string reachable redacted ({@link redactOutbound}: the
 * values a server error quotes too) and clipped, nesting past
 * the depth (which is what ends a cycle) and entries past the budget replaced
 * or dropped. What the driver stores as a value of its own is kept as is — a
 * Date, a RegExp, an ObjectId or another BSON value, and binary data within
 * its bound. An Error becomes `{ name, message, code?, codeName? }`; a Map is
 * copied as an object and a Set as an array; any other instance goes by its
 * `toJSON()`, or its own fields, the way `JSON.stringify` would see it.
 * `omit` names a key left out of the top level only. Returns
 * `{ value, truncated }`; never mutates the input.
 */
const redactBounded = (value, { omit } = {}) => {
  let entries = 0;
  let truncated = false;
  /** One more entry, or false once the budget is spent */
  const take = () => {
    if (entries >= BOUNDS.entries) {
      truncated = true;
      return false;
    }
    entries += 1;
    return true;
  };
  const copy = (item, depth) => {
    if (typeof item === 'string') {
      // Outbound, like the event's message: an error's text copied into a
      // field (`{ error: err.message }`) loses the values it quotes too.
      const { text, cut } = redactWithin(item, BOUNDS.string);
      if (!cut && text.length <= BOUNDS.string) return text;
      truncated = true;
      return `${text.slice(0, BOUNDS.string)}…`;
    }
    if (item === null || typeof item !== 'object') return item;
    if (item instanceof Date || item instanceof RegExp) return item;
    const bytes = byteLength(item);
    if (bytes !== undefined) {
      if (bytes <= BOUNDS.bytes) return item;
      truncated = true;
      return TRUNCATED;
    }
    if (typeof item._bsontype === 'string') return item;
    if (item instanceof Error) return copy(errorData(item), depth);
    if (depth >= BOUNDS.depth) {
      truncated = true;
      return TRUNCATED;
    }
    if (Array.isArray(item) || item instanceof Set) {
      const out = [];
      for (const element of item) {
        if (!take()) break;
        out.push(copy(element, depth + 1));
      }
      return out;
    }
    const out = {};
    if (item instanceof Map) {
      for (const entry of item) {
        if (!take()) break;
        put(out, String(entry[0]), copy(entry[1], depth + 1));
      }
      return out;
    }
    // What JSON.stringify would see: a toJSON() result one level down (so a
    // chain of them ends at the depth bound), else the instance's own fields.
    if (!isPlainObject(item) && typeof item.toJSON === 'function') {
      return copy(item.toJSON(), depth + 1);
    }
    for (const key of Object.keys(item)) {
      if (depth === 0 && key === omit) continue;
      if (!take()) break;
      put(out, key, copy(item[key], depth + 1));
    }
    return out;
  };
  const result = copy(value, 0);
  return { value: result, truncated };
};

module.exports = {
  BOUNDS,
  redactBounded,
  redactDeep,
  redactOutbound,
  redactUris,
  redactWithin,
};
