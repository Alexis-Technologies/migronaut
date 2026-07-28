const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ConfigInvalidError } = require('../errors/index.js');
const { applyEnvFile } = require('../utils/env.js');
const { errorText } = require('../utils/error.js');
const { resolveLogger } = require('../utils/logger.js');
const { redactDeep } = require('../utils/redact.js');

/** Default values applied when no flag, env var, or config-file value is present */
const DEFAULT_CONFIG = {
  migrationsDir: './migrations',
  migrationsCollection: '_migronaut_migrations',
  lockCollection: '_migronaut_locks',
  lockTTLSeconds: 60,
  strict: false,
  useTransaction: false,
  fileExtensions: ['.ts', '.js'],
  createExtension: 'js',
  sequential: false,
};

/** Candidate config file names, checked in priority order within the cwd */
const CONFIG_FILE_NAMES = ['migronaut.config.ts', 'migronaut.config.js', 'migronaut.config.json'];

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isBoolean = (value) => typeof value === 'boolean';
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isExtension = (value) => value === 'ts' || value === 'js';

/**
 * Collection names we accept for the changelog/lock collections and
 * `import --from/--to`: non-empty, no `$` or NUL (invalid server-side), and
 * outside the reserved `system.` namespace — so a flag can never point a
 * read or write at a system collection.
 */
function isCollectionName(value) {
  return (
    isNonEmptyString(value) &&
    !value.includes('$') &&
    !value.includes('\0') &&
    !value.startsWith('system.')
  );
}
function isStringList(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value) {
    if (!isNonEmptyString(item)) return false;
  }
  return true;
}

/**
 * Validation spec for every checked config key: predicate + failure message.
 * `mongoose`, `hooks`, `logger` and `client` are deliberately unchecked —
 * they hold live instances the validator has nothing to say about. Unknown
 * keys are allowed, matching the previous zod (non-strict object) behavior.
 */
const CONFIG_KEYS = [
  { path: 'uri', check: isNonEmptyString, message: 'uri is required' },
  { path: 'dbName', check: isNonEmptyString, message: 'dbName is required' },
  { path: 'migrationsDir', check: isNonEmptyString, message: 'must be a non-empty string' },
  {
    path: 'migrationsCollection',
    check: isCollectionName,
    message: "must be a valid collection name (no '$'/NUL, not system.*)",
  },
  {
    path: 'lockCollection',
    check: isCollectionName,
    message: "must be a valid collection name (no '$'/NUL, not system.*)",
  },
  { path: 'lockTTLSeconds', check: isPositiveInteger, message: 'must be a positive integer' },
  { path: 'strict', check: isBoolean, message: 'must be a boolean' },
  { path: 'useTransaction', check: isBoolean, message: 'must be a boolean' },
  {
    path: 'fileExtensions',
    check: isStringList,
    message: 'must be a non-empty array of non-empty strings',
  },
  { path: 'createExtension', check: isExtension, message: "must be 'ts' or 'js'" },
  { path: 'sequential', check: isBoolean, message: 'must be a boolean' },
  {
    path: 'templatePath',
    check: isNonEmptyString,
    message: 'must be a non-empty string',
    optional: true,
  },
  {
    path: 'environment',
    check: isNonEmptyString,
    message: 'must be a non-empty string',
    optional: true,
  },
  {
    path: 'onLockLost',
    check: (value) => value === 'abort' || value === 'warn',
    message: "must be 'abort' or 'warn'",
    optional: true,
  },
  {
    path: 'envFile',
    check: (value) => value === false || isNonEmptyString(value),
    message: 'must be a non-empty string or false',
    optional: true,
  },
  { path: 'ensureIndexes', check: isBoolean, message: 'must be a boolean', optional: true },
  {
    path: 'clientOptions',
    check: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    message: 'must be an object',
    optional: true,
  },
  {
    path: 'timeoutMs',
    check: isPositiveInteger,
    message: 'must be a positive integer',
    optional: true,
  },
  { path: 'reloadMigrations', check: isBoolean, message: 'must be a boolean', optional: true },
];

