const { deepEqual, isPlainObject, regExpIssue, toWire } = require('../utils/canonical.js');

/**
 * One declared index against one live index: validation, normalization, and
 * the comparison the converge planner is built on. Pure — no database, no
 * I/O — so every rule here is pinned by a table-driven unit test.
 *
 * The one invariant every rule must keep: an index created from a declaration
 * must compare as unchanged against that same declaration once the server has
 * stored it. A rule that breaks it rebuilds the index on every run.
 */

const TEXT = 'text';
const DIRECTIONS = new Set([1, -1, 'text', 'hashed', '2d', '2dsphere']);

/** Options whose absence means the server's default — compared even when not declared */
const SEMANTIC_OPTIONS = [
  'unique',
  'sparse',
  'hidden',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
  'wildcardProjection',
  'weights',
  'default_language',
  'language_override',
];

/** Compared only when the declaration states them — the server fills in its own otherwise */
const DECLARED_ONLY_OPTIONS = [
  'bits',
  'min',
  'max',
  'storageEngine',
  'textIndexVersion',
  '2dsphereIndexVersion',
];

/** Accepted so a spec copied from `listIndexes` validates, never sent: a no-op since MongoDB 4.2 */
const IGNORED_OPTIONS = ['background'];

/**
 * Every key an index declaration may carry. Strict on purpose: the driver
 * silently drops an option it does not know, so `uniqe: true` would build a
 * non-unique index — and then compare as in sync forever.
 */
const INDEX_KEYS = new Set([
  'key',
  'name',
  ...SEMANTIC_OPTIONS,
  ...DECLARED_ONLY_OPTIONS,
  ...IGNORED_OPTIONS,
]);

/** Every option an index is normalized with — built once, read per index */
const NORMALIZED_OPTIONS = Object.freeze([...SEMANTIC_OPTIONS, ...DECLARED_ONLY_OPTIONS]);

const BOOLEAN_OPTIONS = new Set(['unique', 'sparse', 'hidden', 'background']);
const OBJECT_OPTIONS = new Set([
  'partialFilterExpression',
  'wildcardProjection',
  'weights',
  'storageEngine',
]);
const TEXT_ONLY_OPTIONS = new Set([
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',
]);
const TEXT_DEFAULTS = { default_language: 'english', language_override: 'language' };

/** Field names a plain object moves to the front, whatever order they were written in */
const INTEGER_LIKE = /^(?:0|[1-9]\d*)$/;

/** Whether `entries` name their fields in exactly the order of `fields` */
function sameFieldOrder(entries, fields) {
  return entries.every(([field], position) => fields[position] === field);
}

/** `[field, direction]` pairs, in the order the index uses them */
function keyEntries(key) {
  return key instanceof Map ? [...key.entries()] : Object.entries(key);
}

/** The name MongoDB (and the driver) gives an index declared without one: `email_1`, `a_1_b_-1` */
function defaultIndexName(entries) {
  return entries.map(([field, direction]) => `${field}_${direction}`).join('_');
}

/** Issues with an index key — `null` entries when the key is unusable */
function keyIssues(key, report) {
  if (!(key instanceof Map) && !isPlainObject(key)) {
    report('must be an object (or a Map) of field → direction');
    return null;
  }
  const entries = keyEntries(key);
  if (entries.length === 0) {
    report('must name at least one field');
    return null;
  }
  let usable = true;
  let integerLike = false;
  for (const [field, direction] of entries) {
    if (typeof field !== 'string' || field.length === 0) {
      report('field names must be non-empty strings');
      usable = false;
      continue;
    }
    if (!integerLike && INTEGER_LIKE.test(field)) integerLike = true;
    if (!DIRECTIONS.has(direction)) {
      report(`direction of "${field}" must be 1, -1, 'text', 'hashed', '2d' or '2dsphere'`);
      usable = false;
    }
  }
  if (usable && entries.length > 1 && integerLike) {
    if (!(key instanceof Map)) {
      report(
        'has an integer-like field name — JavaScript reorders such keys, so declare this key ' +
          'as a Map to keep the field order',
      );
      usable = false;
    } else if (!sameFieldOrder(entries, Object.keys(Object.fromEntries(entries)))) {
      // The server keeps the order, but the driver reads `listIndexes` back
      // into a plain object, where integer-like fields move to the front: the
      // live key could never compare as the declared one, and the index would
      // be rebuilt on every run.
      report(
        'puts an integer-like field after another field — the server reports such a key ' +
          'reordered, so converge could never see it as unchanged; manage this index in a ' +
          'migration',
      );
      usable = false;
    }
  }
  if (entries.length === 1 && entries[0][0] === '_id' && entries[0][1] === 1) {
    report('is the _id index, which every collection already has');
    usable = false;
  }
  return usable ? entries : null;
}

