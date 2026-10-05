const fs = require('node:fs/promises');
const path = require('node:path');
const { ConfigInvalidError } = require('../errors/index.js');
const { isPlainObject, toWire, unsendable } = require('../utils/canonical.js');
const { isCollectionName } = require('../utils/collection-name.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { importUserFile, tsLoadMessageOrNull } = require('../utils/loader.js');
const { indexIssues, normalizeDeclaredIndex, sameDeclaredSignature } = require('./index-spec.js');
const { normalizeDeclaredSearchIndex, searchIndexIssues } = require('./search-index-spec.js');
const { resolveVersioning, versioningIssues } = require('../versioning/config.js');
const {
  isVersioningIndexKey,
  mergeVersioningValidator,
  validatorVersioningIssues,
  versioningIndex,
} = require('./versioning-spec.js');

/**
 * Declared collections: validating a definition, normalizing it for the
 * planner, and gathering definitions from their two sources — the
 * `collections` config key and the files in `collectionsDir`.
 *
 * Knows nothing about the database. Definitions are validated strictly: an
 * unknown key is an error rather than ignored, because every typo here
 * (`indexs`, `validtor`) would otherwise read as "not managed" and silently
 * leave the database alone.
 */

/** Every key a collection definition may carry */
const DEFINITION_KEYS = [
  'name',
  'indexes',
  'searchIndexes',
  'validator',
  'validationLevel',
  'validationAction',
  'prune',
  'versioning',
];
const DEFINITION_KEY_SET = new Set(DEFINITION_KEYS);
const VALIDATION_LEVELS = ['off', 'strict', 'moderate'];
const VALIDATION_ACTIONS = ['error', 'warn', 'errorAndLog'];

/** Simultaneous definition-file loads — the same EMFILE bound as every other multi-file path */
const FS_CONCURRENCY = 16;

/** `collections[2]` + `indexes` → `collections[2].indexes`; `users.ts:` + `indexes` → `users.ts: indexes` */
function join(base, key) {
  return base.endsWith(':') ? `${base} ${key}` : `${base}.${key}`;
}

const isEmptyObject = (value) => isPlainObject(value) && Object.keys(value).length === 0;

function indexListIssues(indexes, base, issues) {
  if (!Array.isArray(indexes)) {
    issues.push({ path: join(base, 'indexes'), message: 'must be an array of index definitions' });
    return;
  }
  const valid = [];
  for (const [position, index] of indexes.entries()) {
    const indexPath = `${join(base, 'indexes')}[${position}]`;
    const found = indexIssues(index, indexPath);
    issues.push(...found);
    if (found.length === 0) {
      valid.push({ position, path: indexPath, index: normalizeDeclaredIndex(index) });
    }
  }
  for (let a = 1; a < valid.length; a++) {
    for (let b = 0; b < a; b++) {
      const later = valid[a];
      const earlier = valid[b];
      let message;
      if (later.index.name === earlier.index.name) {
        message = `has the same name as indexes[${earlier.position}] ("${later.index.name}")`;
      } else if (later.index.isText && earlier.index.isText) {
        message = `is a second text index (after indexes[${earlier.position}]) — a collection has at most one`;
      } else if (sameDeclaredSignature(later.index, earlier.index)) {
        message =
          `has the same key, partialFilterExpression and collation as indexes[${earlier.position}] ` +
          '— the server keeps only one of them';
      }
      if (message) {
        issues.push({ path: later.path, message });
        break;
      }
    }
  }
}

function searchIndexListIssues(searchIndexes, base, issues) {
  const listPath = join(base, 'searchIndexes');
  if (!Array.isArray(searchIndexes)) {
    issues.push({ path: listPath, message: 'must be an array of search index definitions' });
    return;
  }
  const names = new Map();
  for (const [position, index] of searchIndexes.entries()) {
    const indexPath = `${listPath}[${position}]`;
    const found = searchIndexIssues(index, indexPath);
    issues.push(...found);
    if (found.length > 0) continue;
    const { name } = normalizeDeclaredSearchIndex(index);
    if (names.has(name)) {
      issues.push({
        path: indexPath,
        message:
          `has the same name as searchIndexes[${names.get(name)}] ("${name}")` +
          (index.name === undefined
            ? ' — a search index declared without a name is "default"'
            : ''),
      });
    } else {
      names.set(name, position);
    }
  }
}

/**
 * Validate the `versioning` key and how it fits the rest of the definition:
 * a declared validator must leave the managed fields to it, and a declared
 * index must not duplicate the version index. Returns whether the definition
 * is versioned (valid or not), so the validator checks below know a
 * validator is coming.
 */
function versioningDefinitionIssues(definition, base, issues) {
  if (definition.versioning === undefined) return false;
  const path = join(base, 'versioning');
  const found = versioningIssues(definition.versioning, path);
  issues.push(...found);
  if (found.length > 0) return true;
  const versioning = resolveVersioning(definition.versioning);
  if (isPlainObject(definition.validator) || definition.validator === null) {
    for (const message of validatorVersioningIssues(definition.validator, versioning)) {
      issues.push({ path: join(base, 'validator'), message });
    }
  }
  if (versioning.index && Array.isArray(definition.indexes)) {
    for (const [position, index] of definition.indexes.entries()) {
      if (isPlainObject(index) && isVersioningIndexKey(index.key, versioning)) {
        issues.push({
          path: `${join(base, 'indexes')}[${position}]`,
          message:
            'is the version index, which versioning declares itself — remove it, or set ' +
            'versioning.index: false',
        });
      }
    }
  }
  return true;
}

/**
 * Validate one collection definition, returning `{ path, message }` issues
 * (empty when valid). `path` prefixes every issue (`collections[2]`, or
 * `users.ts:` for a file); `reserved` are migronaut's own collection names;
 * `fallbackName` is the name a file-based definition gets when it sets none.
 */
function definitionIssues(definition, { path: base, reserved = [], fallbackName } = {}) {
  const self = base.endsWith(':') ? base.slice(0, -1) : base;
  if (!isPlainObject(definition)) {
    return [{ path: self, message: 'must be a collection definition object' }];
  }
  const issues = [];
  const report = (key, message) => issues.push({ path: join(base, key), message });
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_KEY_SET.has(key)) {
      report(
        key,
        `is not a collection definition key (expected one of: ${DEFINITION_KEYS.join(', ')})`,
      );
    }
  }

  const name = definition.name ?? fallbackName;
  const nameSource =
    definition.name === undefined && fallbackName !== undefined ? 'file name' : 'name';
  if (name === undefined) {
    report('name', 'is required');
  } else if (!isCollectionName(name)) {
    report(
      'name',
      nameSource === 'name'
        ? "must be a valid collection name (no '$'/NUL, not system.*)"
        : `the file name gives "${name}", which is not a valid collection name — set name explicitly`,
    );
  } else if (reserved.includes(name)) {
    report('name', `"${name}" is one of migronaut's own collections`);
  }

  if (
    definition.indexes === undefined &&
    definition.searchIndexes === undefined &&
    definition.validator === undefined &&
    definition.versioning === undefined
  ) {
    issues.push({
      path: self,
      message: 'declares no indexes, searchIndexes, validator or versioning — nothing to manage',
    });
  }
  if (definition.indexes !== undefined) indexListIssues(definition.indexes, base, issues);
  if (definition.searchIndexes !== undefined) {
    searchIndexListIssues(definition.searchIndexes, base, issues);
  }
  const versioning = versioningDefinitionIssues(definition, base, issues);

  const { validator } = definition;
  if (validator !== undefined && validator !== null) {
    if (!isPlainObject(validator)) {
      report('validator', 'must be an object (a query or { $jsonSchema }), or null for none');
    } else {
      const reason = unsendable(validator);
      if (reason) report('validator', reason);
    }
  }
  // The versioning rules are a validator of their own.
  const hasValidator = (isPlainObject(validator) && !isEmptyObject(validator)) || versioning;
  for (const [key, allowed] of [
    ['validationLevel', VALIDATION_LEVELS],
    ['validationAction', VALIDATION_ACTIONS],
  ]) {
    const value = definition[key];
    if (value === undefined) continue;
    if (!allowed.includes(value)) {
      report(key, `must be ${allowed.map((item) => `'${item}'`).join(', ')}`);
    } else if (!hasValidator) {
      report(key, 'has no effect without a validator');
    }
  }
  if (definition.prune !== undefined && typeof definition.prune !== 'boolean') {
    report('prune', 'must be a boolean');
  }
  return issues;
}

