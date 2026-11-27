/**
 * Value comparison for declared state against what the server returns.
 *
 * The server stores a validator or a partial filter exactly as it was sent,
 * but "as sent" and "as declared" are not the same JavaScript value: object
 * keys may come back in another order, an `Int32` or a `Long` may stand where
 * the declaration had a plain number, and an `undefined` property is either
 * dropped or stored as `null` depending on the client's `ignoreUndefined`.
 * `canonicalize` maps both sides onto one JSON-safe shape so that a plain string
 * comparison decides equality.
 *
 * Arrays keep their order — `required: ['a', 'b']` and `['b', 'a']` are
 * different documents to the server, and treating them as equal would hide a
 * real change. A false "changed" costs one idempotent command; a false "same"
 * would leave the database out of step with the declaration forever.
 */

/**
 * A JavaScript RegExp's flags as the server stores them. The driver writes
 * `i` and `m` as they are, `g` as the server's `s` (dotAll) — and drops every
 * other flag. Comparing in this form is what lets a declared `/x/i` and the
 * `/x/i` read back compare equal, and a `BSONRegExp('x', 's')` match too.
 */
const DRIVER_REGEXP_FLAGS = { __proto__: null, i: 'i', m: 'm', g: 's' };

/** JavaScript RegExp flags that do not survive the trip to the server as written */
const UNSTORABLE_FLAGS = /[^im]/g;

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A BSON value class from the driver (`Int32`, `Long`, `ObjectId`, …) */
const readBsonType = (value) => {
  return value !== null && typeof value === 'object' && typeof value._bsontype === 'string'
    ? value._bsontype
    : undefined;
};

const canonicalizeNumber = (number) => {
  if (Number.isNaN(number)) return { $number: 'NaN' };
  if (!Number.isFinite(number)) return { $number: number > 0 ? 'Infinity' : '-Infinity' };
  // -0 and 0 are the same BSON value for every purpose a validator has.
  return number === 0 ? 0 : number;
};

const canonicalizeBson = (type, value) => {
  if (type === 'Int32' || type === 'Double') return canonicalizeNumber(Number(value.valueOf()));
  if (type === 'Long') {
    const number = value.toNumber();
    return Number.isSafeInteger(number) ? number : { $long: value.toString() };
  }
  if (type === 'ObjectId' || type === 'ObjectID') return { $oid: value.toHexString() };
  if (type === 'Decimal128') return { $decimal: value.toString() };
  if (type === 'BSONRegExp') return { $regex: value.pattern, $options: sortFlags(value.options) };
  // Binary, Timestamp, MinKey, … — rare in a validator. Their JSON form is
  // stable and type-tagged, which is all equality needs.
  const json = typeof value.toJSON === 'function' ? value.toJSON() : `${value}`;
  return { $bson: type, value: canonicalize(json) };
};

const sortFlags = (flags) => {
  const characters = [...`${flags}`];
  characters.sort();
  return characters.join('');
};

const toStoredFlags = (flags) => {
  let out = '';
  for (const flag of `${flags}`) out += DRIVER_REGEXP_FLAGS[flag] ?? '';
  return out;
};

/**
 * Why `value` cannot be stored as declared — a RegExp whose flags the driver
 * changes (`g` becomes dotAll) or drops (`s`, `u`, `y`, `d`, `v`) — or null.
 * A `BSONRegExp` states server options directly and is always fine.
 */