/**
 * Every key the merged config legitimately carries: the validated ones plus
 * the deliberately-unchecked live instances. Used only to *mention* typos
 * (`migrationsDirectory`, `useTransactions`) at debug level — unknown keys
 * stay allowed, matching the documented non-strict contract.
 */
const KNOWN_CONFIG_KEYS = new Set(['logger', 'hooks', 'mongoose', 'client']);
for (const spec of CONFIG_KEYS) KNOWN_CONFIG_KEYS.add(spec.path);

/**
 * Validate the merged config, returning a list of `{ path, message }` issues
 * (empty when valid). With `requireDb: false`, empty `uri`/`dbName` strings
 * are allowed — for commands that never touch the database (`init`, `create`).
 */
function validateConfig(config, options = {}) {
  const requireDb = options.requireDb ?? true;
  // An injected client already carries the connection, so a `uri` would be
  // ignored — requiring one would only be busywork.
  const hasClient = typeof config.client === 'object' && config.client !== null;
  const issues = [];
  for (const spec of CONFIG_KEYS) {
    const value = config[spec.path];
    if (spec.optional && value === undefined) continue;
    if (hasClient && spec.path === 'uri') continue;
    if (!requireDb && (spec.path === 'uri' || spec.path === 'dbName')) {
      if (typeof value !== 'string') issues.push({ path: spec.path, message: 'must be a string' });
      continue;
    }
    if (!spec.check(value)) issues.push({ path: spec.path, message: spec.message });
  }
  return issues;
}

const TRUE_BOOLEAN_STRINGS = new Set(['true', '1', 'yes']);
const FALSE_BOOLEAN_STRINGS = new Set(['false', '0', 'no']);

/**
 * Parse a string into a boolean. Unrecognized values throw instead of silently
 * becoming false — a typo like MIGRONAUT_STRICT=on must never disable a safety
 * setting (fail closed).
 */
function parseBoolean(value, name) {
  const normalized = value.trim().toLowerCase();
  if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
  if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
  throw new ConfigInvalidError(`${name} must be 'true'/'1'/'yes' or 'false'/'0'/'no'`, {
    name,
    value,
  });
}

/**
 * Keys never copied from parsed input: JSON.parse creates `__proto__` as an own
 * enumerable property, so merging it would poison the prototype of the merged
 * config and let a JSON config file override values it never declared.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Copy only the defined keys from `source` onto `target`, mutating and returning target */
