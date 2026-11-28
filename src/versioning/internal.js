/**
 * Small value helpers shared by the versioning runtime. This directory is the
 * `@alexify/migronaut/versioning` subpath: it may require its siblings and
 * `../errors/index.js` only — never the engine, the driver or mongoose — so an
 * application's repository layer pays for nothing else (pinned by a test).
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const PIPELINE_FIELD_STAGES = new Set(['$set', '$addFields']);

const PIPELINE_WHOLE_STAGES = new Set(['$project', '$replaceRoot', '$replaceWith']);

const LOGICAL = new Set(['$and', '$or', '$nor']);

/** `"$__rev"` or `"$__rev.x"` inside a serialized `$expr` — not `"$__revision"` */
const references = new Map();

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

/**
 * A non-negative safe integer from whatever the driver handed back — a plain
 * number, a `bigint` (`useBigInt64`), an `Int32`, a `Double` or a `Long`
 * (`promoteValues: false`) — or `null` when the value is not one.
 */
const toCount = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_SAFE ? Number(value) : null;
  }
  const type = readBsonType(value);
  if (type === 'Int32' || type === 'Double') return toCount(Number(value.valueOf()));
  if (type === 'Long') {
    if (value.isNegative()) return null;
    const number = value.toNumber();
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
};

const isEqualBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const readBinaryBytes = (value) => {
  return value.buffer.subarray(0, typeof value.position === 'number' ? value.position : undefined);
};

/**
 * Two BSON values of the same class. `undefined` means "cannot tell" — the
 * caller then treats them as different, which costs one rewritten field and
 * never loses a change.
 */
const isSameBsonValue = (type, a, b) => {
  switch (type) {
    case 'ObjectId':
    case 'ObjectID':
      return a.toHexString() === b.toHexString();
    case 'Long':
    case 'Timestamp':
      return a.equals(b) && a.unsigned === b.unsigned;
    case 'Int32':
    case 'Double':
      return Object.is(Number(a.valueOf()), Number(b.valueOf()));
    case 'Decimal128':
      return isEqualBytes(a.bytes, b.bytes);
    case 'Binary':
    case 'UUID':
      return a.sub_type === b.sub_type && isEqualBytes(readBinaryBytes(a), readBinaryBytes(b));
    case 'BSONRegExp':
      return a.pattern === b.pattern && a.options === b.options;
    case 'BSONSymbol':
      return `${a.valueOf()}` === `${b.valueOf()}`;
    case 'MinKey':
    case 'MaxKey':
      return true;
    case 'Code':
      return a.code === b.code && isSameValue(a.scope ?? null, b.scope ?? null);
    case 'DBRef':
      if (a.collection !== b.collection || a.db !== b.db) return false;
      return isSameValue(a.oid, b.oid) && isSameValue(a.fields ?? {}, b.fields ?? {});
    default:
      return undefined;
  }
};

/**
 * Whether two document values would serialize to the same BSON. Key order
 * counts (`{a, b}` and `{b, a}` are different documents to the server), a
 * `Date` compares by time, a RegExp by source and flags, and a BSON class by
 * its own contents — `Double 1` and `Int32 1` are *different*, because
 * keeping the stored type is the point. Anything this cannot judge is
 * "different": a spurious difference rewrites one field, a spurious sameness
 * would drop a change.
 */
const isSameValue = (a, b) => {
  if (a === b) return a !== 0 || Object.is(a, b);
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object') return false;
  const typeA = readBsonType(a);
  const typeB = readBsonType(b);
  if (typeA !== undefined || typeB !== undefined) {
    return typeA === typeB && isSameBsonValue(typeA, a, b) === true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isSameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Date) return b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (ArrayBuffer.isView(a)) {
    return ArrayBuffer.isView(b) && a.constructor === b.constructor && isEqualBytes(a, b);
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (key !== keysB[i] || !isSameValue(a[key], b[key])) return false;
  }
  return true;
};

/**
 * A copy a transformation may mutate freely: plain objects and arrays are
 * copied all the way down, a `Date` is cloned, and every other value — BSON
 * classes included, which a structured clone would strip of their prototype
 * — is shared.
 */
const cloneDocument = (value) => {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(cloneDocument(value[i]));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) setOwn(out, key, cloneDocument(value[key]));
  return out;
};

