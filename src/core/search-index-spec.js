const {
  assign,
  canonical,
  deepEqual,
  isPlainObject,
  toWire,
  unsendable,
} = require('../utils/canonical.js');

/**
 * One declared Atlas Search / Vector Search index against one live index:
 * validation, normalization, and the comparison the converge planner builds
 * on. Pure — no database, no I/O — like index-spec.js for regular indexes.
 *
 * A search index definition is Atlas's own document, and Atlas keeps adding
 * to it, so it is validated lightly (the shape that tells the two types apart,
 * nothing about analyzers or field types) and compared whole. The invariant is
 * the one index-spec.js keeps: an index created from a declaration must
 * compare as unchanged against that same declaration once the server reports
 * it — hence the documented defaults, filled in on both sides before
 * comparing, so a definition that leaves one out matches a server that spells
 * it out (and the other way round). An option the server reports that the
 * declaration does not set, and whose default is not among those, is ignored
 * (see {@link tolerateServerOptions}): a newer mongot writing a new default
 * must not make every converge update — and Atlas rebuild — the index.
 */

/** Every key a search index declaration may carry */
const SEARCH_INDEX_KEYS = ['name', 'type', 'definition'];
const SEARCH_INDEX_KEY_SET = new Set(SEARCH_INDEX_KEYS);
const SEARCH_INDEX_TYPES = ['search', 'vectorSearch'];

/** What the server names an index declared without a name, and the type it assumes */
const DEFAULT_SEARCH_INDEX_NAME = 'default';
const DEFAULT_SEARCH_INDEX_TYPE = 'search';

/**
 * Statuses of an index the server is removing: it no longer serves queries,
 * but its name is not free yet — a create under that name can fail until it
 * is gone.
 */
const ABSENT_STATUSES = new Set(['DELETING', 'DOES_NOT_EXIST']);

/**
 * Top-level defaults of an Atlas Search definition, as documented. Filled in
 * on both sides — `searchAnalyzer` defaults to the effective `analyzer`.
 */
const SEARCH_DEFAULTS = Object.freeze({
  analyzer: 'lucene.standard',
  storedSource: false,
  numPartitions: 1,
  analyzers: [],
  synonyms: [],
});
const MAPPINGS_DEFAULTS = Object.freeze({ dynamic: false, fields: {} });

/**
 * Defaults of a field mapping, by type — what `mongot` writes into the
 * definition it reports (a `string` field comes back with `indexOptions`,
 * `store` and `norms`, a `number` with its representation, a `document` with
 * `dynamic`). Types not listed come back as declared.
 */
const FIELD_DEFAULTS = Object.freeze({
  string: { indexOptions: 'offsets', store: true, norms: 'include' },
  number: { representation: 'double', indexIntegers: true, indexDoubles: true },
  numberFacet: { representation: 'double', indexIntegers: true, indexDoubles: true },
  autocomplete: { minGrams: 2, maxGrams: 15, foldDiacritics: true, tokenization: 'edgeGram' },
  token: { normalization: 'none' },
  geo: { indexShapes: false },
  document: { dynamic: false, fields: {} },
  embeddedDocuments: { dynamic: false, fields: {} },
});

/** Defaults of a vector field — and of an automated-embedding (`autoEmbed`) one */
const VECTOR_FIELD_DEFAULTS = Object.freeze({ quantization: 'none', indexingMethod: 'hnsw' });
const AUTO_EMBED_FIELD_DEFAULTS = Object.freeze({
  numDimensions: 1024,
  quantization: 'scalar',
  indexingMethod: 'hnsw',
});
const HNSW_DEFAULTS = Object.freeze({ maxEdges: 16, numEdgeCandidates: 100 });

/**
 * What the server cannot change on an automated-embedding field: a new
 * model, size, quantization or modality means new embeddings, so Atlas
 * refuses the update — the documented way is a new index under a new name.
 * (The field's `path` and `type` are immutable too, checked separately.)
 */
const AUTO_EMBED_IMMUTABLE = ['model', 'numDimensions', 'quantization', 'modality'];

const VECTOR = 'vector';
const AUTO_EMBED = 'autoEmbed';