/** Validate one index declaration, returning `{ path, message }` issues (empty when valid) */
function indexIssues(index, path) {
  if (!isPlainObject(index)) {
    return [{ path, message: 'must be an index object ({ key, ...options })' }];
  }
  const issues = [];
  const report = (key) => (message) => issues.push({ path: `${path}.${key}`, message });
  for (const key of Object.keys(index)) {
    if (!INDEX_KEYS.has(key)) report(key)('is not a supported index option');
  }
  const entries = keyIssues(index.key, report('key'));
  let isText = false;
  // `wildcardProjection` belongs to an all-fields wildcard (`$**`, compound or
  // not) — the server refuses it on a path wildcard such as `a.$**`.
  let isAllFieldsWildcard = false;
  for (const [field, direction] of entries ?? []) {
    if (direction === TEXT) isText = true;
    if (field === '$**') isAllFieldsWildcard = true;
  }

  if (index.name !== undefined) {
    if (typeof index.name !== 'string' || index.name.length === 0) {
      report('name')('must be a non-empty string');
    } else if (index.name === '_id_') {
      report('name')('is reserved for the _id index');
    }
  }
  for (const option of BOOLEAN_OPTIONS) {
    if (index[option] !== undefined && typeof index[option] !== 'boolean') {
      report(option)('must be a boolean');
    }
  }
  for (const option of OBJECT_OPTIONS) {
    if (index[option] !== undefined && !isPlainObject(index[option])) {
      report(option)('must be an object');
    }
  }
  const filterIssue = regExpIssue(index.partialFilterExpression);
  if (filterIssue) report('partialFilterExpression')(filterIssue);
  const ttl = index.expireAfterSeconds;
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 0)) {
    report('expireAfterSeconds')('must be a non-negative integer (seconds)');
  }
  const collation = index.collation;
  if (
    collation !== undefined &&
    (!isPlainObject(collation) || typeof collation.locale !== 'string' || collation.locale === '')
  ) {
    report('collation')('must be an object with a locale');
  }
  for (const option of ['default_language', 'language_override']) {
    const value = index[option];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      report(option)('must be a non-empty string');
    }
  }
  for (const option of ['textIndexVersion', '2dsphereIndexVersion', 'bits']) {
    const value = index[option];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      report(option)('must be a positive integer');
    }
  }
  for (const option of ['min', 'max']) {
    if (index[option] !== undefined && !Number.isFinite(index[option])) {
      report(option)('must be a finite number');
    }
  }
  if (entries) {
    for (const option of TEXT_ONLY_OPTIONS) {
      if (index[option] !== undefined && !isText) report(option)('only applies to a text index');
    }
    if (index.wildcardProjection !== undefined && !isAllFieldsWildcard) {
      report('wildcardProjection')('only applies to an all-fields wildcard ($**) index');
    }
  }
  return issues;
}

/**
 * The key as the server stores it, and whether it is a text index — in one
 * pass. A text index is not stored under its fields: they collapse into
 * `_fts: 'text', _ftsx: 1` at the position of the first text field, and move
 * into `weights`.
 */
function serverKeyOf(entries) {
  const out = [];
  let isText = false;
  for (const entry of entries) {
    if (entry[1] !== TEXT) {
      out.push(entry);
    } else if (!isText) {
      out.push(['_fts', TEXT], ['_ftsx', 1]);
      isText = true;
    }
  }
  return { serverKey: isText ? out : entries, isText };
}

/** Text fields at weight 1, then whatever the declaration weighs differently */
function textWeights(entries, declared) {
  const weights = {};
  for (const [field, direction] of entries) {
    if (direction === TEXT) weights[field] = 1;
  }
  return { ...weights, ...declared };
}

/**
 * A declaration in comparable form, plus the exact spec to send. Assumes
 * {@link indexIssues} passed.
 */
function normalizeDeclaredIndex(index) {
  const entries = keyEntries(index.key);
  const { serverKey, isText } = serverKeyOf(entries);
  const name = index.name ?? defaultIndexName(entries);
  const options = {};
  for (const option of NORMALIZED_OPTIONS) {
    const value = index[option];
    if (value === undefined) continue;
    // `false` is the server default; sending it would only make the stored
    // spec differ from one created without it (`sparse: false` is kept
    // verbatim by the server).
    if (BOOLEAN_OPTIONS.has(option) && value === false) continue;
    options[option] = toWire(value);
  }
  return {
    name,
    entries,
    serverKey,
    isText,
    options,
    // The key travels as a Map: the field order is the index, and the driver
    // keeps a Map's order where it would re-read a plain object's.
    spec: { key: new Map(entries), name, ...options },
  };
}

