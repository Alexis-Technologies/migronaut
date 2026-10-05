const { ConfigInvalidError, ShapeVersionError } = require('../errors/index.js');
const { VERSIONING_DEFAULTS, fieldNameIssue, versioningOf } = require('./config.js');
const {
  cloneDocument,
  isPlainObject,
  sameValue,
  toCount,
  touchedFields,
} = require('./internal.js');

/**
 * The document-level contract shared by everything that writes a versioned
 * collection — the repository helpers, the Mongoose plugin and the
 * background-migration engine. They must agree on one model, or a background
 * update would silently overwrite an application write:
 *
 * - a missing (or `null`) version or revision field reads as **0**, so legacy
 *   documents need no backfill before the first guarded write;
 * - every write to a collection with revisions bumps the revision by one
 *   (`$inc`), so an optimistic-concurrency filter `{ _id, rev }` notices any
 *   write that happened in between;
 * - the version is set to an exact number, never incremented — two releases
 *   writing the same shape agree on it.
 *
 * `names` below is `{ field, revisionField }` from `resolveFieldNames` (or a
 * resolved `versioning`); `revisionField` is `null` when revisions are off.
 */

/**
 * The system field names, validated: `{ field, revisionField }` with the
 * defaults filled in and `revisionField: null` under `revision: false`.
 *
 * @throws {ConfigInvalidError} on an invalid name, or both naming one field
 */
function resolveFieldNames({ field, revisionField, revision } = {}) {
  const versionName = field ?? VERSIONING_DEFAULTS.field;
  const revisionName =
    revision === false ? null : (revisionField ?? VERSIONING_DEFAULTS.revisionField);
  for (const [key, name] of [
    ['field', versionName],
    ['revisionField', revisionName],
  ]) {
    if (name === null) continue;
    const issue = fieldNameIssue(name);
    if (issue) throw new ConfigInvalidError(`${key} ${issue}`, { key });
  }
  if (versionName === revisionName) {
    throw new ConfigInvalidError('field and revisionField must differ', { key: 'revisionField' });
  }
  return { field: versionName, revisionField: revisionName };
}

/** A document's count field: 0 when missing or `null`, `null` when not a non-negative integer */
function countOf(doc, field) {
  if (!isPlainObject(doc)) return null;
  const value = doc[field];
  return value === undefined || value === null ? 0 : toCount(value);
}

/** The shape version of `doc` — 0 when the field is missing, `null` when it is not a count */
const versionOf = (doc, field = VERSIONING_DEFAULTS.field) => countOf(doc, field);

/** The revision of `doc` — 0 when the field is missing, `null` when it is not a count */
const revisionOf = (doc, revisionField = VERSIONING_DEFAULTS.revisionField) =>
  countOf(doc, revisionField);

/** The revision after one more write */
const nextRevision = (revision) => (toCount(revision) ?? 0) + 1;

function assertCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigInvalidError(`${what} must be an integer ≥ 0`, { [what]: value });
  }
}

/** `{ [field]: n }`, or — for 0 — a match on the field being 0, `null` or missing */
function countFilter(field, value) {
  return value === 0 ? { [field]: { $in: [null, 0] } } : { [field]: value };
}

/** Documents at exactly `version` (0 = no version field) */
function versionFilter(names, version) {
  assertCount(version, 'version');
  return countFilter(names.field, version);
}

/** Documents at exactly `revision` (0 = no revision field) */
function revisionFilter(names, revision) {
  assertCount(revision, 'revision');
  return countFilter(names.revisionField, revision);
}

/**
 * Documents below `version`: missing or `null` fields, smaller numbers, and
 * anything that is not a number at all (which no validator would accept
 * either). One `$not` range — two intervals of one index scan — rather than
 * an `$or`. `null` for version 0: nothing is below it.
 */
function belowVersionFilter(names, version) {
  assertCount(version, 'version');
  return version === 0 ? null : { [names.field]: { $not: { $gte: version } } };
}

/** The key of the index every version-filtered scan uses */
const versionIndexKey = (names) => ({ [names.field]: 1, _id: 1 });

/**
 * The optimistic-concurrency filter for rewriting `prev`: its `_id`, the
 * exact version it was read at (`from`, by default its own) and — with
 * revisions — the exact revision. A concurrent write moves the revision (or
 * the version), so the rewrite then matches nothing instead of losing it.
 */
function occFilter(prev, names, { from } = {}) {
  const version = from ?? versionOf(prev, names.field);
  const filter = { _id: prev._id };
  if (version === null) filter[names.field] = prev[names.field];
  else Object.assign(filter, countFilter(names.field, version));
  if (names.revisionField !== null) {
    const revision = revisionOf(prev, names.revisionField);
    if (revision === null) filter[names.revisionField] = prev[names.revisionField];
    else Object.assign(filter, countFilter(names.revisionField, revision));
  }
  return filter;
}

/** Why `key` cannot be written as a top-level field with `$set`, or `null` */
function topLevelKeyIssue(key) {
  if (key.length === 0) return 'an empty field name';
  if (key.startsWith('$')) return `a field name starting with '$' ("${key}")`;
  if (key.includes('.')) return `a field name with a dot ("${key}")`;
  if (key.includes('\0')) return 'a field name with NUL';
  return null;
}

function invalidShape(detail, extra) {
  return new ShapeVersionError(`The transformation returned ${detail}`, {
    reason: 'invalid',
    ...extra,
  });
}