/**
 * `target[key] = value` as an own, enumerable property — `__proto__` too,
 * which a plain assignment would turn into the object's prototype (a stored
 * field of that name is data, as the BSON parser reads it).
 */
const setOwn = (target, key, value) => {
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
 * A collection definition as a module may hand it over: an ES-module
 * namespace (`import * as orders`, or `require` of an ES module) carries it
 * as its `default`.
 */
const unwrapDefinition = (value) => (isPlainObject(value?.default) ? value.default : value);

/** `a.b.c` → `a`; `$[]`-style paths keep their first segment too */
const readTopField = (path) => {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
};

/** The top field of every string path in `paths` */
const addTopFields = (fields, paths) => {
  for (let i = 0; i < paths.length; i++) {
    if (typeof paths[i] === 'string') fields.add(readTopField(paths[i]));
  }
};

/**
 * The fields one pipeline stage names, into `fields` — and whether it may
 * rewrite the entire document.
 */
const collectStageFields = (fields, stage) => {
  let isWhole = false;
  const operators = Object.keys(stage);
  for (let i = 0; i < operators.length; i++) {
    const operator = operators[i];
    const spec = stage[operator];
    if (PIPELINE_FIELD_STAGES.has(operator) && isPlainObject(spec)) {
      addTopFields(fields, Object.keys(spec));
    } else if (operator === '$unset') {
      addTopFields(fields, Array.isArray(spec) ? spec : [spec]);
    } else if (PIPELINE_WHOLE_STAGES.has(operator)) {
      isWhole = true;
      if (operator === '$project' && isPlainObject(spec)) addTopFields(fields, Object.keys(spec));
    }
  }
  return isWhole;
};

/**
 * The top-level fields an update writes: `{ fields, whole }`, where `whole`
 * means it may rewrite the entire document (a replacement, or a pipeline that
 * projects or replaces the root) and `fields` lists the ones it names.
 */
const collectTouchedFields = (update) => {
  const fields = new Set();
  if (Array.isArray(update)) {
    let isWhole = false;
    for (let i = 0; i < update.length; i++) {
      const stage = update[i];
      if (isPlainObject(stage) && collectStageFields(fields, stage)) isWhole = true;
    }
    return { fields, whole: isWhole };
  }
  if (!isPlainObject(update)) return { fields, whole: false };
  // One walk: a key without `$` makes it a replacement document, whose own
  // keys are then the fields; operator specs name theirs.
  const plain = new Set();
  const keys = Object.keys(update);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const spec = update[key];
    if (!key.startsWith('$')) {
      plain.add(key);
      continue;
    }
    if (!isPlainObject(spec)) continue;
    const paths = Object.keys(spec);
    for (let j = 0; j < paths.length; j++) {
      const path = paths[j];
      const value = spec[path];
      fields.add(readTopField(path));
      if (key === '$rename' && typeof value === 'string') fields.add(readTopField(value));
    }
  }
  return plain.size > 0 ? { fields: plain, whole: true } : { fields, whole: false };
};

const getReferencePattern = (field) => {
  // Built once per field: every guarded write asks.
  let pattern = references.get(field);
  if (pattern === undefined) {
    pattern = new RegExp(`"\\$${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:"|\\.)`);
    references.set(field, pattern);
  }
  return pattern;
};

/** Whether a query filter constrains `field` (at the top level, or through `$and`/`$or`/`$nor`) */
const filterTouches = (filter, field) => {
  if (!isPlainObject(filter)) return false;
  const keys = Object.keys(filter);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = filter[key];
    if (LOGICAL.has(key) && Array.isArray(value)) {
      for (let j = 0; j < value.length; j++) if (filterTouches(value[j], field)) return true;
    } else if (key === '$expr') {
      if (getReferencePattern(field).test(JSON.stringify(value ?? null))) return true;
    } else if (!key.startsWith('$') && readTopField(key) === field) {
      return true;
    }
  }
  return false;
};

module.exports = {
  isPlainObject,
  readBsonType,
  toCount,
  isSameValue,
  cloneDocument,
  setOwn,
  unwrapDefinition,
  readTopField,
  collectTouchedFields,
  filterTouches,
};
