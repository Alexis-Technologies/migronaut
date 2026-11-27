const { isDeepEqual, isPlainObject, checkRegExp, toWire } = require('../../utils/canonical.js');
const { isVersionAtLeast } = require('../server-info.js');

/** Index options that are finite numbers (the 2d bounds) */
const FINITE_OPTIONS = Object.freeze(['min', 'max']);

/** A text index's string options */
const TEXT_STRING_OPTIONS = Object.freeze(['default_language', 'language_override']);

/** Index options that are positive integers */
const POSITIVE_INTEGER_OPTIONS = Object.freeze([
  'textIndexVersion',
  '2dsphereIndexVersion',
  'bits',
]);

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
const NORMALIZED_OPTIONS = Object.freeze(SEMANTIC_OPTIONS.concat(DECLARED_ONLY_OPTIONS));

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

/** Whether `entries` name their fields in exactly the order of `fields` */
const isSameFieldOrder = (entries, fields) => {
  for (let i = 0; i < entries.length; i++) {
    if (fields[i] !== entries[i][0]) return false;
  }
  return true;
};

/** `[field, direction]` pairs, in the order the index uses them */
const toKeyEntries = (key) => {
  const entries = [];
  if (key instanceof Map) {
    for (const entry of key.entries()) entries.push(entry);
    return entries;
  }
  const fields = Object.keys(key);
  for (let i = 0; i < fields.length; i++) entries.push([fields[i], key[fields[i]]]);
  return entries;
};

/** The name MongoDB (and the driver) gives an index declared without one: `email_1`, `a_1_b_-1` */
const buildDefaultIndexName = (entries) => {
  let name = '';
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) name += '_';
    name += `${entries[i][0]}_${entries[i][1]}`;
  }
  return name;
};

/** Issues with an index key — `null` entries when the key is unusable */
const checkKey = (key, report) => {
  if (!(key instanceof Map) && !isPlainObject(key)) {
    report('must be an object (or a Map) of field → direction');
    return null;
  }
  const entries = toKeyEntries(key);
  if (entries.length === 0) {
    report('must name at least one field');
    return null;
  }
  let isUsable = true;
  let isIntegerLike = false;
  for (let i = 0; i < entries.length; i++) {
    const field = entries[i][0];
    const direction = entries[i][1];
    if (typeof field !== 'string' || field.length === 0) {
      report('field names must be non-empty strings');
      isUsable = false;
      continue;
    }
    if (!isIntegerLike && INTEGER_LIKE.test(field)) isIntegerLike = true;
    if (!DIRECTIONS.has(direction)) {
      report(`direction of "${field}" must be 1, -1, 'text', 'hashed', '2d' or '2dsphere'`);
      isUsable = false;
    }
  }
  if (isUsable && entries.length > 1 && isIntegerLike) {
    if (!(key instanceof Map)) {
      report(
        'has an integer-like field name — JavaScript reorders such keys, so declare this key ' +
          'as a Map to keep the field order',
      );
      isUsable = false;
    } else if (!isSameFieldOrder(entries, Object.keys(Object.fromEntries(entries)))) {
      // The server keeps the order, but the driver reads `listIndexes` back
      // into a plain object, where integer-like fields move to the front: the
      // live key could never compare as the declared one, and the index would
      // be rebuilt on every run.
      report(
        'puts an integer-like field after another field — the server reports such a key ' +
          'reordered, so converge could never see it as unchanged; manage this index in a ' +
          'migration',
      );
      isUsable = false;
    }
  }
  if (entries.length === 1 && entries[0][0] === '_id' && entries[0][1] === 1) {
    report('is the _id index, which every collection already has');
    isUsable = false;
  }
  return isUsable ? entries : null;
};

/** Validate one index declaration, returning `{ path, message }` issues (empty when valid) */
const checkIndex = (index, path) => {
  if (!isPlainObject(index)) {
    return [{ path, message: 'must be an index object ({ key, ...options })' }];
  }
  const issues = [];
  const report = (key) => (message) => issues.push({ path: `${path}.${key}`, message });
  for (const key of Object.keys(index)) {
    if (!INDEX_KEYS.has(key)) report(key)('is not a supported index option');
  }
  const entries = checkKey(index.key, report('key'));
  let isText = false;
  // `wildcardProjection` belongs to an all-fields wildcard (`$**`, compound or
  // not) — the server refuses it on a path wildcard such as `a.$**`.
  let isAllFieldsWildcard = false;
  if (entries !== null) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i][1] === TEXT) isText = true;
      if (entries[i][0] === '$**') isAllFieldsWildcard = true;
    }
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
  const filterIssue = checkRegExp(index.partialFilterExpression);
  if (filterIssue) report('partialFilterExpression')(filterIssue);
  const ttlSeconds = index.expireAfterSeconds;
  if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0)) {
    report('expireAfterSeconds')('must be a non-negative integer (seconds)');
  }
  const collation = index.collation;
  const isCollationInvalid =
    collation !== undefined &&
    (!isPlainObject(collation) || typeof collation.locale !== 'string' || collation.locale === '');
  if (isCollationInvalid) {
    report('collation')('must be an object with a locale');
  }
  for (const option of TEXT_STRING_OPTIONS) {
    const value = index[option];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      report(option)('must be a non-empty string');
    }
  }
  for (const option of POSITIVE_INTEGER_OPTIONS) {
    const value = index[option];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      report(option)('must be a positive integer');
    }
  }
  for (const option of FINITE_OPTIONS) {
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
};

