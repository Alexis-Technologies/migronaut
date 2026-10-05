const { ConfigInvalidError, ShapeVersionError } = require('../errors/index.js');
const { resolveVersioning } = require('./config.js');
const { cloneDocument, versionOf } = require('./document.js');
const { isPlainObject } = require('./internal.js');

/**
 * An upcaster: the shape changes of one collection as plain functions, one
 * per version step — `{ 1: v1 => v2, 2: v2 => v3 }` — usable two ways:
 *
 * - `step(1)` is the `migrate` of the background migration that rewrites the
 *   stored documents (the norm: data is upgraded in the database);
 * - `upcast(doc)` lifts a document read from the database to the current
 *   shape in memory, without writing it (the exception: a read path that
 *   cannot wait for the background migration to finish).
 *
 * So the knowledge of what changed between two shapes lives in one place.
 * Steps are synchronous and pure; the helper sets the version field, so a
 * step only reshapes the document.
 */

const NEWER = new Set(['throw', 'keep']);

function shapeError(message, context) {
  return new ShapeVersionError(message, context);
}

/** The steps, validated against the versioning: `Map<from, fn>` */
function readSteps(steps, versioning, label) {
  if (!isPlainObject(steps)) {
    throw new ConfigInvalidError(`${label}: steps must be an object of { [fromVersion]: fn }`);
  }
  const map = new Map();
  for (const [key, step] of Object.entries(steps)) {
    const from = Number(key);
    if (!Number.isSafeInteger(from) || from < 0 || String(from) !== key) {
      throw new ConfigInvalidError(`${label}: step key "${key}" is not a version`);
    }
    if (from >= versioning.current) {
      throw new ConfigInvalidError(
        `${label}: a step from ${from} goes past the current version ${versioning.current}`,
      );
    }
    if (typeof step !== 'function') {
      throw new ConfigInvalidError(`${label}: the step from ${from} must be a function`);
    }
    if (step.constructor?.name === 'AsyncFunction') {
      throw new ConfigInvalidError(
        `${label}: the step from ${from} is async — upcasting is synchronous and pure`,
      );
    }
    map.set(from, step);
  }
  for (let from = versioning.min; from < versioning.current; from++) {
    if (!map.has(from)) {
      throw new ConfigInvalidError(
        `${label}: no step from version ${from} — every version from min (${versioning.min}) ` +
          `to current (${versioning.current}) needs one`,
        { missing: from },
      );
    }
  }
  return map;
}

/** Run one step on `doc` (already a copy) and stamp the version it reaches */
function runStep(step, doc, from, versioning, context) {
  const next = step(doc);
  if (next !== null && typeof next === 'object' && typeof next.then === 'function') {
    throw shapeError(`The step from version ${from} returned a promise — steps are synchronous`, {
      ...context,
      reason: 'invalid',
      version: from,
    });
  }
  if (!isPlainObject(next)) {
    throw shapeError(`The step from version ${from} did not return a document`, {
      ...context,
      reason: 'invalid',
      version: from,
    });
  }
  next[versioning.field] = from + 1;
  return next;
}

/**
 * An upcaster over already-resolved versioning (`defineShapes` passes its
 * own). `collection` names it in errors.
 */
function createUpcaster(versioning, steps, { newer = 'throw', collection } = {}) {
  const label = collection ? `upcaster(${collection})` : 'upcaster';
  if (!NEWER.has(newer)) {
    throw new ConfigInvalidError(`${label}: newer must be 'throw' or 'keep'`, { newer });
  }
  const chain = readSteps(steps, versioning, label);
  const { current, min, field } = versioning;
  const base = collection ? { collection, current } : { current };

  const versionChecked = (doc) => {
    const version = versionOf(doc, field);
    if (version === null) {
      throw shapeError(`The document's ${field} is not a non-negative integer`, {
        ...base,
        reason: 'invalid',
      });
    }
    return version;
  };

  /** `doc` lifted from `from` to `to` — every step on one private copy */
  const lift = (doc, from, to) => {
    let next = cloneDocument(doc);
    for (let version = from; version < to; version++) {
      const step = chain.get(version);
      if (step === undefined) {
        throw shapeError(
          `No step from version ${version} — the document is older than the oldest shape ` +
            `still supported (${min})`,
          { ...base, reason: 'below-min', version: from },
        );
      }
      next = runStep(step, next, version, versioning, base);
    }
    return next;
  };

  /**
   * The document in the current shape. One already current is returned as
   * is; an older one is copied first, so the caller's object never changes.
   * A newer one (written by a newer release) throws — or, with
   * `newer: 'keep'`, is returned as is.
   */
  const upcast = (doc) => {
    if (!isPlainObject(doc)) {
      throw shapeError('Only a document can be upcast', { ...base, reason: 'invalid' });
    }
    const version = versionChecked(doc);
    if (version === current) return doc;
    if (version > current) {
      if (newer === 'keep') return doc;
      throw shapeError(
        `The document is at version ${version}, newer than ${current} — written by a newer ` +
          'release',
        { ...base, reason: 'newer', version },
      );
    }
    return lift(doc, version, current);
  };

  /** Whether `upcast` would change the document */
  const needsUpcast = (doc) => isPlainObject(doc) && versionChecked(doc) < current;

  /**
   * The transformation from `from` to `to` (default `from + 1`) as a
   * background migration's `migrate`: it takes the stored document and
   * returns the new one; the engine writes the version.
   */
  const step = (from, to = from + 1) => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new ConfigInvalidError(`${label}: step(${from}, ${to}) is not a forward range`);
    }
    if (to > current) {
      throw new ConfigInvalidError(`${label}: step(${from}, ${to}) goes past ${current}`);
    }
    for (let version = from; version < to; version++) {
      if (!chain.has(version)) {
        throw new ConfigInvalidError(`${label}: no step from version ${version}`);
      }
    }
    return (doc) => lift(doc, from, to);
  };

  return Object.freeze({ current, min, field, upcast, needsUpcast, step });
}

/**
 * An upcaster for a collection definition (`{ versioning }`, as a
 * `collections/*.js` file exports it) or a bare versioning block.
 *
 * @throws {ConfigInvalidError} when a step is missing between `min` and
 *   `current`, goes past `current`, is async, or is not a function
 */
function upcaster(definitionOrModule, steps, options = {}) {
  // An ES-module definition file, as `require` returns it, too — as defineShapes takes it.
  const definition = isPlainObject(definitionOrModule?.default)
    ? definitionOrModule.default
    : definitionOrModule;
  if (!isPlainObject(definition)) {
    throw new ConfigInvalidError('upcaster takes a collection definition or its versioning');
  }
  const source = isPlainObject(definition.versioning) ? definition.versioning : definition;
  const versioning = resolveVersioning(source);
  const collection = typeof definition.name === 'string' ? definition.name : undefined;
  return createUpcaster(versioning, steps, { collection, ...options });
}

module.exports = { createUpcaster, upcaster };