const checkRegExp = (value, seen = new Set()) => {
  if (value instanceof RegExp) {
    const bad = value.flags.match(UNSTORABLE_FLAGS);
    return bad
      ? `regular expression /${value.source}/${value.flags}: flag(s) ${bad.join('')} cannot be ` +
          'stored as written (the driver keeps only i and m, and turns g into dotAll) — use ' +
          "BSONRegExp from 'bson' for server options"
      : null;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value instanceof Map) {
    for (const item of value.values()) {
      const issue = checkRegExp(item, seen);
      if (issue) return issue;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = checkRegExp(value[i], seen);
      if (issue) return issue;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const issue = checkRegExp(value[keys[i]], seen);
    if (issue) return issue;
  }
  return null;
};

/**
 * Why `value` cannot be sent as declared — a function, a symbol, a cycle, or a
 * RegExp the driver would change (see {@link checkRegExp}) — or null. Walks
 * plain objects and arrays, the shapes a declaration is written in.
 */
const findUnsendable = (value, seen = new Set()) => {
  if (seen.size === 0) {
    const issue = checkRegExp(value);
    if (issue) return issue;
  }
  const type = typeof value;
  if (type === 'function') return 'must not contain functions';
  if (type === 'symbol') return 'must not contain symbols';
  if (value === null || type !== 'object') return null;
  if (seen.has(value)) return 'must not contain circular references';
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const reason = findUnsendable(value[i], seen);
      if (reason) return reason;
    }
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const reason = findUnsendable(value[keys[i]], seen);
      if (reason) return reason;
    }
  }
  seen.delete(value);
  return null;
};

/**
 * Set `key` on `target` as an own property. Only `__proto__` needs
 * `defineProperty` — the one accessor of `Object.prototype`: a key JSON.parse
 * makes an own property must stay a key, not replace the object's prototype
 * and vanish from what is sent and what is compared. Every other key is a
 * plain assignment, which the comparison — on every plan, replan, verify and
 * settle read — pays far less for. (src/versioning keeps a copy of its own:
 * it requires nothing outside itself.)
 */
const assign = (target, key, value) => {
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

/** Orders `[key, item]` pairs by key, as the default sort orders strings */
const byKey = (a, b) => {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  return 0;
};

/** A JSON-safe, key-sorted stand-in for `value` (see the module comment) */
const canonicalize = (value) => {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return canonicalizeNumber(value);
  if (type === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : { $long: value.toString() };
  }
  if (type !== 'object') return { $opaque: type };
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(canonicalize(value[i]));
    return out;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return { $date: Number.isNaN(time) ? 'invalid' : value.toISOString() };
  }
  if (value instanceof RegExp) {
    return { $regex: value.source, $options: sortFlags(toStoredFlags(value.flags)) };
  }
  const bson = readBsonType(value);
  if (bson !== undefined) return canonicalizeBson(bson, value);
  const isMap = value instanceof Map;
  if (!isMap && !isPlainObject(value)) return { $opaque: 'object' };
  // An `undefined` item is dropped, not nulled: that is what the declaration
  // means, and what a client with `ignoreUndefined` stores. toWire() makes
  // sure it is also what migronaut itself sends.
  const pairs = [];
  if (isMap) {
    for (const entry of value) {
      if (entry[1] !== undefined) pairs.push([String(entry[0]), entry[1]]);
    }
  } else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const item = value[key];
      if (item !== undefined) pairs.push([key, item]);
    }
  }
  pairs.sort(byKey);
  const out = {};
  for (let i = 0; i < pairs.length; i++) assign(out, pairs[i][0], canonicalize(pairs[i][1]));
  return out;
};

/** Deep equality under {@link canonicalize} */
const isDeepEqual = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/**
 * A copy of a declared value fit to send: plain objects lose their
 * `undefined` properties, everything else (arrays, Dates, RegExps, BSON
 * values) is kept as is. Without it a declared `undefined` would be stored as
 * `null` by a client with the default `ignoreUndefined: false`, and the next
 * comparison would report a change that can never converge.
 */
const toWire = (value) => {
  if (Array.isArray(value)) {
    // A hole of a sparse declaration stays a hole, as Array#map left it.
    const out = [];
    for (let i = 0; i < value.length; i++) {
      if (i in value) out.push(toWire(value[i]));
      else out.length = i + 1;
    }
    return out;
  }
  if (!isPlainObject(value)) return value;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const item = value[key];
    if (item !== undefined) assign(out, key, toWire(item));
  }
  return out;
};

module.exports = {
  isPlainObject,
  readBsonType,
  checkRegExp,
  findUnsendable,
  assign,
  canonicalize,
  isDeepEqual,
  toWire,
};