/**
 * The key as the server stores it, and whether it is a text index — in one
 * pass. A text index is not stored under its fields: they collapse into
 * `_fts: 'text', _ftsx: 1` at the position of the first text field, and move
 * into `weights`.
 */
const toServerKey = (entries) => {
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
};

/** Text fields at weight 1, then whatever the declaration weighs differently */
const computeTextWeights = (entries, declared) => {
  const weights = { __proto__: null };
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][1] === TEXT) weights[entries[i][0]] = 1;
  }
  return { ...weights, ...declared };
};

/**
 * A declaration in comparable form, plus the exact spec to send. Assumes
 * {@link checkIndex} passed.
 */
const normalizeDeclaredIndex = (index) => {
  const entries = toKeyEntries(index.key);
  const { serverKey, isText } = toServerKey(entries);
  const name = index.name ?? buildDefaultIndexName(entries);
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
};

/** A `listIndexes` document in comparable form */
const normalizeLiveIndex = (raw) => {
  const key = raw.key ?? {};
  const fields = Object.keys(key);
  const entries = [];
  let isText = false;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const direction = key[field];
    entries.push([field, direction]);
    if (field === '_fts' && direction === TEXT) isText = true;
  }
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
    isText,
    options,
    raw,
  };
};

/**
 * Number directions compare by sign — a shell of old stored `1.0`, and Int32/Double wrappers happen
 */
const isSameDirection = (a, b) => {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return Math.sign(Number(a)) === Math.sign(Number(b));
};

const isSameKey = (declared, live) => {
  const a = declared.serverKey;
  const b = live.serverKey;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || !isSameDirection(a[i][1], b[i][1])) return false;
  }
  return true;
};

/** A declared collation with the universal defaults filled in */
const withCollationDefaults = (collation) => {
  if (collation === undefined || collation.locale === 'simple') return collation;
  const filled = { ...UNIVERSAL_COLLATION_DEFAULTS };
  const fields = Object.keys(collation);
  for (let i = 0; i < fields.length; i++) {
    const value = collation[fields[i]];
    if (value !== undefined) filled[fields[i]] = value;
  }
  return filled;
};

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
const matchesCollation = (declared, liveCollation, defaultCollation) => {
  if (declared === undefined) {
    if (defaultCollation === undefined) return liveCollation === undefined;
    return liveCollation !== undefined && isDeepEqual(liveCollation, defaultCollation);
  }
  if (declared.locale === 'simple') return liveCollation === undefined;
  if (liveCollation === undefined) return false;
  const filled = withCollationDefaults(declared);
  const fields = Object.keys(filled);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // A server that omits a universal field reports its default.
    const stored = liveCollation[field] ?? UNIVERSAL_COLLATION_DEFAULTS[field];
    if (!isDeepEqual(filled[field], stored)) return false;
  }
  return true;
};

/**
 * Same key, same partial filter, same collation: the server treats two such
 * indexes as one and refuses the second (IndexOptionsConflict), whatever
 * their names.
 */
const isSameSignature = (declared, live, defaultCollation) => {
  if (!isSameKey(declared, live)) return false;
  const { options } = declared;
  const samePartial = isDeepEqual(
    options.partialFilterExpression,
    live.options.partialFilterExpression,
  );
  return (
    samePartial && matchesCollation(options.collation, live.options.collation, defaultCollation)
  );
};

/**
 * Whether two valid declarations describe one index to the server — the
 * check that refuses a definition declaring the same index twice. Collations
 * compare with their universal defaults filled in (`{ locale: 'en' }` and
 * `{ locale: 'en', strength: 3 }` are one index); `{ locale: 'simple' }` and
 * no collation stay apart, since they differ on a collection with a default
 * collation, which a definition cannot know.
 */
const isSameDeclaredSignature = (a, b) => {
  if (!isSameKey(a, b)) return false;
  if (!isDeepEqual(a.options.partialFilterExpression, b.options.partialFilterExpression)) {
    return false;
  }
  const collationA = withCollationDefaults(a.options.collation);
  return isDeepEqual(collationA, withCollationDefaults(b.options.collation));
};

/**
 * What the server can change in place, by version — `{ major, minor }` from
 * `buildInfo`, or undefined when unknown (then nothing beyond the always-
 * available `hidden` and TTL change).
 */