/**
 * Validate the `collections` config key: each definition, plus no collection
 * declared twice. `reserved` are the changelog and lock collection names.
 */
function collectionsIssues(list, { reserved = [] } = {}) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    return [{ path: 'collections', message: 'must be an array of collection definitions' }];
  }
  const issues = [];
  const seen = new Map();
  for (const [position, definition] of list.entries()) {
    const base = `collections[${position}]`;
    issues.push(...definitionIssues(definition, { path: base, reserved }));
    const name = isPlainObject(definition) ? definition.name : undefined;
    if (typeof name !== 'string') continue;
    if (seen.has(name)) {
      issues.push({
        path: `${base}.name`,
        message: `declares "${name}" again (already collections[${seen.get(name)}])`,
      });
    } else {
      seen.set(name, position);
    }
  }
  return issues;
}

/**
 * A valid definition in the planner's shape: indexes normalized (effective
 * names, server-form keys, the spec to send), search indexes with their
 * default name and type, the validator cleaned for the wire.
 * `indexes`/`searchIndexes`/`validator` stay `undefined` when not managed.
 * `versioning` is resolved and folded in: its rules merged into the
 * validator, its index appended to `indexes` — with `indexesPartial` when it
 * is the only index declared, so the others stay unmanaged.
 */
function normalizeDefinition(definition, { name, source } = {}) {
  const { validator } = definition;
  let wireValidator = validator === undefined || validator === null ? validator : toWire(validator);
  let indexes = definition.indexes?.map((index) => normalizeDeclaredIndex(index));
  let validationLevel = definition.validationLevel;
  let versioning;
  let indexesPartial = false;
  if (definition.versioning !== undefined) {
    // Folded into an ordinary validator and an ordinary index, so the planner
    // needs to know nothing about versioning.
    versioning = resolveVersioning(definition.versioning);
    // A validator synthesized for versioning alone applies `moderate`: an
    // update to a legacy document that predates the rules stays possible.
    if (wireValidator === undefined || isEmptyObject(wireValidator)) validationLevel ??= 'moderate';
    wireValidator = mergeVersioningValidator(wireValidator, versioning);
    if (versioning.index) {
      // Marked: on a sharded collection the planner swaps in the shard-key-prefixed form.
      const index = { ...normalizeDeclaredIndex(versioningIndex(versioning)), versionIndex: true };
      // Declaring the version index alone must not make every other index of
      // the collection "undeclared" — and so a candidate for prune.
      indexesPartial = indexes === undefined;
      indexes = [...(indexes ?? []), index];
    }
  }
  return {
    name: definition.name ?? name,
    source,
    indexes,
    ...(indexesPartial ? { indexesPartial } : {}),
    ...(definition.searchIndexes !== undefined
      ? {
          searchIndexes: definition.searchIndexes.map((index) =>
            normalizeDeclaredSearchIndex(index),
          ),
        }
      : {}),
    validator: wireValidator,
    ...(validationLevel !== undefined ? { validationLevel } : {}),
    ...(definition.validationAction !== undefined
      ? { validationAction: definition.validationAction }
      : {}),
    ...(definition.prune !== undefined ? { prune: definition.prune } : {}),
    ...(versioning !== undefined ? { versioning } : {}),
  };
}