/** A `listIndexes` document in comparable form */
function normalizeLiveIndex(raw) {
  const entries = Object.entries(raw.key ?? {});
  const options = {};
  for (const option of NORMALIZED_OPTIONS) {
    const value = raw[option];
    if (value === undefined) continue;
    if (BOOLEAN_OPTIONS.has(option)) {
      // `1` is how some older tools (and shells) stored a flag.
      if (value === true || value === 1) options[option] = true;
      continue;
    }
    options[option] = value;
  }
  return {
    name: raw.name,
    serverKey: entries,
    isText: entries.some(([field, direction]) => field === '_fts' && direction === TEXT),
    options,
    raw,
  };
}

/** Number directions compare by sign — a shell of old stored `1.0`, and Int32/Double wrappers happen */
function sameDirection(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return Math.sign(Number(a)) === Math.sign(Number(b));
}

function sameKey(declared, live) {
  const a = declared.serverKey;
  const b = live.serverKey;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || !sameDirection(a[i][1], b[i][1])) return false;
  }
  return true;
}

/**
 * Collation fields whose default is the same for every locale. A declaration
 * that leaves one out means this value — so a live index built with another
 * (`strength: 2`) is a difference, not a match. Every other field (`caseFirst`,
 * `alternate`, `backwards`, `normalization`, …) has locale-specific defaults
 * and is compared only when declared.
 */
const UNIVERSAL_COLLATION_DEFAULTS = Object.freeze({
  strength: 3,
  caseLevel: false,
  numericOrdering: false,
});

/** A declared collation with the universal defaults filled in */
function withCollationDefaults(collation) {
  if (collation === undefined || collation.locale === 'simple') return collation;
  const filled = { ...UNIVERSAL_COLLATION_DEFAULTS };
  for (const [field, value] of Object.entries(collation)) {
    if (value !== undefined) filled[field] = value;
  }
  return filled;
}

/**
 * Whether the live index's collation is what the declaration asks for.
 *
 * - none declared: the index inherits the collection's default collation —
 *   which the server then writes onto the index, so the live value must be
 *   exactly that default (or absent when the collection has none);
 * - `{ locale: 'simple' }`: binary comparison, stored as no collation at all;
 * - anything else: every declared field must match, and every field with a
 *   locale-independent default ({@link UNIVERSAL_COLLATION_DEFAULTS}) must
 *   hold that default when not declared. The rest is a subset match because
 *   the server expands `{ locale: 'fr' }` into a full ICU spec with
 *   locale-specific defaults — guessing those here would rebuild forever on
 *   the first locale whose defaults differ from the guess.
 */
function collationMatches(declared, liveCollation, defaultCollation) {
  if (declared === undefined) {
    if (defaultCollation === undefined) return liveCollation === undefined;
    return liveCollation !== undefined && deepEqual(liveCollation, defaultCollation);
  }
  if (declared.locale === 'simple') return liveCollation === undefined;
  if (liveCollation === undefined) return false;
  for (const [field, value] of Object.entries(withCollationDefaults(declared))) {
    // A server that omits a universal field reports its default.
    const stored = liveCollation[field] ?? UNIVERSAL_COLLATION_DEFAULTS[field];
    if (!deepEqual(value, stored)) return false;
  }
  return true;
}

/**
 * Same key, same partial filter, same collation: the server treats two such
 * indexes as one and refuses the second (IndexOptionsConflict), whatever
 * their names.
 */
function sameSignature(declared, live, defaultCollation) {
  return (
    sameKey(declared, live) &&
    deepEqual(declared.options.partialFilterExpression, live.options.partialFilterExpression) &&
    collationMatches(declared.options.collation, live.options.collation, defaultCollation)
  );
}

/**
 * Whether two valid declarations describe one index to the server — the
 * check that refuses a definition declaring the same index twice. Collations
 * compare with their universal defaults filled in (`{ locale: 'en' }` and
 * `{ locale: 'en', strength: 3 }` are one index); `{ locale: 'simple' }` and
 * no collation stay apart, since they differ on a collection with a default
 * collation, which a definition cannot know.
 */
function sameDeclaredSignature(a, b) {
  return (
    sameKey(a, b) &&
    deepEqual(a.options.partialFilterExpression, b.options.partialFilterExpression) &&
    deepEqual(
      withCollationDefaults(a.options.collation),
      withCollationDefaults(b.options.collation),
    )
  );
}

