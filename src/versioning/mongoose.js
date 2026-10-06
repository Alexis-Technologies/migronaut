const { ConfigInvalidError } = require('../errors/index.js');
const { resolveVersioning } = require('./config.js');
const { isPlainObject, topField, unwrapDefinition } = require('./internal.js');

/**
 * A Mongoose schema plugin for a versioned collection — it never requires
 * mongoose: the schema is the caller's, used only through its own methods.
 *
 *   ordersSchema.plugin(versioningPlugin, require('./collections/orders'));
 *
 * - The revision becomes Mongoose's `versionKey` with `optimisticConcurrency`,
 *   so a `save()` of a document someone changed since it was loaded throws
 *   Mongoose's `VersionError` — and every save bumps it, as the background
 *   migration engine's guard needs.
 * - The version field is a plain `Number` path **without a default**:
 *   Mongoose applies defaults to documents it loads, which would stamp a
 *   legacy document as current without upgrading it. A new document is
 *   stamped before it is validated instead.
 * - `updateOne`/`updateMany`/`findOneAndUpdate` bump the revision, and an
 *   upsert stamps the version of a document it inserts.
 *
 * Not covered (documented): lean `insertMany`, `bulkWrite`, `replaceOne` /
 * `findOneAndReplace` and pipeline updates — the collection's validator is
 * the safety net there.
 */

const UPDATE_HOOKS = ['updateOne', 'updateMany', 'findOneAndUpdate'];

function assertSchema(schema) {
  for (const method of ['set', 'get', 'add', 'path', 'pre']) {
    if (typeof schema?.[method] !== 'function') {
      throw new ConfigInvalidError('versioningPlugin takes a Mongoose schema');
    }
  }
}

/**
 * The top-level fields a Mongoose update writes. Plain keys are `$set` paths
 * to Mongoose (it wraps them at cast time), and the `$setOnInsert` of the
 * version key that Mongoose itself adds to every upsert is not the caller's.
 */
function updatedFields(update, revisionField) {
  const fields = new Set();
  for (const [key, spec] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      fields.add(topField(key));
      continue;
    }
    if (!isPlainObject(spec)) continue;
    for (const [path, value] of Object.entries(spec)) {
      if (key === '$setOnInsert' && path === revisionField && value === 0) continue;
      fields.add(topField(path));
      if (key === '$rename' && typeof value === 'string') fields.add(topField(value));
    }
  }
  return fields;
}

/** The plugin over already-resolved versioning — `defineShapes().plugin()` passes its own */
function applyVersioningPlugin(schema, versioning) {
  assertSchema(schema);
  const { current, field, revisionField } = versioning;
  const existing = schema.path(field);
  if (existing && existing.defaultValue !== undefined) {
    throw new ConfigInvalidError(
      `versioningPlugin: the schema gives "${field}" a default — Mongoose applies defaults to ` +
        'documents it loads, which would mark legacy documents as current; remove it',
      { field },
    );
  }

  if (revisionField !== null) {
    schema.set('versionKey', revisionField);
    schema.set('optimisticConcurrency', true);
  } else if (schema.get('versionKey') === field) {
    // Mongoose would count array changes in the version field.
    schema.set('versionKey', false);
  }
  if (!existing) schema.add({ [field]: { type: Number } });

  function stamp() {
    if (this.isNew && this.get(field) == null) this.set(field, current);
  }
  // Validation may be skipped (`validateBeforeSave: false`): stamp on save too.
  schema.pre('validate', stamp);
  schema.pre('save', stamp);

  if (revisionField === null) return;

  // A document loaded without a revision (one that predates versioning) is
  // revision 0: its save is guarded like any other, or a background
  // migration's rewrite in between would be silently overwritten.
  schema.pre('save', function guardLegacy() {
    if (this.isNew) return;
    // Loaded without its revision (a projection): Mongoose would neither
    // guard the save nor bump the revision — and "not selected" is not
    // "legacy". Refused, rather than a write an optimistic filter cannot see.
    if (typeof this.isSelected === 'function' && !this.isSelected(revisionField)) {
      throw new ConfigInvalidError(
        `versioningPlugin: this document was loaded without "${revisionField}" — select it ` +
          '(or every field) to save it',
        { field: revisionField },
      );
    }
    const where = isPlainObject(this.$where) ? { ...this.$where } : {};
    if (this.get(revisionField) == null) where[revisionField] = { $in: [null, 0] };
    else delete where[revisionField];
    this.$where = where;
  });

  schema.pre(UPDATE_HOOKS, function bumpRevision() {
    const update = this.getUpdate();
    if (!isPlainObject(update)) return;
    const fields = updatedFields(update, revisionField);
    if (fields.has(revisionField)) return;
    const next = { ...update, $inc: { ...update.$inc, [revisionField]: 1 } };
    // Mongoose adds `$setOnInsert: { versionKey: 0 }` to an upsert, which
    // would conflict with the `$inc`: an inserted document starts at 1.
    if (isPlainObject(next.$setOnInsert) && Object.hasOwn(next.$setOnInsert, revisionField)) {
      const { [revisionField]: _dropped, ...rest } = next.$setOnInsert;
      next.$setOnInsert = rest;
    }
    if (this.getOptions?.().upsert === true && !fields.has(field)) {
      next.$setOnInsert = { ...next.$setOnInsert, [field]: current };
    }
    if (isPlainObject(next.$setOnInsert) && Object.keys(next.$setOnInsert).length === 0) {
      delete next.$setOnInsert;
    }
    this.setUpdate(next);
  });
}

/**
 * The plugin, for `schema.plugin(versioningPlugin, definition)`: the second
 * argument is a collection definition (`{ versioning }`) or a versioning block.
 *
 * @throws {ConfigInvalidError} on a non-schema, invalid versioning, or a
 *   version field the schema already gives a default
 */
function versioningPlugin(schema, definitionOrModule) {
  const definition = unwrapDefinition(definitionOrModule);
  if (!isPlainObject(definition)) {
    throw new ConfigInvalidError(
      'versioningPlugin needs the collection definition: schema.plugin(versioningPlugin, definition)',
    );
  }
  const source = isPlainObject(definition.versioning) ? definition.versioning : definition;
  applyVersioningPlugin(schema, resolveVersioning(source));
}

module.exports = { applyVersioningPlugin, versioningPlugin };