/** The extensions a definition file may have: `fileExtensions`, dotted, plus `.json` — longest first */
function definitionExtensions(extensions) {
  const set = new Set(['.json']);
  for (const ext of extensions) set.add(ext.startsWith('.') ? ext : `.${ext}`);
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Load one definition file. JSON is parsed; anything else is imported, and
 * its default export (or, for an ES module with only named exports, the
 * exports themselves) is the definition. A function is refused rather than
 * called — a Mongoose model is a function, and a definitions directory is
 * exactly where one might be left by mistake.
 */
async function loadDefinitionFile(filepath, options) {
  if (filepath.endsWith('.json')) {
    const raw = await fs.readFile(filepath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ConfigInvalidError(
        'Collection definition file is not valid JSON',
        { path: filepath, cause: errorText(error) },
        { cause: error },
      );
    }
  }
  let mod;
  try {
    mod = await importUserFile(filepath, { reload: options.reload });
  } catch (error) {
    throw new ConfigInvalidError(
      tsLoadMessageOrNull(filepath, error, 'collection definition') ??
        'Collection definition file failed to load',
      { path: filepath, cause: errorText(error) },
      { cause: error },
    );
  }
  const exported = mod.default ?? mod;
  if (typeof exported === 'function') {
    throw new ConfigInvalidError(
      'A collection definition file must export one definition object, not a function',
      { path: filepath },
    );
  }
  // A shallow copy: an ES module namespace is an exotic object, not a plain one.
  return isPlainObject(exported) || exported === mod ? { ...exported } : exported;
}

/**
 * Load every definition file in `dir`: one collection per file, non-recursive,
 * sorted by file name. Dotfiles and declaration files (`.d.ts`) are skipped,
 * like in the migrations directory. An explicitly configured directory that
 * does not exist is an error, not "no definitions".
 */
async function loadCollectionsDir(dir, { extensions, reload = false }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new ConfigInvalidError('collectionsDir not found', { path: dir });
    }
    throw new ConfigInvalidError(
      'collectionsDir could not be read',
      { path: dir, cause: errorText(error) },
      { cause: error },
    );
  }
  const accepted = definitionExtensions(extensions);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = entry.name;
    if (file.startsWith('.')) continue;
    if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) continue;
    const ext = accepted.find(
      (candidate) => file.endsWith(candidate) && file.length > candidate.length,
    );
    if (ext) files.push({ file, name: file.slice(0, -ext.length) });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return mapLimit(files, FS_CONCURRENCY, async ({ file, name }) => {
    const filepath = path.join(dir, file);
    return { file, name, definition: await loadDefinitionFile(filepath, { reload }) };
  });
}