/** Validate one search index declaration, returning `{ path, message }` issues (empty when valid) */
function searchIndexIssues(index, path) {
  if (!isPlainObject(index)) {
    return [{ path, message: 'must be a search index object ({ name?, type?, definition })' }];
  }
  const issues = [];
  const report = (key, message) => issues.push({ path: `${path}.${key}`, message });
  for (const key of Object.keys(index)) {
    if (!SEARCH_INDEX_KEY_SET.has(key)) {
      report(key, `is not a search index key (expected one of: ${SEARCH_INDEX_KEYS.join(', ')})`);
    }
  }
  if (index.name !== undefined && (typeof index.name !== 'string' || index.name.length === 0)) {
    report('name', 'must be a non-empty string');
  }
  const typeValid = index.type === undefined || SEARCH_INDEX_TYPES.includes(index.type);
  if (!typeValid) report('type', "must be 'search' or 'vectorSearch'");

  const { definition } = index;
  if (definition === undefined) {
    report('definition', 'is required');
    return issues;
  }
  if (!isPlainObject(definition)) {
    report('definition', 'must be an object');
    return issues;
  }
  const reason = unsendable(definition);
  if (reason) {
    report('definition', reason);
    return issues;
  }
  if (!typeValid) return issues;
  if ((index.type ?? DEFAULT_SEARCH_INDEX_TYPE) === 'search') {
    if (Array.isArray(definition.fields) && definition.mappings === undefined) {
      report(
        'definition',
        "has top-level fields, which is a vectorSearch definition — set type: 'vectorSearch'",
      );
    } else if (!isPlainObject(definition.mappings)) {
      report('definition.mappings', 'is required — an object ({ dynamic, fields })');
    }
    return issues;
  }
  vectorDefinitionIssues(definition, `${path}.definition`, issues);
  return issues;
}

function vectorDefinitionIssues(definition, base, issues) {
  if (definition.mappings !== undefined && definition.fields === undefined) {
    issues.push({
      path: base,
      message: "has mappings, which is a search definition — leave type out, or set type: 'search'",
    });
    return;
  }
  const { fields } = definition;
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.push({
      path: `${base}.fields`,
      message: 'must be a non-empty array of fields ({ type, path, … })',
    });
    return;
  }
  const seen = new Map();
  const kinds = new Set();
  for (const [position, field] of fields.entries()) {
    const fieldPath = `${base}.fields[${position}]`;
    const usable =
      isPlainObject(field) &&
      typeof field.type === 'string' &&
      field.type.length > 0 &&
      typeof field.path === 'string' &&
      field.path.length > 0;
    if (!usable) {
      issues.push({ path: fieldPath, message: 'must be an object with a string type and path' });
      continue;
    }
    if (field.type === VECTOR || field.type === AUTO_EMBED) kinds.add(field.type);
    const id = `${field.type}\u0000${field.path}`;
    if (seen.has(id)) {
      issues.push({
        path: fieldPath,
        message: `repeats the ${field.type} field "${field.path}" (fields[${seen.get(id)}])`,
      });
    } else {
      seen.set(id, position);
    }
  }
  if (kinds.size > 1) {
    issues.push({
      path: `${base}.fields`,
      message: 'mixes vector and autoEmbed fields — an index holds one kind or the other',
    });
  }
}

/**
 * The type a definition is written for: a vector search definition is a
 * top-level `fields` list, a search definition has `mappings`. For the live
 * indexes of a server that does not report a type (a self-managed `mongot`).
 */
function inferSearchIndexType(definition) {
  return isPlainObject(definition) &&
    Array.isArray(definition.fields) &&
    definition.mappings === undefined
    ? 'vectorSearch'
    : DEFAULT_SEARCH_INDEX_TYPE;
}

/** A declaration in comparable form — assumes {@link searchIndexIssues} passed */
function normalizeDeclaredSearchIndex(index) {
  return {
    name: index.name ?? DEFAULT_SEARCH_INDEX_NAME,
    type: index.type ?? DEFAULT_SEARCH_INDEX_TYPE,
    definition: toWire(index.definition),
  };
}

/** Whether any mongot is still building a newer definition next to the one it serves */
function isUpdating(raw, version) {
  if (!Array.isArray(raw.statusDetail)) return false;
  return raw.statusDetail.some((detail) => {
    if (!isPlainObject(detail)) return false;
    if (detail.stagedIndex !== undefined && detail.stagedIndex !== null) return true;
    const served = detail.mainIndex?.definitionVersion?.version;
    return version !== undefined && typeof served === 'number' && served < version;
  });
}

/**
 * The longest build message kept — mongot's reasons are a line or two, and a
 * longer one would go whole into every log line, table cell and history entry
 */
