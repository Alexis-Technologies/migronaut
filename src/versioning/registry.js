const { ConfigInvalidError, ShapeVersionError } = require('../errors/index.js');
const { resolveVersioning } = require('./config.js');
const { stampDocument, versionOf } = require('./document.js');
const { isPlainObject, touchedFields } = require('./internal.js');
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
function entriesOf(definitions) {
  if (Array.isArray(definitions)) {
    const entries = [];
    for (const [position, definition] of definitions.entries()) {
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
  for (const [name, definition] of Object.entries(definitions)) {
    // An ES module namespace (`import * as orders`) carries the definition as its default.
    const resolved = isPlainObject(definition?.default) ? definition.default : definition;
    if (!isPlainObject(resolved) || resolved.versioning === undefined) {
      throw new ConfigInvalidError(`defineShapes: "${name}" declares no versioning`);
    }
    entries.push([name, resolved]);
  }
  return entries;
}

function defineShapes(definitions) {
  const registry = new Map();
  for (const [name, definition] of entriesOf(definitions)) {
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
        { collection: name },
      );
    }
    return versioning;
  };

  const docVersion = (name, doc) => {
    const versioning = get(name);
    const version = versionOf(doc, versioning.field);
    if (version === null) {
      throw new ShapeVersionError(
        `${name}: the document's ${versioning.field} is not a non-negative integer`,
        { collection: name, reason: 'invalid', current: versioning.current },
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
    stamp,
    /** An upcaster over this collection's versioning — see upcaster.js */
    upcaster: (name, steps, options) =>
      createUpcaster(get(name), steps, { ...options, collection: name }),
    /** `stamp` for one document or every document of an array — for `insertMany` */
    onInsert: (name, docs) =>
      Array.isArray(docs) ? docs.map((doc) => stamp(name, doc)) : stamp(name, docs),
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
      const { fields, whole } = touchedFields(update);
      if (whole) {
        throw new ConfigInvalidError('stampUpsert takes an operator update, not a replacement');
      }
      const { field, revisionField } = versioning;
      if (revisionField !== null && fields.has(revisionField)) {
        throw new ConfigInvalidError(
          `The update must not write the revision field "${revisionField}" — migronaut sets it`,
        );
      }
      const out = { ...update };
      if (!fields.has(field)) {
        out.$setOnInsert = { ...update.$setOnInsert, [field]: versioning.current };
      }
      if (revisionField !== null) out.$inc = { ...update.$inc, [revisionField]: 1 };
      return out;
    },
  });
}

module.exports = { defineShapes };