function mergeDefined(target, source) {
  for (const key of Object.keys(source)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    const value = source[key];
    if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

/** Build a partial config from the MIGRONAUT_* environment variables */
function readEnvConfig() {
  const env = process.env;
  const result = {};
  if (env.MIGRONAUT_URI !== undefined) result.uri = env.MIGRONAUT_URI;
  if (env.MIGRONAUT_DB !== undefined) result.dbName = env.MIGRONAUT_DB;
  if (env.MIGRONAUT_MIGRATIONS_DIR !== undefined) {
    result.migrationsDir = env.MIGRONAUT_MIGRATIONS_DIR;
  }
  if (env.MIGRONAUT_COLLECTION !== undefined) {
    result.migrationsCollection = env.MIGRONAUT_COLLECTION;
  }
  if (env.MIGRONAUT_LOCK_COLLECTION !== undefined) {
    result.lockCollection = env.MIGRONAUT_LOCK_COLLECTION;
  }
  if (env.MIGRONAUT_LOCK_TTL !== undefined) result.lockTTLSeconds = Number(env.MIGRONAUT_LOCK_TTL);
  if (env.MIGRONAUT_STRICT !== undefined) {
    result.strict = parseBoolean(env.MIGRONAUT_STRICT, 'MIGRONAUT_STRICT');
  }
  if (env.MIGRONAUT_USE_TRANSACTION !== undefined) {
    result.useTransaction = parseBoolean(
      env.MIGRONAUT_USE_TRANSACTION,
      'MIGRONAUT_USE_TRANSACTION',
    );
  }
  if (env.MIGRONAUT_SEQUENTIAL !== undefined) {
    result.sequential = parseBoolean(env.MIGRONAUT_SEQUENTIAL, 'MIGRONAUT_SEQUENTIAL');
  }
  if (env.MIGRONAUT_CREATE_EXTENSION === 'ts' || env.MIGRONAUT_CREATE_EXTENSION === 'js') {
    result.createExtension = env.MIGRONAUT_CREATE_EXTENSION;
  }
  if (env.MIGRONAUT_ENVIRONMENT !== undefined) result.environment = env.MIGRONAUT_ENVIRONMENT;
  return result;
}

/** Returns true when `filepath` exists on disk */
async function pathExists(filepath) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a config file in `cwd`, returning its absolute path or null.
 * Candidates are checked concurrently, then the first one that exists (in
 * `CONFIG_FILE_NAMES` priority order) wins — preserves the original
 * short-circuit priority without serializing the stat calls.
 */
async function discoverConfigFile(cwd) {
  const candidates = [];
  for (const name of CONFIG_FILE_NAMES) candidates.push(path.join(cwd, name));
  const checks = [];
  for (const candidate of candidates) checks.push(pathExists(candidate));
  const found = await Promise.all(checks);
  for (let i = 0; i < candidates.length; i++) {
    if (found[i]) return candidates[i];
  }
  return null;
}

/**
 * Load and return the config object exported by a config file.
 *
 * A `.ts`/`.js` config may export either a plain object or a (sync or async)
 * factory function — the factory is invoked and awaited here, which is what
 * lets users fetch values from a secret manager. A factory that throws is
 * surfaced as a ConfigInvalidError. JSON configs are always objects.
 */
async function loadConfigFile(filepath, lenient = false) {
  if (filepath.endsWith('.json')) {
    const raw = await fs.readFile(filepath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      // A bare SyntaxError has no typed code, which breaks the CLI's exit-code
      // mapping and `--json` error shape.
      throw new ConfigInvalidError(
        'Config file is not valid JSON',
        { path: filepath, cause: errorText(error) },
        { cause: error },
      );
    }
  }
  let mod;
  try {
    mod = await import(pathToFileURL(filepath).href);
  } catch (error) {
    // Module-evaluation failures (syntax error, a throwing top-level statement)
    // get the same treatment as a throwing factory below — including the
    // lenient degradation for commands that never touch the database.
    if (lenient) return null;
    throw new ConfigInvalidError(
      'Config file failed to load',
      { path: filepath, cause: errorText(error) },
      { cause: error },
    );
  }
  const exported = mod.default ?? mod;

  if (typeof exported === 'function') {
    try {
      return await exported();
    } catch (error) {
      if (lenient) {
        // The caller does not need the connection (e.g. `create`), so a failing
        // secret-manager round trip degrades to "no values from this file"
        // rather than stopping an otherwise offline command.
        return null;
      }
      throw new ConfigInvalidError(
        'Config factory function failed to resolve',
        { path: filepath, cause: errorText(error) },
        { cause: error },
      );
    }
  }
  return exported;
}

/**
 * Resolve the final MigronautConfig by merging, in priority order:
 * CLI flags > environment variables > config file > defaults.
 *
 * With `lenient: true`, a config file whose exported factory throws is skipped
 * with a warning instead of aborting — for commands that never open a
 * connection (`create`), which otherwise fail because a secret manager is
 * unreachable.
 *
 * Throws ConfigInvalidError when the merged result fails validation.
 */
async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  // The CLI's console logger, used only when neither flags nor the config file
  // supply one — so this module's own lines honor `--verbose`/`--quiet` while
  // a user's configured logger still wins.
  const effectiveLogger = (value) =>
    resolveLogger(value !== undefined ? value : options.fallbackLogger);

  // Resolved before the merge, because loading the .env file is what supplies
  // the MIGRONAUT_* variables the merge then reads. `false` opts out entirely —
  // a stray .env silently outranking a committed config is a nasty surprise.
  const envFile = options.flags?.envFile ?? process.env.MIGRONAUT_ENV_FILE ?? '.env';
  if (envFile !== false) {
    // Checked here, before validateConfig runs, because path.resolve on a
    // non-string throws a raw TypeError instead of the ConfigInvalidError the
    // config contract promises.
    if (!isNonEmptyString(envFile)) {
      throw new ConfigInvalidError('Invalid configuration', {
        issues: [{ path: 'envFile', message: 'must be a non-empty string or false' }],
      });
    }
    await applyEnvFile(path.resolve(cwd, envFile));
  }

  const merged = { ...DEFAULT_CONFIG };

  const configFilePath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : await discoverConfigFile(cwd);

  if (configFilePath) {
    if (!(await pathExists(configFilePath))) {
      throw new ConfigInvalidError('Config file not found', { path: configFilePath });
    }
    const fileConfig = await loadConfigFile(configFilePath, options.lenient ?? false);
    // null means a lenient run whose factory failed — nothing usable from the
    // file, so fall through to env vars, flags and defaults.
    if (fileConfig === null) {
      effectiveLogger(options.flags?.logger).warn(
        `⚠ Could not resolve ${path.basename(configFilePath)} — continuing without it`,
      );
    } else {
      mergeDefined(merged, fileConfig);
    }
  }

  mergeDefined(merged, readEnvConfig());

  if (options.flags) {
    mergeDefined(merged, options.flags);
  }

  const requireDb = options.requireDb ?? true;
  if (!requireDb) {
    if (merged.uri === undefined) merged.uri = '';
    if (merged.dbName === undefined) merged.dbName = '';
  }

  const issues = validateConfig(merged, { requireDb });
  if (issues.length > 0) {
    throw new ConfigInvalidError('Invalid configuration', { issues });
  }

  const config = merged;

  // A typo'd key (`migrationsDirectory`, `useTransactions`) validates fine and
  // then silently does nothing; a debug mention is the cheapest way to notice.
  // The array is only allocated when a stray key actually exists.
  let unknown;
  for (const key in config) {
    if (!KNOWN_CONFIG_KEYS.has(key)) (unknown ??= []).push(key);
  }
  if (unknown) {
    effectiveLogger(config.logger).debug(
      `Unrecognized config key(s), ignored: ${unknown.join(', ')}`,
    );
  }

  if (config.logger && configFilePath) {
    // resolveLogger, not a direct call — config.logger may be a pino instance.
    effectiveLogger(config.logger).debug(`Loaded config from ${path.basename(configFilePath)}`);
  }

  // "Which config did it actually pick up?" — the merged result, once, at
  // debug level. Live instances (client, mongoose, hooks, logger) are elided:
  // they are not serializable and redactDeep rightly refuses to clone them.
  {
    const { client, mongoose, hooks, logger, ...rest } = config;
    effectiveLogger(config.logger).debug(
      `Resolved config (source: ${configFilePath ? path.basename(configFilePath) : 'env/flags/defaults'})`,
      redactDeep({
        ...rest,
        ...(client ? { client: '[injected]' } : {}),
        ...(mongoose ? { mongoose: '[injected]' } : {}),
        ...(hooks ? { hooks: Object.keys(hooks) } : {}),
        ...(logger !== undefined ? { logger: logger === null ? null : '[injected]' } : {}),
      }),
    );
  }

  return config;
}

module.exports = { DEFAULT_CONFIG, isCollectionName, loadConfig, validateConfig };
