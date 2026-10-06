const { isPlainObject } = require('../utils/canonical.js');
const { versionIndexKey } = require('../versioning/document.js');
const { toCount } = require('../versioning/internal.js');

/**
 * What a collection's `versioning` block asks of the database: the validator
 * rules for the version and revision fields, merged into whatever validator
 * the definition declares, and the index every version-filtered scan uses.
 * Pure — collections.js folds the result into the normalized definition, so
 * the planner sees an ordinary validator and an ordinary index.
 *
 * The version rule has a `minimum` but never a `maximum`: during a rolling
 * deploy (or after a rollback) a newer release writes a higher version than
 * the declaration knows, and refusing that write would turn a deploy into an
 * outage. A revision outgrows `int` after 2³¹ writes — `$inc` turns it into a
 * `long` — so both are accepted.
 */

/** `{ required, properties }` for the managed fields, in a fixed order */
function versioningRules(versioning) {
  const { field, min, revisionField } = versioning;
  const properties = { [field]: { bsonType: 'int', minimum: min } };
  const required = [field];
  if (revisionField !== null) {
    properties[revisionField] = { bsonType: ['int', 'long'], minimum: 0 };
    required.push(revisionField);
  }
  // `min: 0` adapts a collection whose documents predate versioning: the
  // fields are typed when present, but nothing requires them yet.
  return min === 0 ? { properties } : { required, properties };
}

/** The managed field names a validator already constrains itself */
function managedFieldsIn(validator, versioning) {
  const managed = [versioning.field];
  if (versioning.revisionField !== null) managed.push(versioning.revisionField);
  const found = new Set();
  const schema = validator.$jsonSchema;
  const properties = isPlainObject(schema) ? schema.properties : undefined;
  const required = new Set(
    isPlainObject(schema) && Array.isArray(schema.required) ? schema.required : [],
  );
  for (const name of managed) {
    if (Object.hasOwn(validator, name)) found.add(name);
    if (isPlainObject(properties) && Object.hasOwn(properties, name)) found.add(name);
    if (required.has(name)) found.add(name);
  }
  return [...found];
}

/**
 * Why a declared validator cannot carry the versioning rules — it constrains
 * a managed field itself, or its `$jsonSchema` is not a schema object. Empty
 * when the merge can go ahead.
 */
function validatorVersioningIssues(validator, versioning) {
  if (validator === undefined) return [];
  if (validator === null || !isPlainObject(validator)) {
    return ['is null, which would remove the versioning rules — drop the validator key instead'];
  }
  const issues = [];
  if (validator.$jsonSchema !== undefined && !isPlainObject(validator.$jsonSchema)) {
    issues.push('$jsonSchema must be an object to take the versioning rules');
  } else if (
    isPlainObject(validator.$jsonSchema) &&
    validator.$jsonSchema.required !== undefined &&
    !Array.isArray(validator.$jsonSchema.required)
  ) {
    issues.push('$jsonSchema.required must be an array to take the versioning rules');
  }
  for (const name of managedFieldsIn(validator, versioning)) {
    issues.push(`constrains "${name}", which is managed by versioning — remove that rule`);
  }
  return issues;
}

/**
 * The validator to declare: the versioning rules alone (no validator
 * declared), merged into the declared `$jsonSchema` (the declared `required`
 * and `properties` first, ours after), or — next to query operators — added
 * as a top-level `$jsonSchema`, which the server combines with them.
 */
function mergeVersioningValidator(validator, versioning) {
  const rules = versioningRules(versioning);
  if (validator === undefined || Object.keys(validator).length === 0) {
    return { $jsonSchema: rules };
  }
  const schema = validator.$jsonSchema;
  if (!isPlainObject(schema)) return { ...validator, $jsonSchema: rules };
  const merged = { ...schema };
  if (rules.required) merged.required = [...(schema.required ?? []), ...rules.required];
  merged.properties = { ...schema.properties, ...rules.properties };
  return { ...validator, $jsonSchema: merged };
}

/** The declared version index — `{ [field]: 1, _id: 1 }`, named by its key */
const versioningIndex = (versioning) => ({ key: versionIndexKey(versioning) });

/**
 * The version index of a sharded collection: the shard key between the
 * version field and `_id` — `{ __v: 1, region: 1, _id: 1 }` — so a batch
 * over one chunk's range is an index range, not a filter over every old
 * document of the shard. A hashed field stays hashed; `_id` is not repeated
 * when the key holds it. On `{ _id: 1 }` it is the ordinary version index.
 */
function shardedVersionIndexKey(versioning, shardKey) {
  const key = { [versioning.field]: 1 };
  for (const [field, value] of Object.entries(shardKey)) {
    if (field !== versioning.field) key[field] = value;
  }
  if (!('_id' in key)) key._id = 1;
  return key;
}

/** Whether an index key is the version index's (same fields, same order, ascending) */
function isVersioningIndexKey(key, versioning) {
  if (!isPlainObject(key)) return false;
  const entries = Object.entries(key);
  const expected = Object.entries(versionIndexKey(versioning));
  if (entries.length !== expected.length) return false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][0] !== expected[i][0] || Number(entries[i][1]) !== expected[i][1]) return false;
  }
  return true;
}

/**
 * The version floor the live validator enforces — the `minimum` of the version
 * field's `$jsonSchema` rule — or `null` when it enforces none.
 */
function liveVersionFloor(options, versioning) {
  const schema = options?.validator?.$jsonSchema;
  const rule = isPlainObject(schema?.properties) ? schema.properties[versioning.field] : undefined;
  return isPlainObject(rule) ? toCount(rule.minimum) : null;
}

/**
 * The `min` converge must check the data against before it raises the floor,
 * or `null` when there is nothing to check: no versioning, `min: 0`, a
 * collection that does not exist yet (no documents), or a floor already that
 * high. Only a rising floor costs a read — the steady state costs nothing.
 */
function versionFloorToCheck(definition, live) {
  const versioning = definition.versioning;
  if (!versioning || versioning.min === 0 || !live.exists) return null;
  if (live.type !== undefined && live.type !== 'collection') return null;
  const floor = liveVersionFloor(live.options, versioning);
  return floor !== null && floor >= versioning.min ? null : versioning.min;
}

/**
 * Why the version floor cannot be raised — `live.versionFloor` is what
 * converge read: `{ min, below: true | false | 'unknown', error? }` — or
 * `undefined` when it can. The document ids are never named: they may be PII.
 */
function versionFloorConflict(floor) {
  if (!floor || floor.below === false) return undefined;
  if (floor.below === true) {
    return (
      `documents below version ${floor.min} remain — raising versioning.min would leave them ` +
      'invalid; let the background migration that upgrades them finish (migronaut background ' +
      'status), then converge again'
    );
  }
  return (
    `could not check for documents below version ${floor.min} (${floor.error}) — converge ` +
    'with the old min first so the version index exists, then raise it'
  );
}

module.exports = {
  isVersioningIndexKey,
  shardedVersionIndexKey,
  liveVersionFloor,
  versionFloorConflict,
  versionFloorToCheck,
  mergeVersioningValidator,
  validatorVersioningIssues,
  versioningIndex,
  versioningRules,
};