const MAX_BUILD_MESSAGE_LENGTH = 500;

const shortMessage = (message) =>
  message.length > MAX_BUILD_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_BUILD_MESSAGE_LENGTH - 1)}…`
    : message;

/** A `$listSearchIndexes` document in comparable form */
function normalizeLiveSearchIndex(raw) {
  const definition = isPlainObject(raw.latestDefinition) ? raw.latestDefinition : {};
  // `latestVersion` is what a self-managed mongot (an Atlas CLI local deployment) reports.
  const version = raw.latestDefinitionVersion?.version ?? raw.latestVersion;
  return {
    name: raw.name,
    type: SEARCH_INDEX_TYPES.includes(raw.type) ? raw.type : inferSearchIndexType(definition),
    definition,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    queryable: raw.queryable === true,
    ...(typeof raw.message === 'string' && raw.message !== ''
      ? { message: shortMessage(raw.message) }
      : {}),
    ...(typeof version === 'number' ? { version } : {}),
    updating: isUpdating(raw, typeof version === 'number' ? version : undefined),
    raw,
  };
}

/** Whether the server is removing this index (its name is not free yet) */
function isBeingRemoved(live) {
  return ABSENT_STATUSES.has(live.status);
}

/**
 * `defaults` under `value`: what `value` leaves out takes the default. Keys
 * are assigned, not set — a `__proto__` key must stay a key.
 */
function withDefaults(value, defaults) {
  const out = { ...defaults };
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) assign(out, key, item);
  }
  return out;
}

function effectiveVectorField(field) {
  if (!isPlainObject(field)) return field;
  const defaults =
    field.type === VECTOR
      ? VECTOR_FIELD_DEFAULTS
      : field.type === AUTO_EMBED
        ? AUTO_EMBED_FIELD_DEFAULTS
        : undefined;
  if (!defaults) return field;
  const filled = withDefaults(field, defaults);
  if (filled.indexingMethod === 'hnsw') {
    filled.hnswOptions = withDefaults(
      isPlainObject(filled.hnswOptions) ? filled.hnswOptions : {},
      HNSW_DEFAULTS,
    );
  }
  return filled;
}

/** Fields in one order — they are a set to the server: by type, then path, then content */
function sortFields(fields) {
  const keyed = fields.map((field) => ({
    field,
    type: String(field?.type ?? ''),
    path: String(field?.path ?? ''),
    text: JSON.stringify(canonical(field)),
  }));
  keyed.sort(
    (a, b) =>
      compareText(a.type, b.type) || compareText(a.path, b.path) || compareText(a.text, b.text),
  );
  return keyed.map(({ field }) => field);
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A field mapping — or a list of them, one field indexed as several types —
 * with its type's defaults filled in, nested `fields` and `multi` analyzers
 * too. A list is a set to the server (it reports the types in its own
 * order), so it is sorted.
 */
function effectiveFieldMapping(mapping) {
  if (Array.isArray(mapping)) {
    return sortMappings(mapping.map((item) => effectiveFieldMapping(item)));
  }
  if (!isPlainObject(mapping)) return mapping;
  const defaults = FIELD_DEFAULTS[mapping.type];
  const filled = defaults ? withDefaults(mapping, defaults) : { ...mapping };
  if (isPlainObject(filled.fields)) filled.fields = effectiveFields(filled.fields);
  if (isPlainObject(filled.multi)) filled.multi = effectiveFields(filled.multi);
  return filled;
}

/** The mappings of one field, in one order — the server reports them in its own */
function sortMappings(mappings) {
  return mappings
    .map((item) => ({ item, text: JSON.stringify(canonical(item)) }))
    .sort((a, b) => compareText(a.text, b.text))
    .map(({ item }) => item);
}

/** `{ name: mapping }` with every mapping's defaults filled in */
function effectiveFields(fields) {
  const out = {};
  for (const [name, mapping] of Object.entries(fields)) {
    assign(out, name, effectiveFieldMapping(mapping));
  }
  return out;
}

/**
 * A definition with every documented default filled in — what the server
 * means by it. Only the defaults are filled; anything else stays as written,
 * so a real difference is never hidden.
 */
function effectiveDefinition(type, definition) {
  if (!isPlainObject(definition)) return definition;
  if (type === 'vectorSearch') {
    const filled = withDefaults(definition, { storedSource: false });
    if (Array.isArray(filled.fields)) {
      filled.fields = sortFields(filled.fields.map((field) => effectiveVectorField(field)));
    }
    return filled;
  }
  const filled = withDefaults(definition, SEARCH_DEFAULTS);
  if (filled.searchAnalyzer === undefined) filled.searchAnalyzer = filled.analyzer;
  if (isPlainObject(filled.mappings)) {
    filled.mappings = withDefaults(filled.mappings, MAPPINGS_DEFAULTS);
    if (isPlainObject(filled.mappings.fields)) {
      filled.mappings.fields = effectiveFields(filled.mappings.fields);
    }
  }
  return filled;
}

/** The autoEmbed fields of an effective vector definition, by path */
function autoEmbedFields(definition) {
  const out = new Map();
  for (const field of Array.isArray(definition?.fields) ? definition.fields : []) {
    if (isPlainObject(field) && field.type === AUTO_EMBED) out.set(field.path, field);
  }
  return out;
}

/** Fields by path, whatever their type — to tell a vector field turning into an autoEmbed one */
function fieldsByPath(definition) {
  const out = new Map();
  for (const field of Array.isArray(definition?.fields) ? definition.fields : []) {
    if (isPlainObject(field) && (field.type === VECTOR || field.type === AUTO_EMBED)) {
      out.set(field.path, field);
    }
  }
  return out;
}

/**
 * What changing a vector index from `live` to `declared` would ask of an
 * automated-embedding field that the server refuses to change in place:
 * `path.attribute` entries (`plot.model`, `plot.type`, `path`), or none.
 */
function immutableChanges(declared, live) {
  const wanted = autoEmbedFields(declared);
  const have = autoEmbedFields(live);
  if (wanted.size === 0 && have.size === 0) return [];
  const changes = [];
  const wantedAll = fieldsByPath(declared);
  const haveAll = fieldsByPath(live);
  for (const [path, field] of wantedAll) {
    const current = haveAll.get(path);
    if (current && current.type !== field.type && (wanted.has(path) || have.has(path))) {
      changes.push(`${path}.type`);
    }
  }
  if (changes.length > 0) return changes;
  const wantedPaths = [...wanted.keys()].sort();
  const havePaths = [...have.keys()].sort();
  if (have.size > 0 && !deepEqual(wantedPaths, havePaths)) return ['path'];
  for (const [path, field] of wanted) {
    const current = have.get(path);
    if (!current) continue;
    for (const attribute of AUTO_EMBED_IMMUTABLE) {
      if (!deepEqual(field[attribute], current[attribute])) changes.push(`${path}.${attribute}`);
    }
  }
  return changes;
}

/** `base.key`, or `key` at the top */
const joinPath = (base, key) => (base ? `${base}.${key}` : key);

/**
 * `have` without the keys `want` does not have — the dotted paths of which go
 * to `ignored`. Only where both are option objects.
 */
function trimOptions(want, have, path, ignored) {
  if (!isPlainObject(want) || !isPlainObject(have)) return have;
  const out = {};
  for (const [key, value] of Object.entries(have)) {
    if (Object.hasOwn(want, key)) assign(out, key, value);
    else ignored.push(joinPath(path, key));
  }
  return out;
}

/**
 * A `{ name: mapping }` map trimmed mapping by mapping. A name only the
 * server has is a field the declaration does not index — a real difference,
 * left in place.
 */
function trimFieldMap(want, have, path, ignored) {
  if (!isPlainObject(want) || !isPlainObject(have)) return have;
  const out = {};
  for (const [name, mapping] of Object.entries(have)) {
    const trimmed = Object.hasOwn(want, name)
      ? trimFieldMapping(want[name], mapping, joinPath(path, name), ignored)
      : mapping;
    assign(out, name, trimmed);
  }
  return out;
}

/**
 * One field mapping trimmed, its nested `fields` and `multi` too — or a list
 * of them, paired by type and put back in order. A mapping of another type
 * is a real difference, left as it is.
 */
function trimFieldMapping(want, have, path, ignored) {
  if (Array.isArray(want) && Array.isArray(have)) {
    const paired = have.map((item) => {
      const match = want.find(
        (candidate) =>
          isPlainObject(candidate) && isPlainObject(item) && candidate.type === item.type,
      );
      return match ? trimFieldMapping(match, item, `${path}[${item.type}]`, ignored) : item;
    });
    return sortMappings(paired);
  }
  if (!isPlainObject(want) || !isPlainObject(have) || want.type !== have.type) return have;
  const out = trimOptions(want, have, path, ignored);
  for (const key of ['fields', 'multi']) {
    if (isPlainObject(out[key])) {
      out[key] = trimFieldMap(want[key], out[key], joinPath(path, key), ignored);
    }
  }
  return out;
}

/** A vector definition trimmed: its own options, and each field's — paired by type and path */
function trimVectorDefinition(want, have, ignored) {
  const out = trimOptions(want, have, '', ignored);
  if (!Array.isArray(out.fields) || !Array.isArray(want.fields)) return out;
  const fields = out.fields.map((field) => {
    const match = want.fields.find(
      (candidate) =>
        isPlainObject(candidate) &&
        isPlainObject(field) &&
        candidate.type === field.type &&
        candidate.path === field.path,
    );
    if (!match) return field;
    const path = `fields[${field.type}:${field.path}]`;
    const trimmed = trimOptions(match, field, path, ignored);
    if (isPlainObject(trimmed.hnswOptions)) {
      trimmed.hnswOptions = trimOptions(
        match.hnswOptions,
        trimmed.hnswOptions,
        `${path}.hnswOptions`,
        ignored,
      );
    }
    return trimmed;
  });
  out.fields = sortFields(fields);
  return out;
}

/** A search definition trimmed: its own options, `mappings`, and every field mapping */
function trimSearchDefinition(want, have, ignored) {
  const out = trimOptions(want, have, '', ignored);
  if (isPlainObject(out.mappings) && isPlainObject(want.mappings)) {
    const mappings = trimOptions(want.mappings, out.mappings, 'mappings', ignored);
    if (isPlainObject(mappings.fields)) {
      mappings.fields = trimFieldMap(
        want.mappings.fields,
        mappings.fields,
        'mappings.fields',
        ignored,
      );
    }
    out.mappings = mappings;
  }
  return out;
}

/**
 * The live definition without the options the server reports that the
 * declaration does not set. Both sides have their documented defaults filled
 * in first ({@link effectiveDefinition}), so these are exactly the options
 * whose default migronaut does not know — a newer mongot writing one into
 * every definition it reports. Compared, they would make every converge
 * "update" the index, and Atlas rebuilds a search index on every update.
 *
 * Only option objects are trimmed — the definition, `mappings`, a field
 * mapping (nested `fields` and `multi` included), a vector field and its
 * `hnswOptions`. A field, a mapping type or a vector field only the server
 * has is a real difference, and so is any list (`analyzers`, `synonyms`).
 * The cost: removing such an option from a declaration is not noticed —
 * declare the value wanted instead.
 *
 * Returns `{ have, ignored }`, `ignored` the dotted paths left out.
 */
function tolerateServerOptions(type, want, have) {
  const ignored = [];
  if (!isPlainObject(want) || !isPlainObject(have)) return { have, ignored };
  const trimmed =
    type === 'vectorSearch'
      ? trimVectorDefinition(want, have, ignored)
      : trimSearchDefinition(want, have, ignored);
  return { have: trimmed, ignored };
}

/** How many differing paths a comparison names — enough to tell what differs */
const MAX_DIFF_PATHS = 5;

/**
 * The dotted paths at which `want` and `have` differ, depth first, into
 * `out` (at most {@link MAX_DIFF_PATHS} — `total` counts them all). Objects
 * are walked key by key, lists of the same length item by item; anything
 * else that differs is a path of its own.
 */
function diffPaths(want, have, path, out) {
  if (deepEqual(want, have)) return;
  const walk = (keys, at) => {
    for (const key of keys) diffPaths(at(want, key), at(have, key), joinPath(path, key), out);
  };
  if (isPlainObject(want) && isPlainObject(have)) {
    walk([...new Set([...Object.keys(want), ...Object.keys(have)])].sort(), (value, key) =>
      Object.hasOwn(value, key) ? value[key] : undefined,
    );
    return;
  }
  if (Array.isArray(want) && Array.isArray(have) && want.length === have.length && path) {
    for (const [position] of want.entries()) {
      diffPaths(want[position], have[position], `${path}[${position}]`, out);
    }
    return;
  }
  out.total += 1;
  if (out.paths.length < MAX_DIFF_PATHS) out.paths.push(path);
}

/**
 * Compare a declaration with the live index of the same name.
 *
 * Returns `{ diffs, paths, more, typeChange, immutable, ignored }`: `diffs`
 * the top-level definition keys that differ (`['type']` when the type does),
 * `paths` the first few dotted paths that do (`mappings.fields.title.norms`)
 * and `more` how many others; `typeChange` whether the type differs — which
 * no update can change; `immutable` the automated-embedding attributes an
 * update would have to change (see {@link AUTO_EMBED_IMMUTABLE}); `ignored`
 * the options only the server reports (see {@link tolerateServerOptions}).
 * An empty `diffs` means unchanged.
 */
function compareSearchIndex(declared, live) {
  if (declared.type !== live.type) {
    return {
      diffs: ['type'],
      paths: ['type'],
      more: 0,
      typeChange: true,
      immutable: [],
      ignored: [],
    };
  }
  const want = effectiveDefinition(declared.type, declared.definition);
  const { have, ignored } = tolerateServerOptions(
    declared.type,
    want,
    effectiveDefinition(live.type, live.definition),
  );
  const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
  const diffs = [];
  for (const key of [...keys].sort()) {
    if (!deepEqual(want[key], have[key])) diffs.push(key);
  }
  const found = { paths: [], total: 0 };
  if (diffs.length > 0) diffPaths(want, have, '', found);
  const immutable =
    diffs.length > 0 && declared.type === 'vectorSearch' ? immutableChanges(want, have) : [];
  return {
    diffs,
    paths: found.paths,
    more: found.total - found.paths.length,
    typeChange: false,
    immutable,
    ignored,
  };
}

/**
 * Where the server is with a search index — from a live index or a row's
 * build (see {@link searchBuild}) — in one word, for every place that reports
 * it:
 *
 * - `serving`: queryable with its latest definition (READY, or a server that
 *   reports no status);
 * - `updating`: queryable, with a newer definition building next to it;
 * - `building`: not queryable yet, or a status other than READY;
 * - `stale`: queryable, but no longer replicating from the collection — its
 *   results may be out of date (STALE);
 * - `failed`: the build FAILED — the server does not retry an unchanged
 *   definition;
 * - `removing`: being deleted.
 */
function searchBuildState(build) {
  const { status } = build;
  if (status === 'FAILED') return 'failed';
  if (status === 'STALE') return 'stale';
  if (ABSENT_STATUSES.has(status)) return 'removing';
  if (build.queryable !== true) return 'building';
  if (build.updating) return 'updating';
  const ready = status === undefined || status === 'READY' || status === 'UNKNOWN';
  return ready ? 'serving' : 'building';
}

/**
 * Whether a live index serves queries with its latest definition (see
 * {@link searchBuildState}) — and, after an update made at `sinceVersion`,
 * with a definition version past it (right after an update the old version
 * can still read READY).
 */
function isSearchIndexReady(live, { sinceVersion } = {}) {
  if (searchBuildState(live) !== 'serving') return false;
  if (sinceVersion !== undefined && live.version !== undefined && live.version <= sinceVersion) {
    return false;
  }
  return true;
}

/** A live index's build state, for a result row */
function searchBuild(live) {
  return {
    status: live.status ?? 'UNKNOWN',
    queryable: live.queryable,
    ...(live.message !== undefined ? { message: live.message } : {}),
    ...(live.updating ? { updating: true } : {}),
  };
}

/** An index as data for a result row (`from` / `to`) */
function searchIndexValue(index) {
  return { name: index.name, type: index.type, definition: index.definition };
}

/**
 * What `createSearchIndexes` is sent for a declaration. The type is sent only
 * for a vector index — a search index is the server's default, and a server
 * older than vector search would refuse a field it does not know.
 */
function searchIndexSpec(declared) {
  return {
    name: declared.name,
    ...(declared.type === 'vectorSearch' ? { type: declared.type } : {}),
    definition: declared.definition,
  };
}

module.exports = {
  ABSENT_STATUSES,
  AUTO_EMBED_IMMUTABLE,
  DEFAULT_SEARCH_INDEX_NAME,
  FIELD_DEFAULTS,
  MAX_BUILD_MESSAGE_LENGTH,
  SEARCH_DEFAULTS,
  SEARCH_INDEX_KEYS,
  SEARCH_INDEX_TYPES,
  compareSearchIndex,
  effectiveDefinition,
  inferSearchIndexType,
  isBeingRemoved,
  isSearchIndexReady,
  normalizeDeclaredSearchIndex,
  normalizeLiveSearchIndex,
  searchBuild,
  searchBuildState,
  searchIndexIssues,
  searchIndexSpec,
  searchIndexValue,
  tolerateServerOptions,
};