const resolveInPlaceCapabilities = (version) => {
  return {
    // collMod prepareUnique → unique: a non-unique index becomes unique
    // without being dropped — no window without it, no second scan. The
    // commands exist since 6.0, but a 6.0 server reported the conversion and
    // went on accepting duplicates in our tests; 7.0 is where it is enforced.
    unique: isVersionAtLeast(version, 7, 0),
    // collMod expireAfterSeconds on a single-field index that has no TTL yet.
    addTtl: isVersionAtLeast(version, 5, 1),
  };
};

/**
 * Compare a declaration with the live index it is paired with.
 *
 * Returns `{ diffs, inPlace }`: `diffs` lists every option that differs,
 * `inPlace` the subset `collMod` can change without a rebuild — the TTL of an
 * index that already has one, and `hidden`; with `capabilities` (see
 * {@link resolveInPlaceCapabilities}) also making an index unique and adding a TTL.
 * Everything else needs the index dropped and created again.
 */
const compareIndex = (declared, live, defaultCollation, capabilities = {}) => {
  const diffs = [];
  const inPlace = {};
  if (!isSameKey(declared, live)) diffs.push('key');
  const declaredOptions = declared.options;
  const liveOptions = live.options;
  if (Boolean(declaredOptions.unique) !== Boolean(liveOptions.unique)) {
    diffs.push('unique');
    // Only towards unique: the server converts that way, not back.
    if (declaredOptions.unique && capabilities.unique) inPlace.unique = true;
  }
  // What a conversion to unique leaves when it fails and its rollback does
  // too: the index refuses new duplicates, and nothing else says so — `unique`
  // is still false on both sides. On a declaration that is not unique it is a
  // constraint nobody declared: taken off in place. (On a unique one the
  // conversion above goes through it anyway.)
  if (live.raw?.prepareUnique === true && !declaredOptions.unique) {
    diffs.push('prepareUnique');
    inPlace.prepareUnique = false;
  }
  if (Boolean(declaredOptions.sparse) !== Boolean(liveOptions.sparse)) diffs.push('sparse');
  if (Boolean(declaredOptions.hidden) !== Boolean(liveOptions.hidden)) {
    diffs.push('hidden');
    inPlace.hidden = Boolean(declaredOptions.hidden);
  }
  const ttlDeclared = declaredOptions.expireAfterSeconds;
  const ttlLive = liveOptions.expireAfterSeconds;
  if (ttlDeclared !== undefined || ttlLive !== undefined) {
    if (ttlDeclared === undefined || ttlLive === undefined) {
      diffs.push('expireAfterSeconds');
      const isSingleField = declared.serverKey.length === 1 && !declared.isText;
      if (ttlLive === undefined && capabilities.addTtl && isSingleField) {
        inPlace.expireAfterSeconds = Number(ttlDeclared);
      }
    } else if (Number(ttlDeclared) !== Number(ttlLive)) {
      diffs.push('expireAfterSeconds');
      inPlace.expireAfterSeconds = Number(ttlDeclared);
    }
  }
  if (!isDeepEqual(declaredOptions.partialFilterExpression, liveOptions.partialFilterExpression)) {
    diffs.push('partialFilterExpression');
  }
  if (!matchesCollation(declaredOptions.collation, liveOptions.collation, defaultCollation)) {
    diffs.push('collation');
  }
  if (!isDeepEqual(declaredOptions.wildcardProjection, liveOptions.wildcardProjection)) {
    diffs.push('wildcardProjection');
  }
  if (declared.isText || live.isText) {
    const weights = declared.isText
      ? computeTextWeights(declared.entries, declaredOptions.weights)
      : undefined;
    if (!isDeepEqual(weights, liveOptions.weights)) diffs.push('weights');
    for (const option of TEXT_STRING_OPTIONS) {
      const want = declared.isText ? (declaredOptions[option] ?? TEXT_DEFAULTS[option]) : undefined;
      if (want !== liveOptions[option]) diffs.push(option);
    }
  }
  for (const option of DECLARED_ONLY_OPTIONS) {
    if (
      declaredOptions[option] !== undefined &&
      !isDeepEqual(declaredOptions[option], liveOptions[option])
    ) {
      diffs.push(option);
    }
  }
  let shouldRebuild = false;
  for (let i = 0; i < diffs.length; i++) {
    if (!(diffs[i] in inPlace)) {
      shouldRebuild = true;
      break;
    }
  }
  return { diffs, inPlace: shouldRebuild ? {} : inPlace, rebuild: shouldRebuild };
};

/**
 * A live index as a spec `createIndexes` accepts — to put back an index whose
 * replacement failed to build. The server-managed fields are left out; the
 * driver drops anything else it does not know.
 */
const restoreSpec = (raw) => {
  const { v, ns, background, clustered, ...spec } = raw;
  return spec;
};

module.exports = {
  DIRECTIONS,
  SEMANTIC_OPTIONS,
  INDEX_KEYS,
  toKeyEntries,
  buildDefaultIndexName,
  checkIndex,
  normalizeDeclaredIndex,
  normalizeLiveIndex,
  isSameSignature,
  isSameDeclaredSignature,
  resolveInPlaceCapabilities,
  compareIndex,
  restoreSpec,
};
