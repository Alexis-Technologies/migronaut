const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dotenv = require('dotenv');
const { z } = require('zod');
const { ConfigInvalidError } = require('../errors/index.js');

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

const configSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  dbName: z.string().min(1, 'dbName is required'),
  migrationsDir: z.string().min(1),
  migrationsCollection: z.string().min(1),
  lockCollection: z.string().min(1),
  lockTTLSeconds: z.number().int().positive(),
  strict: z.boolean(),
  useTransaction: z.boolean(),
  fileExtensions: z.array(z.string().min(1)).min(1),
  createExtension: z.enum(['ts', 'js']),
  sequential: z.boolean(),
  templatePath: z.string().min(1).optional(),
  mongoose: z.unknown().optional(),
  hooks: z.unknown().optional(),
  logger: z.unknown().optional(),
});

/** Parse a string into a boolean. 'true'/'1'/'yes' (case-insensitive) → true */
function parseBoolean(value) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/** Copy only the defined keys from `source` onto `target`, mutating and returning target */
function mergeDefined(target, source) {
  for (const key of Object.keys(source)) {
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
  if (env.MIGRONAUT_STRICT !== undefined) result.strict = parseBoolean(env.MIGRONAUT_STRICT);
  if (env.MIGRONAUT_USE_TRANSACTION !== undefined) {
    result.useTransaction = parseBoolean(env.MIGRONAUT_USE_TRANSACTION);
  }
  if (env.MIGRONAUT_SEQUENTIAL !== undefined) {
    result.sequential = parseBoolean(env.MIGRONAUT_SEQUENTIAL);
  }
  if (env.MIGRONAUT_CREATE_EXTENSION === 'ts' || env.MIGRONAUT_CREATE_EXTENSION === 'js') {
    result.createExtension = env.MIGRONAUT_CREATE_EXTENSION;
  }
  return result;
}

/** Locate a config file in `cwd`, returning its absolute path or null */
function discoverConfigFile(cwd) {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, name);
    if (existsSync(candidate)) {
      return candidate;
    }
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
async function loadConfigFile(filepath) {
  if (filepath.endsWith('.json')) {
    const raw = readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  }
  const mod = await import(pathToFileURL(filepath).href);
  const exported = mod.default ?? mod;

  if (typeof exported === 'function') {
    try {
      return await exported();
    } catch (error) {
      throw new ConfigInvalidError('Config factory function failed to resolve', {
        path: filepath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return exported;
}

/**
 * Resolve the final MigronautConfig by merging, in priority order:
 * CLI flags > environment variables > config file > defaults.
 *
 * Throws ConfigInvalidError when the merged result fails validation.
 */
async function loadConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();

  dotenv.config({ path: path.join(cwd, '.env'), override: false });

  const merged = { ...DEFAULT_CONFIG };

  const configFilePath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : discoverConfigFile(cwd);

  if (configFilePath) {
    if (!existsSync(configFilePath)) {
      throw new ConfigInvalidError('Config file not found', { path: configFilePath });
    }
    const fileConfig = await loadConfigFile(configFilePath);
    mergeDefined(merged, fileConfig);
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

  const schema = requireDb
    ? configSchema
    : configSchema.extend({ uri: z.string(), dbName: z.string() });
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigInvalidError('Invalid configuration', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const config = merged;

  if (config.logger) {
    if (configFilePath) {
      config.logger.dim(`Loaded config from ${path.basename(configFilePath)}`);
    }
  }

  return config;
}

module.exports = { DEFAULT_CONFIG, loadConfig };
