/**
 * Value comparison for declared state against what the server returns.
 *
 * The server stores a validator or a partial filter exactly as it was sent,
 * but "as sent" and "as declared" are not the same JavaScript value: object
 * keys may come back in another order, an `Int32` or a `Long` may stand where
 * the declaration had a plain number, and an `undefined` property is either
 * dropped or stored as `null` depending on the client's `ignoreUndefined`.
 * `canonical` maps both sides onto one JSON-safe shape so that a plain string
 * comparison decides equality.
 *
 * Arrays keep their order — `required: ['a', 'b']` and `['b', 'a']` are
 * different documents to the server, and treating them as equal would hide a
 * real change. A false "changed" costs one idempotent command; a false "same"
 * would leave the database out of step with the declaration forever.
 */

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A BSON value class from the driver (`Int32`, `Long`, `ObjectId`, …) */
const bsonType = (value) =>
  value !== null && typeof value === 'object' && typeof value._bsontype === 'string'
    ? value._bsontype
    : undefined;

function canonicalNumber(number) {
  if (Number.isNaN(number)) return { $number: 'NaN' };
  if (!Number.isFinite(number)) return { $number: number > 0 ? 'Infinity' : '-Infinity' };
  // -0 and 0 are the same BSON value for every purpose a validator has.
  return number === 0 ? 0 : number;
}

function canonicalBson(type, value) {
  if (type === 'Int32' || type === 'Double') return canonicalNumber(Number(value.valueOf()));
  if (type === 'Long') {
    const number = value.toNumber();
    return Number.isSafeInteger(number) ? number : { $long: value.toString() };
  }
  if (type === 'ObjectId' || type === 'ObjectID') return { $oid: value.toHexString() };
  if (type === 'Decimal128') return { $decimal: value.toString() };
  if (type === 'BSONRegExp') return { $regex: value.pattern, $options: sortFlags(value.options) };
  // Binary, Timestamp, MinKey, … — rare in a validator. Their JSON form is
  // stable and type-tagged, which is all equality needs.
  const json = typeof value.toJSON === 'function' ? value.toJSON() : String(value);
  return { $bson: type, value: canonical(json) };
}

function sortFlags(flags) {
  return [...String(flags)].sort().join('');
}

/**
 * A JavaScript RegExp's flags as the server stores them. The driver writes
 * `i` and `m` as they are, `g` as the server's `s` (dotAll) — and drops every
 * other flag. Comparing in this form is what lets a declared `/x/i` and the
 * `/x/i` read back compare equal, and a `BSONRegExp('x', 's')` match too.
 */
const DRIVER_REGEXP_FLAGS = { i: 'i', m: 'm', g: 's' };
function storedFlags(flags) {
  let out = '';
  for (const flag of String(flags)) out += DRIVER_REGEXP_FLAGS[flag] ?? '';
  return out;
}

/** JavaScript RegExp flags that do not survive the trip to the server as written */
const UNSTORABLE_FLAGS = /[^im]/g;

/**
 * Why `value` cannot be stored as declared — a RegExp whose flags the driver
 * changes (`g` becomes dotAll) or drops (`s`, `u`, `y`, `d`, `v`) — or null.
 * A `BSONRegExp` states server options directly and is always fine.
 */
function regExpIssue(value, seen = new Set()) {
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
  const items =
    value instanceof Map
      ? [...value.values()]
      : Array.isArray(value)
        ? value
        : isPlainObject(value)
          ? Object.values(value)
          : [];
  for (const item of items) {
    const issue = regExpIssue(item, seen);
    if (issue) return issue;
  }
  return null;
}

/**
 * Why `value` cannot be sent as declared — a function, a symbol, a cycle, or a
 * RegExp the driver would change (see {@link regExpIssue}) — or null. Walks
 * plain objects and arrays, the shapes a declaration is written in.
 */
function unsendable(value, seen = new Set()) {
  if (seen.size === 0) {
    const issue = regExpIssue(value);
    if (issue) return issue;
  }
  const type = typeof value;
  if (type === 'function') return 'must not contain functions';
  if (type === 'symbol') return 'must not contain symbols';
  if (value === null || type !== 'object') return null;
  if (seen.has(value)) return 'must not contain circular references';
  seen.add(value);
  const items = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  for (const item of items) {
    const reason = unsendable(item, seen);
    if (reason) return reason;
  }
  seen.delete(value);
  return null;
}

/**
 * Assign without invoking setters: a key named `__proto__` (JSON.parse makes
 * one an own property) must stay a key, not replace the object's prototype —
 * otherwise it vanishes from what is sent and what is compared.
 */
function assign(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A JSON-safe, key-sorted stand-in for `value` (see the module comment) */
function canonical(value) {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return canonicalNumber(value);
  if (type === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : { $long: value.toString() };
  }
  if (type !== 'object') return { $opaque: type };
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = canonical(value[i]);
    return out;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return { $date: Number.isNaN(time) ? 'invalid' : value.toISOString() };
  }
  if (value instanceof RegExp) {
    return { $regex: value.source, $options: sortFlags(storedFlags(value.flags)) };
  }
  const bson = bsonType(value);
  if (bson !== undefined) return canonicalBson(bson, value);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  if (!(value instanceof Map) && !isPlainObject(value)) return { $opaque: 'object' };
  const out = {};
  const keys = [];
  for (const [key, item] of entries) {
    // Dropped, not nulled: that is what the declaration means, and what a
    // client with `ignoreUndefined` stores. toWire() makes sure it is also
    // what migronaut itself sends.
    if (item !== undefined) keys.push([String(key), item]);
  }
  keys.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [key, item] of keys) assign(out, key, canonical(item));
  return out;
}

/** Deep equality under {@link canonical} */
function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * A copy of a declared value fit to send: plain objects lose their
 * `undefined` properties, everything else (arrays, Dates, RegExps, BSON
 * values) is kept as is. Without it a declared `undefined` would be stored as
 * `null` by a client with the default `ignoreUndefined: false`, and the next
 * comparison would report a change that can never converge.
 */
function toWire(value) {
  if (Array.isArray(value)) return value.map((item) => toWire(item));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) assign(out, key, toWire(item));
  }
  return out;
}

module.exports = { canonical, deepEqual, isPlainObject, regExpIssue, toWire, unsendable };