/**
 * What the server can change in place, by version — `{ major, minor }` from
 * `buildInfo`, or undefined when unknown (then nothing beyond the always-
 * available `hidden` and TTL change).
 */
function inPlaceCapabilities(version) {
  const atLeast = (major, minor) =>
    version !== undefined &&
    (version.major > major || (version.major === major && version.minor >= minor));
  return {
    // collMod prepareUnique → unique: a non-unique index becomes unique
    // without being dropped — no window without it, no second scan. The
    // commands exist since 6.0, but a 6.0 server reported the conversion and
    // went on accepting duplicates in our tests; 7.0 is where it is enforced.
    unique: atLeast(7, 0),
    // collMod expireAfterSeconds on a single-field index that has no TTL yet.
    addTtl: atLeast(5, 1),
  };
}

/**
 * Compare a declaration with the live index it is paired with.
 *
 * Returns `{ diffs, inPlace }`: `diffs` lists every option that differs,
 * `inPlace` the subset `collMod` can change without a rebuild — the TTL of an
 * index that already has one, and `hidden`; with `capabilities` (see
 * {@link inPlaceCapabilities}) also making an index unique and adding a TTL.
 * Everything else needs the index dropped and created again.
 */
function compareIndex(declared, live, defaultCollation, capabilities = {}) {
  const diffs = [];
  const inPlace = {};
  if (!sameKey(declared, live)) diffs.push('key');
  const d = declared.options;
  const l = live.options;
  if (Boolean(d.unique) !== Boolean(l.unique)) {
    diffs.push('unique');
    // Only towards unique: the server converts that way, not back.
    if (d.unique && capabilities.unique) inPlace.unique = true;
  }
  if (Boolean(d.sparse) !== Boolean(l.sparse)) diffs.push('sparse');
  if (Boolean(d.hidden) !== Boolean(l.hidden)) {
    diffs.push('hidden');
    inPlace.hidden = Boolean(d.hidden);
  }
  const ttlDeclared = d.expireAfterSeconds;
  const ttlLive = l.expireAfterSeconds;
  if (ttlDeclared !== undefined || ttlLive !== undefined) {
    if (ttlDeclared === undefined || ttlLive === undefined) {
      diffs.push('expireAfterSeconds');
      const singleField = declared.serverKey.length === 1 && !declared.isText;
      if (ttlLive === undefined && capabilities.addTtl && singleField) {
        inPlace.expireAfterSeconds = Number(ttlDeclared);
      }
    } else if (Number(ttlDeclared) !== Number(ttlLive)) {
      diffs.push('expireAfterSeconds');
      inPlace.expireAfterSeconds = Number(ttlDeclared);
    }
  }
  if (!deepEqual(d.partialFilterExpression, l.partialFilterExpression)) {
    diffs.push('partialFilterExpression');
  }
  if (!collationMatches(d.collation, l.collation, defaultCollation)) diffs.push('collation');
  if (!deepEqual(d.wildcardProjection, l.wildcardProjection)) diffs.push('wildcardProjection');
  if (declared.isText || live.isText) {
    const weights = declared.isText ? textWeights(declared.entries, d.weights) : undefined;
    if (!deepEqual(weights, l.weights)) diffs.push('weights');
    for (const option of ['default_language', 'language_override']) {
      const want = declared.isText ? (d[option] ?? TEXT_DEFAULTS[option]) : undefined;
      if (want !== l[option]) diffs.push(option);
    }
  }
  for (const option of DECLARED_ONLY_OPTIONS) {
    if (d[option] !== undefined && !deepEqual(d[option], l[option])) diffs.push(option);
  }
  const rebuild = diffs.some((diff) => !(diff in inPlace));
  return { diffs, inPlace: rebuild ? {} : inPlace, rebuild };
}

/**
 * A live index as a spec `createIndexes` accepts — to put back an index whose
 * replacement failed to build. The server-managed fields are left out; the
 * driver drops anything else it does not know.
 */
function restoreSpec(raw) {
  const { v, ns, background, clustered, ...spec } = raw;
  return spec;
}

module.exports = {
  DIRECTIONS,
  inPlaceCapabilities,
  INDEX_KEYS,
  SEMANTIC_OPTIONS,
  compareIndex,
  defaultIndexName,
  indexIssues,
  keyEntries,
  normalizeDeclaredIndex,
  normalizeLiveIndex,
  restoreSpec,
  sameDeclaredSignature,
  sameSignature,
};
