const { isPlainObject } = require('../utils/canonical.js');
const { versionIndexKey } = require('../versioning/document.js');

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

module.exports = {
  isVersioningIndexKey,
  mergeVersioningValidator,
  validatorVersioningIssues,
  versioningIndex,
  versioningRules,
};
