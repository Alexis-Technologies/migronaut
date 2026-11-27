const { ConfigInvalidError, ShapeVersionError } = require('../errors/index.js');
const { resolveVersioning } = require('./config.js');
const { refuseTouch, stampDocument, readVersion } = require('./document.js');
const { isPlainObject, collectTouchedFields, unwrapDefinition } = require('./internal.js');
const { applyVersioningPlugin } = require('./mongoose.js');
const {
  bumpRevision,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  updateWithRevision,
} = require('./occ.js');
const { createUpcaster } = require('./upcaster.js');

/**
 * `defineShapes` — the application's view of its versioned collections, read
 * from the very definition files converge declares them with:
 *
 *   const shapes = defineShapes({ orders: require('./collections/orders') });
 *   await orders.insertOne(shapes.stamp('orders', doc)); // __v: current, __rev: 0
 *
 * so the version a repository writes and the version the validator demands
 * can never drift apart.
 */

/** `[name, definition]` pairs from a `{ name: definition }` map or a definition list */
const toEntries = (definitions) => {
  if (Array.isArray(definitions)) {
    const entries = [];
    for (let position = 0; position < definitions.length; position++) {
      const definition = unwrapDefinition(definitions[position]);
      if (!isPlainObject(definition) || typeof definition.name !== 'string') {
        throw new ConfigInvalidError(
          `defineShapes: definitions[${position}] needs a name — or pass { name: definition }`,
        );
      }
      // A collections list may hold unversioned collections too.
      if (definition.versioning !== undefined) entries.push([definition.name, definition]);
    }
    return entries;
  }
  if (!isPlainObject(definitions)) {
    throw new ConfigInvalidError(
      'defineShapes takes { name: definition } or an array of definitions with a name',
    );
  }
  const entries = [];
  const names = Object.keys(definitions);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const resolved = unwrapDefinition(definitions[name]);
    if (!isPlainObject(resolved) || resolved.versioning === undefined) {
      throw new ConfigInvalidError(`defineShapes: "${name}" declares no versioning`);
    }
    entries.push([name, resolved]);
  }
  return entries;
};

/** An option of a bound guard that names `key` as anything but the collection's own `value` */
const assertBoundName = (collection, options, key, value) => {
  if (options[key] !== undefined && options[key] !== value) {
    throw new ConfigInvalidError(
      `${collection}: ${key} is "${value}" — the guards bound to it take no other`,
      { context: { collection, [key]: options[key] } },
    );
  }
};

/**
 * Called without arguments — `defineShapes<Shapes>()(definitions)` — it
 * returns itself: TypeScript then takes the shape map from the first call
 * and infers the definitions from the second. Nothing changes at run time.
 */
const defineShapes = (...args) => {
  if (args.length === 0) return (definitions) => defineShapes(definitions);
  const definitions = args[0];
  const registry = new Map();
  const entries = toEntries(definitions);
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i][0];
    const definition = entries[i][1];
    if (registry.has(name)) {
      throw new ConfigInvalidError(`defineShapes: "${name}" is declared twice`);
    }
    registry.set(name, resolveVersioning(definition.versioning, { path: `${name}.versioning` }));
  }
  const names = Object.freeze([...registry.keys()]);

  const get = (name) => {
    const versioning = registry.get(name);
    if (versioning === undefined) {
      throw new ConfigInvalidError(
        `"${name}" is not a versioned collection (known: ${names.join(', ') || 'none'})`,
        { context: { collection: name } },
      );
    }
    return versioning;
  };

  const docVersion = (name, doc) => {
    const versioning = get(name);
    const version = readVersion(doc, versioning.field);
    if (version === null) {
      throw new ShapeVersionError(
        `${name}: the document's ${versioning.field} is not a non-negative integer`,
        { context: { collection: name, reason: 'invalid', current: versioning.current } },
      );
    }
    return version;
  };

  const stamp = (name, doc) => {
    const versioning = get(name);
    return stampDocument(doc, versioning, versioning.current);
  };

  return Object.freeze({
    names,
    has: (name) => registry.has(name),
    get,
    current: (name) => get(name).current,
    versionOf: docVersion,
    isCurrent: (name, doc) => docVersion(name, doc) === get(name).current,
    isVersion: (name, doc, version) => docVersion(name, doc) === version,
    stamp,
    /** The Mongoose plugin for this collection: `schema.plugin(shapes.plugin('orders'))` */
    plugin: (name) => {
      const versioning = get(name);
      return (schema) => applyVersioningPlugin(schema, versioning);
    },
    /** An upcaster over this collection's versioning — see upcaster.js */
    upcaster: (name, steps, options) => {
      return createUpcaster(get(name), steps, { ...options, collection: name });
    },
    /**
     * The revision guards bound to this collection's field names, so no call
     * can forget them — a custom `revisionField` left out of one write would
     * guard nothing (no document has `__rev`, so the filter matches them all).
     */
    occ: (name) => {
      const { field, revisionField } = get(name);
      if (revisionField === null) {
        throw new ConfigInvalidError(
          `"${name}" declares revision: false — it has no revision to guard`,
          { context: { collection: name } },
        );
      }
      const bound = (options = {}) => {
        if (!isPlainObject(options)) throw new ConfigInvalidError('options must be an object');
        assertBoundName(name, options, 'field', field);
        assertBoundName(name, options, 'revisionField', revisionField);
        return { ...options, field, revisionField };
      };
      return Object.freeze({
        // Async, like the helpers: a refused option rejects, it does not throw.
        updateWithRevision: async (collection, filter, expected, update, options) => {
          return updateWithRevision(collection, filter, expected, update, bound(options));
        },
        replaceWithRevision: async (collection, filter, expected, replacement, options) => {
          return replaceWithRevision(collection, filter, expected, replacement, bound(options));
        },
        findOneAndUpdateWithRevision: async (collection, filter, expected, update, options) => {
          return findOneAndUpdateWithRevision(collection, filter, expected, update, bound(options));
        },
        bumpRevision: (update) => bumpRevision(update, { revisionField }),
      });
    },
    /** `stamp` for one document or every document of an array — for `insertMany` */
    onInsert: (name, docs) => {
      if (!Array.isArray(docs)) return stamp(name, docs);
      // A hole stays a hole, as Array#map left it: it is the driver's to refuse, not the stamp's.
      const stamped = [];
      for (let i = 0; i < docs.length; i++) {
        if (i in docs) stamped.push(stamp(name, docs[i]));
        else stamped.length = i + 1;
      }
      return stamped;
    },
    /**
     * An upsert's update with the stamp of a document it may insert: the
     * version on `$setOnInsert` (unless the update sets it itself) and the
     * revision bumped — an inserted document starts at revision 1. A
     * replacement or a pipeline is refused: `$setOnInsert` has no place there.
     */
    stampUpsert: (name, update) => {
      const versioning = get(name);
      if (Array.isArray(update) || !isPlainObject(update)) {
        throw new ConfigInvalidError('stampUpsert takes an operator update, not a pipeline');
      }
      const { fields, whole } = collectTouchedFields(update);
      if (whole) {
        throw new ConfigInvalidError('stampUpsert takes an operator update, not a replacement');
      }
      const { field, revisionField } = versioning;
      refuseTouch(fields, revisionField, 'revision');
      const out = { ...update };
      if (!fields.has(field)) {
        out.$setOnInsert = { ...update.$setOnInsert, [field]: versioning.current };
      }
      if (revisionField !== null) out.$inc = { ...update.$inc, [revisionField]: 1 };
      return out;
    },
  });
};

module.exports = { defineShapes };
