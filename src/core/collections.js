const fs = require('node:fs/promises');
const path = require('node:path');
const { ConfigInvalidError } = require('../errors/index.js');
const { isPlainObject, regExpIssue, toWire } = require('../utils/canonical.js');
const { isCollectionName } = require('../utils/collection-name.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { importUserFile, tsLoadMessageOrNull } = require('../utils/loader.js');
const { indexIssues, normalizeDeclaredIndex, sameDeclaredSignature } = require('./index-spec.js');

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
  'validator',
  'validationLevel',
  'validationAction',
  'prune',
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

/** What makes a validator unsendable — a function, a symbol, a cycle — or null */
function unsendable(value, seen = new Set()) {
  if (seen.size === 0) {
    const issue = regExpIssue(value);
    if (issue) return issue;
  }
  const type = typeof value;
  if (type === 'function') return 'must not contain functions';
  if (type === 'symbol') return 'must not contain symbols';
  if (value === null || type !== 'object') return null;
  if (seen.has(value)) return 'must not contain circular references';
  seen.add(value);
  const items = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  for (const item of items) {
    const reason = unsendable(item, seen);
    if (reason) return reason;
  }
  seen.delete(value);
  return null;
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

  if (definition.indexes === undefined && definition.validator === undefined) {
    issues.push({
      path: self,
      message: 'declares neither indexes nor a validator — nothing to manage',
    });
  }
  if (definition.indexes !== undefined) indexListIssues(definition.indexes, base, issues);

  const { validator } = definition;
  if (validator !== undefined && validator !== null) {
    if (!isPlainObject(validator)) {
      report('validator', 'must be an object (a query or { $jsonSchema }), or null for none');
    } else {
      const reason = unsendable(validator);
      if (reason) report('validator', reason);
    }
  }
  const hasValidator = isPlainObject(validator) && !isEmptyObject(validator);
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
 * names, server-form keys, the spec to send), the validator cleaned for the
 * wire. `indexes`/`validator` stay `undefined` when not managed.
 */
function normalizeDefinition(definition, { name, source } = {}) {
  const { validator } = definition;
  return {
    name: definition.name ?? name,
    source,
    indexes: definition.indexes?.map((index) => normalizeDeclaredIndex(index)),
    validator: validator === undefined || validator === null ? validator : toWire(validator),
    ...(definition.validationLevel !== undefined
      ? { validationLevel: definition.validationLevel }
      : {}),
    ...(definition.validationAction !== undefined
      ? { validationAction: definition.validationAction }
      : {}),
    ...(definition.prune !== undefined ? { prune: definition.prune } : {}),
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