/**
 * Every declared collection, normalized: the `collections` key first (already
 * validated with the rest of the config), then the files in `dir`, if one is
 * configured. A collection declared by both sources — or by two files — is
 * an error: which declaration wins would otherwise depend on load order.
 *
 * @throws {ConfigInvalidError} on a missing directory, a file that does not
 *   load, or invalid definitions (all issues at once, in `context.issues`)
 */
async function resolveDefinitions({
  inline,
  dir,
  extensions = ['.ts', '.js'],
  reload,
  reserved = [],
}) {
  const definitions = [];
  const declaredBy = new Map();
  for (const [position, definition] of (inline ?? []).entries()) {
    const source = `collections[${position}]`;
    definitions.push(normalizeDefinition(definition, { source }));
    declaredBy.set(definition.name, source);
  }
  if (dir === undefined) return definitions;

  const files = await loadCollectionsDir(dir, { extensions, reload });
  const issues = [];
  for (const { file, name: fallbackName, definition } of files) {
    const base = `${file}:`;
    const found = definitionIssues(definition, { path: base, reserved, fallbackName });
    if (found.length > 0) {
      issues.push(...found);
      continue;
    }
    const name = definition.name ?? fallbackName;
    if (declaredBy.has(name)) {
      issues.push({
        path: join(base, 'name'),
        message: `declares "${name}" again (already ${declaredBy.get(name)})`,
      });
      continue;
    }
    declaredBy.set(name, file);
    definitions.push(normalizeDefinition(definition, { name, source: file }));
  }
  if (issues.length > 0) {
    throw new ConfigInvalidError('Invalid collection definition(s)', { path: dir, issues });
  }
  return definitions;
}

module.exports = {
  DEFINITION_KEYS,
  collectionsIssues,
  definitionIssues,
  loadCollectionsDir,
  normalizeDefinition,
  resolveDefinitions,
};
