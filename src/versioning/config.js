const { ConfigInvalidError } = require('../errors/index.js');
const { isPlainObject } = require('./internal.js');

/**
 * The `versioning` block of a collection definition — one source of truth for
 * the shape version a collection is at, read by converge (validator, index,
 * the `min` guard), by the background-migration engine and by the
 * application's repository layer through `defineShapes`.
 *
 * Validated strictly, like every other definition key: a typo (`currnet`)
 * must not read as "not versioned".
 */

const VERSIONING_KEYS = ['current', 'min', 'field', 'revision', 'revisionField', 'index'];
const VERSIONING_KEY_SET = new Set(VERSIONING_KEYS);

const VERSIONING_DEFAULTS = Object.freeze({
  min: 1,
  field: '__v',
  revision: true,
  revisionField: '__rev',
  index: true,
});

/** Longest field name accepted for the version or revision field */
const MAX_FIELD_NAME = 64;

/**
 * Why `name` cannot be a system field, or `null`. Top-level only: the engine
 * writes it with `$set`/`$inc`, so a dot would address a nested path and a
 * leading `$` an operator; `_id` is immutable.
 */
function fieldNameIssue(name) {
  if (typeof name !== 'string' || name.length === 0) return 'must be a non-empty string';
  if (name.length > MAX_FIELD_NAME) return `must be at most ${MAX_FIELD_NAME} characters`;
  if (name.startsWith('$')) return "must not start with '$'";
  if (name.includes('.')) return "must be a top-level field (no '.')";
  if (name.includes('\0')) return 'must not contain NUL';
  if (name === '_id') return 'must not be _id';
  return null;
}

const isCount = (value, floor) => Number.isSafeInteger(value) && value >= floor;

/**
 * Validate a `versioning` value, returning `{ path, message }` issues (empty
 * when valid). `path` is where it sits — `collections[2].versioning`,
 * `orders.ts: versioning`.
 */
function versioningIssues(value, path = 'versioning') {
  if (!isPlainObject(value)) {
    return [
      {
        path,
        message: 'must be an object: { current, min?, field?, revision?, revisionField?, index? }',
      },
    ];
  }
  const issues = [];
  const report = (key, message) => issues.push({ path: `${path}.${key}`, message });
  for (const key of Object.keys(value)) {
    if (!VERSIONING_KEY_SET.has(key)) {
      report(key, `is not a versioning key (expected one of: ${VERSIONING_KEYS.join(', ')})`);
    }
  }
  const { current, min, field, revision, revisionField, index } = value;
  const currentValid = isCount(current, 1);
  if (current === undefined) report('current', 'is required');
  else if (!currentValid) report('current', 'must be an integer ≥ 1');
  // The default min (1) never exceeds a valid current (≥ 1).
  if (min !== undefined) {
    if (!isCount(min, 0)) report('min', 'must be an integer ≥ 0');
    else if (currentValid && min > current) {
      report('min', `must not exceed current (${current})`);
    }
  }
  if (field !== undefined) {
    const issue = fieldNameIssue(field);
    if (issue) report('field', issue);
  }
  if (revision !== undefined && typeof revision !== 'boolean') {
    report('revision', 'must be a boolean');
  }
  if (revisionField !== undefined) {
    const issue = fieldNameIssue(revisionField);
    if (issue) report('revisionField', issue);
    else if (revision === false) report('revisionField', 'has no effect with revision: false');
  }
  if (revision !== false) {
    const versionName = field ?? VERSIONING_DEFAULTS.field;
    const revisionName = revisionField ?? VERSIONING_DEFAULTS.revisionField;
    if (versionName === revisionName) {
      report('revisionField', `must differ from the version field ("${versionName}")`);
    }
  }
  if (index !== undefined && typeof index !== 'boolean') report('index', 'must be a boolean');
  return issues;
}

/**
 * A validated `versioning` value with every default filled in, frozen.
 * `revisionField` is `null` when revisions are off.
 *
 * @throws {ConfigInvalidError} with every issue in `context.issues`
 */
function resolveVersioning(value, { path = 'versioning' } = {}) {
  const issues = versioningIssues(value, path);
  if (issues.length > 0) {
    throw new ConfigInvalidError(`Invalid ${path}: ${issues[0].path} ${issues[0].message}`, {
      issues,
    });
  }
  const revision = value.revision ?? VERSIONING_DEFAULTS.revision;
  return Object.freeze({
    current: value.current,
    min: value.min ?? VERSIONING_DEFAULTS.min,
    field: value.field ?? VERSIONING_DEFAULTS.field,
    revision,
    revisionField: revision ? (value.revisionField ?? VERSIONING_DEFAULTS.revisionField) : null,
    index: value.index ?? VERSIONING_DEFAULTS.index,
  });
}

/**
 * The resolved versioning of `collection` among `definitions` — an array of
 * definitions (each with `name`) or a `{ name: definition }` map — or `null`
 * when it is not declared or not versioned.
 */
function versioningOf(definitions, collection) {
  let definition;
  if (Array.isArray(definitions)) {
    for (const candidate of definitions) {
      if (isPlainObject(candidate) && candidate.name === collection) {
        definition = candidate;
        break;
      }
    }
  } else if (isPlainObject(definitions) && Object.hasOwn(definitions, collection)) {
    definition = definitions[collection];
  }
  if (!isPlainObject(definition) || definition.versioning === undefined) return null;
  return resolveVersioning(definition.versioning, { path: `${collection}.versioning` });
}

module.exports = {
  MAX_FIELD_NAME,
  VERSIONING_DEFAULTS,
  VERSIONING_KEYS,
  fieldNameIssue,
  resolveVersioning,
  versioningIssues,
  versioningOf,
};