const hasKeys = (object) => {
  for (const key in object) if (Object.hasOwn(object, key)) return true;
  return false;
};

/**
 * The operator update that turns `prev` into `next` and stamps it: `$set`
 * for every top-level field whose BSON value changed, `$unset` for every one
 * that disappeared (or became `undefined`), the version set to `to` (unset
 * for `to: 0`), and the revision bumped.
 *
 * Fields that did not change are left out — so the stored BSON type of
 * everything a transformation did not touch survives (a document read with
 * promoted values and written back whole would turn a `Double 1.0` into an
 * `Int32`, a `Long` into a number). A changed nested field rewrites its
 * whole top-level subdocument. `next`'s own version and revision fields are
 * ignored: the engine owns them.
 *
 * @throws {ShapeVersionError} (`reason: 'invalid'`) when `next` is not a
 *   document, changes `_id`, or names a field `$set` cannot write
 */
function stampedDiff(prev, next, names, { to }) {
  if (!isPlainObject(next)) throw invalidShape('something that is not a document');
  assertCount(to, 'to');
  const { field, revisionField } = names;
  const $set = {};
  const $unset = {};
  for (const key of Object.keys(next)) {
    if (key === '_id') {
      if (!sameValue(prev._id, next._id)) throw invalidShape('a document with a different _id');
      continue;
    }
    if (key === field || key === revisionField) continue;
    const issue = topLevelKeyIssue(key);
    if (issue) throw invalidShape(issue, { field: key });
    const value = next[key];
    if (value === undefined) {
      if (Object.hasOwn(prev, key)) $unset[key] = '';
    } else if (!Object.hasOwn(prev, key) || !sameValue(prev[key], value)) {
      $set[key] = value;
    }
  }
  for (const key of Object.keys(prev)) {
    if (key === '_id' || key === field || key === revisionField) continue;
    if (!Object.hasOwn(next, key)) $unset[key] = '';
  }
  if (to === 0) $unset[field] = '';
  else $set[field] = to;
  const update = {};
  if (hasKeys($set)) update.$set = $set;
  if (hasKeys($unset)) update.$unset = $unset;
  if (revisionField !== null) update.$inc = { [revisionField]: 1 };
  return update;
}

function refuseTouch(fields, name, role) {
  if (name !== null && fields.has(name)) {
    throw new ConfigInvalidError(
      `The update must not write the ${role} field "${name}" — migronaut sets it`,
      { field: name },
    );
  }
}

/**
 * Stamp an update the caller wrote: the version set to `to` (left alone when
 * `to` is `undefined`; unset for 0) and the revision bumped. Works on an
 * operator update (merged into its `$set`/`$unset`/`$inc`) and on a pipeline
 * (one stage appended). A replacement document — or a pipeline that projects
 * or replaces the root — is refused: it would drop the revision.
 *
 * @throws {ConfigInvalidError} on a replacement, or an update that writes a
 *   system field itself
 */
function stampedUpdate(names, { to, update }) {
  const { field, revisionField } = names;
  if (to !== undefined) assertCount(to, 'to');
  if (!Array.isArray(update) && !isPlainObject(update)) {
    throw new ConfigInvalidError('The update must be an update document or a pipeline');
  }
  const touched = touchedFields(update);
  if (touched.whole) {
    throw new ConfigInvalidError(
      Array.isArray(update)
        ? 'A pipeline that projects or replaces the document cannot keep its revision'
        : 'A replacement document is not an update — use replaceWithRevision',
    );
  }
  refuseTouch(touched.fields, revisionField, 'revision');
  if (to !== undefined) refuseTouch(touched.fields, field, 'version');

  if (Array.isArray(update)) {
    const stage = {};
    if (to !== undefined && to !== 0) stage[field] = { $literal: to };
    if (revisionField !== null) {
      stage[revisionField] = { $add: [{ $ifNull: [`$${revisionField}`, 0] }, 1] };
    }
    const out = [...update];
    if (hasKeys(stage)) out.push({ $set: stage });
    if (to === 0) out.push({ $unset: field });
    return out;
  }
  const out = { ...update };
  if (to === 0) out.$unset = { ...update.$unset, [field]: '' };
  else if (to !== undefined) out.$set = { ...update.$set, [field]: to };
  if (revisionField !== null) out.$inc = { ...update.$inc, [revisionField]: 1 };
  return out;
}

/**
 * `doc` with its version set to `version` and its revision to 0 — each only
 * when the document does not carry it yet, so stamping is idempotent and a
 * document someone already stamped keeps its fields.
 */
function stampDocument(doc, names, version) {
  if (!isPlainObject(doc)) throw new ConfigInvalidError('Only a plain document can be stamped');
  assertCount(version, 'version');
  const out = { ...doc };
  if (out[names.field] === undefined) out[names.field] = version;
  if (names.revisionField !== null && out[names.revisionField] === undefined) {
    out[names.revisionField] = 0;
  }
  return out;
}

module.exports = {
  belowVersionFilter,
  cloneDocument,
  fieldNameIssue,
  nextRevision,
  occFilter,
  resolveFieldNames,
  revisionFilter,
  revisionOf,
  sameValue,
  stampDocument,
  stampedDiff,
  stampedUpdate,
  versionFilter,
  versionIndexKey,
  versionOf,
  versioningOf,
};
