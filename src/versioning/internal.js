/**
 * Small value helpers shared by the versioning runtime. This directory is the
 * `@alexify/migronaut/versioning` subpath: it may require its siblings and
 * `../errors/index.js` only — never the engine, the driver or mongoose — so an
 * application's repository layer pays for nothing else (pinned by a test).
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

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A non-negative safe integer from whatever the driver handed back — a plain
 * number, a `bigint` (`useBigInt64`), an `Int32`, a `Double` or a `Long`
 * (`promoteValues: false`) — or `null` when the value is not one.
 */
function toCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_SAFE ? Number(value) : null;
  }
  const type = bsonType(value);
  if (type === 'Int32' || type === 'Double') return toCount(Number(value.valueOf()));
  if (type === 'Long') {
    if (value.isNegative()) return null;
    const number = value.toNumber();
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const binaryBytes = (value) =>
  value.buffer.subarray(0, typeof value.position === 'number' ? value.position : undefined);

/**
 * Two BSON values of the same class. `undefined` means "cannot tell" — the
 * caller then treats them as different, which costs one rewritten field and
 * never loses a change.
 */
function sameBsonValue(type, a, b) {
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
      return bytesEqual(a.bytes, b.bytes);
    case 'Binary':
    case 'UUID':
      return a.sub_type === b.sub_type && bytesEqual(binaryBytes(a), binaryBytes(b));
    case 'BSONRegExp':
      return a.pattern === b.pattern && a.options === b.options;
    case 'BSONSymbol':
      return String(a.valueOf()) === String(b.valueOf());
    case 'MinKey':
    case 'MaxKey':
      return true;
    case 'Code':
      return a.code === b.code && sameValue(a.scope ?? null, b.scope ?? null);
    case 'DBRef':
      return (
        a.collection === b.collection &&
        a.db === b.db &&
        sameValue(a.oid, b.oid) &&
        sameValue(a.fields ?? {}, b.fields ?? {})
      );
    default:
      return undefined;
  }
}

/**
 * Whether two document values would serialize to the same BSON. Key order
 * counts (`{a, b}` and `{b, a}` are different documents to the server), a
 * `Date` compares by time, a RegExp by source and flags, and a BSON class by
 * its own contents — `Double 1` and `Int32 1` are *different*, because
 * keeping the stored type is the point. Anything this cannot judge is
 * "different": a spurious difference rewrites one field, a spurious sameness
 * would drop a change.
 */
function sameValue(a, b) {
  if (a === b) return a !== 0 || Object.is(a, b);
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object') return false;
  const typeA = bsonType(a);
  const typeB = bsonType(b);
  if (typeA !== undefined || typeB !== undefined) {
    return typeA === typeB && sameBsonValue(typeA, a, b) === true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Date) return b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (ArrayBuffer.isView(a)) {
    return ArrayBuffer.isView(b) && a.constructor === b.constructor && bytesEqual(a, b);
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (key !== keysB[i] || !sameValue(a[key], b[key])) return false;
  }
  return true;
}

/**
 * A copy a transformation may mutate freely: plain objects and arrays are
 * copied all the way down, a `Date` is cloned, and every other value — BSON
 * classes included, which a structured clone would strip of their prototype
 * — is shared.
 */
function cloneDocument(value) {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneDocument(value[i]);
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) setOwn(out, key, cloneDocument(value[key]));
  return out;
}

/**
 * `target[key] = value` as an own, enumerable property — `__proto__` too,
 * which a plain assignment would turn into the object's prototype (a stored
 * field of that name is data, as the BSON parser reads it).
 */
function setOwn(target, key, value) {
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
}

/** `a.b.c` → `a`; `$[]`-style paths keep their first segment too */
const topField = (path) => {
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
};

const PIPELINE_FIELD_STAGES = new Set(['$set', '$addFields']);
const PIPELINE_WHOLE_STAGES = new Set(['$project', '$replaceRoot', '$replaceWith']);

/**
 * The top-level fields an update writes: `{ fields, whole }`, where `whole`
 * means it may rewrite the entire document (a replacement, or a pipeline that
 * projects or replaces the root) and `fields` lists the ones it names.
 */
function touchedFields(update) {
  const fields = new Set();
  if (Array.isArray(update)) {
    let whole = false;
    for (const stage of update) {
      if (!isPlainObject(stage)) continue;
      for (const [operator, spec] of Object.entries(stage)) {
        if (PIPELINE_FIELD_STAGES.has(operator) && isPlainObject(spec)) {
          for (const key of Object.keys(spec)) fields.add(topField(key));
        } else if (operator === '$unset') {
          for (const key of Array.isArray(spec) ? spec : [spec]) {
            if (typeof key === 'string') fields.add(topField(key));
          }
        } else if (PIPELINE_WHOLE_STAGES.has(operator)) {
          whole = true;
          if (operator === '$project' && isPlainObject(spec)) {
            for (const key of Object.keys(spec)) fields.add(topField(key));
          }
        }
      }
    }
    return { fields, whole };
  }
  if (!isPlainObject(update)) return { fields, whole: false };
  // One walk: a key without `$` makes it a replacement document, whose own
  // keys are then the fields; operator specs name theirs.
  const plain = new Set();
  for (const [key, spec] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      plain.add(key);
      continue;
    }
    if (!isPlainObject(spec)) continue;
    for (const [path, value] of Object.entries(spec)) {
      fields.add(topField(path));
      if (key === '$rename' && typeof value === 'string') fields.add(topField(value));
    }
  }
  return plain.size > 0 ? { fields: plain, whole: true } : { fields, whole: false };
}

const LOGICAL = new Set(['$and', '$or', '$nor']);

/** `"$__rev"` or `"$__rev.x"` inside a serialized `$expr` — not `"$__revision"` */
const fieldReference = (field) =>
  new RegExp(`"\\$${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:"|\\.)`);

/** Whether a query filter constrains `field` (at the top level, or through `$and`/`$or`/`$nor`) */
function filterTouches(filter, field) {
  if (!isPlainObject(filter)) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key) && Array.isArray(value)) {
      for (const branch of value) if (filterTouches(branch, field)) return true;
    } else if (key === '$expr') {
      if (fieldReference(field).test(JSON.stringify(value ?? null))) return true;
    } else if (!key.startsWith('$') && topField(key) === field) {
      return true;
    }
  }
  return false;
}

module.exports = {
  bsonType,
  cloneDocument,
  filterTouches,
  isPlainObject,
  sameValue,
  setOwn,
  toCount,
  topField,
  touchedFields,
};
