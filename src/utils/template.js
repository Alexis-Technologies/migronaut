const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ConfigFileExistsError,
  ConfigInvalidError,
  MigrationFileNotFoundError,
} = require('../errors/index.js');
const { formatStamp } = require('./date.js');

/** Convert an arbitrary migration name into a kebab-case slug */
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the leading prefix for a migration filename.
 * Timestamp form (default) or zero-padded sequential form (`0001`).
 */
function buildPrefix(options) {
  if (options.sequential) {
    return String(options.index).padStart(4, '0');
  }
  return formatStamp(new Date());
}

/** Count existing migration files in a directory to derive the next sequence index */
async function nextSequenceIndex(dir, extensions) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 1;
    throw error;
  }
  let count = 0;
  for (const file of files) {
    for (const ext of extensions) {
      if (file.endsWith(ext)) {
        count += 1;
        break;
      }
    }
  }
  return count + 1;
}

/** The built-in TypeScript migration template */
function defaultTemplateTs() {
  return `import type { MigrationContext } from '@alexify/migronaut';

export const description = '';

export async function up({ db }: MigrationContext): Promise<void> {
  // TODO: implement migration
}

export async function down({ db }: MigrationContext): Promise<void> {
  // TODO: implement rollback
}
`;
}

/** The built-in JavaScript (ESM) migration template */
function defaultTemplateJs() {
  return `export const description = '';

/** @param {import('@alexify/migronaut').MigrationContext} ctx */
export async function up({ db }) {
  // TODO: implement migration
}

/** @param {import('@alexify/migronaut').MigrationContext} ctx */
export async function down({ db }) {
  // TODO: implement rollback
}
`;
}

/** Resolve template file contents — a custom template if provided, else the built-in */
async function resolveTemplateContent(templatePath, js) {
  if (templatePath) {
    try {
      return await fs.readFile(templatePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new MigrationFileNotFoundError('Template file not found', { templatePath });
      }
      throw error;
    }
  }
  return js ? defaultTemplateJs() : defaultTemplateTs();
}

/**
 * Create a new migration file on disk and return its absolute path.
 * The directory must already exist.
 */
async function createMigrationFile(options) {
  const ext = options.js ? '.js' : '.ts';
  const index = await nextSequenceIndex(options.dir, ['.ts', '.js']);
  const prefix = buildPrefix({ sequential: options.sequential, index });
  const filename = `${prefix}-${slugify(options.name)}${ext}`;
  const filepath = path.join(options.dir, filename);
  const content = await resolveTemplateContent(options.templatePath, options.js);
  await fs.writeFile(filepath, content, 'utf8');
  return filepath;
}

// ─── Config File Creation ───────────────────────────────────────────────────────

/** Merge caller-supplied config values over the built-in defaults */
function configFields(values) {
  return {
    uri: values.uri ?? 'mongodb://localhost:27017',
    dbName: values.dbName ?? 'myapp',
    migrationsDir: values.migrationsDir ?? './migrations',
  };
}

/**
 * The commented body shared by the TS and JS templates. Documents every option
 * so the file is the single place to set behavior and nothing has to be
 * remembered as a CLI flag. `createExtension` is seeded to match the config
 * file's own language (a `.ts` config defaults to TS migrations, `.js` to JS).
 */
function configBody(values, createExtension) {
  const { uri, dbName, migrationsDir } = configFields(values);
  return `  // ── Connection ──────────────────────────────────────────────
  // To load these from a secret manager instead, run: migronaut init --secret-provider
  uri: '${uri}',
  dbName: '${dbName}',

  // ── Migration files ─────────────────────────────────────────
  migrationsDir: '${migrationsDir}',
  // Extensions scanned when discovering migrations.
  fileExtensions: ['.ts', '.js'],
  // File type \`migronaut create\` generates by default ('ts' | 'js').
  // Override for a single run with --js / --ts.
  createExtension: '${createExtension}',
  // Use 0001-style sequential numbering instead of timestamps.
  sequential: false,
  // Path to a custom template used by \`migronaut create\`.
  // templatePath: './migration.template.ts',

  // ── Bookkeeping collections ─────────────────────────────────
  migrationsCollection: '_migronaut_migrations',
  lockCollection: '_migronaut_locks',
  // Seconds before a held lock is considered stale and reclaimable.
  lockTTLSeconds: 60,

  // ── Behavior ────────────────────────────────────────────────
  // Abort (instead of warn) when a file's checksum no longer matches.
  strict: false,
  // Wrap every migration in a transaction. Override per file with
  // \`export const useTransaction = true\`.
  useTransaction: false,

  // ── Lifecycle hooks (code only — not available in JSON config) ──
  // hooks: {
  //   beforeAll: async (ctx) => {},
  //   afterAll: async (ctx) => {},
  //   beforeEach: async (name, ctx) => {},
  //   afterEach: async (name, duration, ctx) => {},
  //   onError: async (name, error, ctx) => {},
  // },`;
}

/** The built-in TypeScript config template */
function defaultConfigTs(values = {}) {
  return `import type { MigronautConfig } from '@alexify/migronaut';

/**
 * migronaut configuration.
 * Precedence (highest first): CLI flags > MIGRONAUT_* env vars > this file > defaults.
 * Every field is optional; the values below are the built-in defaults.
 */
const config: Partial<MigronautConfig> = {
${configBody(values, 'ts')}
};

export default config;
`;
}

/** The built-in JavaScript (ESM) config template */
function defaultConfigJs(values = {}) {
  return `/**
 * migronaut configuration.
 * Precedence (highest first): CLI flags > MIGRONAUT_* env vars > this file > defaults.
 * Every field is optional; the values below are the built-in defaults.
 *
 * @type {Partial<import('@alexify/migronaut').MigronautConfig>}
 */
const config = {
${configBody(values, 'js')}
};

export default config;
`;
}

/**
 * The built-in JSON config template. JSON cannot hold comments or functions, so
 * the `hooks`, `mongoose`, and `logger` options are unavailable here — use a
 * `.ts`/`.js` config if you need them.
 */
function defaultConfigJson(values = {}) {
  const { uri, dbName, migrationsDir } = configFields(values);
  const config = {
    uri,
    dbName,
    migrationsDir,
    fileExtensions: ['.ts', '.js'],
    createExtension: 'js',
    sequential: false,
    migrationsCollection: '_migronaut_migrations',
    lockCollection: '_migronaut_locks',
    lockTTLSeconds: 60,
    strict: false,
    useTransaction: false,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Shared documentation block for the secret-provider templates. Explains the
 * factory-function form and — crucially — that the example uses AWS but ANY
 * provider works by editing `loadMongoSecret()`.
 */
const SECRET_PROVIDER_GUIDE = `/**
 * migronaut configuration — loads the connection from a secret manager.
 *
 * This config exports an async FUNCTION (not a plain object), so the MongoDB
 * connection is fetched at runtime on every \`migronaut\` command. The value stays in
 * memory and is never written to disk, so this file is safe to commit.
 *
 * Precedence (highest first): CLI flags > MIGRONAUT_* env vars > this file > defaults.
 *
 * ── Provider-agnostic ────────────────────────────────────────────────────────
 * The example below uses AWS Secrets Manager, but ANY source works — change
 * only the body of loadMongoSecret() to use Google Secret Manager, HashiCorp
 * Vault, Azure Key Vault, your own HTTP API, etc. It just has to return an
 * object containing at least { uri, dbName }. For example, Google:
 *
 *   import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
 *   const client = new SecretManagerServiceClient();
 *   const [version] = await client.accessSecretVersion({
 *     name: 'projects/PROJECT/secrets/mongo/versions/latest',
 *   });
 *   return JSON.parse(version.payload.data.toString());
 */`;

/**
 * The migration-tool options shared by both secret-provider templates, indented
 * to sit inside the returned object of the async factory (4 spaces).
 */
function secretConfigOptions(createExtension, migrationsDir) {
  return `    // ── Migration files ─────────────────────────────────────
    migrationsDir: '${migrationsDir}',
    fileExtensions: ['.ts', '.js'],
    createExtension: '${createExtension}',
    sequential: false,

    // ── Bookkeeping collections ─────────────────────────────
    migrationsCollection: '_migronaut_migrations',
    lockCollection: '_migronaut_locks',
    lockTTLSeconds: 60,

    // ── Behavior ────────────────────────────────────────────
    strict: false,
    useTransaction: false,`;
}

/** Secret-provider JavaScript (ESM) config template */
function secretConfigJs(values = {}) {
  const { migrationsDir } = configFields(values);
  return `${SECRET_PROVIDER_GUIDE}

// Install the SDK for your provider, e.g.:
//   npm install @aws-sdk/client-secrets-manager
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Fetch the connection details from your secret manager. Swap the body for
 * GCP / Vault / Azure / anything — it just has to return { uri, dbName }.
 */
async function loadMongoSecret() {
  // Secret name/ARN. Read from an env var so it can differ per environment.
  const secretId = process.env.MONGO_SECRET_ID ?? 'prod/myapp/mongo';

  // Region & credentials come from the environment (AWS_REGION,
  // AWS_ACCESS_KEY_ID/SECRET, or an attached IAM role).
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!res.SecretString) {
    throw new Error(\`Secret "\${secretId}" has no SecretString\`);
  }
  // Stored value is JSON, e.g. { "uri": "mongodb+srv://...", "dbName": "myapp" }
  return JSON.parse(res.SecretString);
}

/** @type {() => Promise<Partial<import('@alexify/migronaut').MigronautConfig>>} */
export default async () => {
  const secret = await loadMongoSecret();

  return {
    // ── Connection (from your secret) ───────────────────────
    uri: secret.uri,
    dbName: secret.dbName,

${secretConfigOptions('js', migrationsDir)}
  };
};
`;
}

/** Secret-provider TypeScript config template */
function secretConfigTs(values = {}) {
  const { migrationsDir } = configFields(values);
  return `${SECRET_PROVIDER_GUIDE}
import type { MigronautConfig } from '@alexify/migronaut';
// Install the SDK for your provider, e.g.:
//   npm install @aws-sdk/client-secrets-manager
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Fetch the connection details from your secret manager. Swap the body for
 * GCP / Vault / Azure / anything — it just has to return { uri, dbName }.
 */
async function loadMongoSecret(): Promise<{ uri: string; dbName: string }> {
  // Secret name/ARN. Read from an env var so it can differ per environment.
  const secretId = process.env.MONGO_SECRET_ID ?? 'prod/myapp/mongo';

  // Region & credentials come from the environment (AWS_REGION,
  // AWS_ACCESS_KEY_ID/SECRET, or an attached IAM role).
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!res.SecretString) {
    throw new Error(\`Secret "\${secretId}" has no SecretString\`);
  }
  // Stored value is JSON, e.g. { "uri": "mongodb+srv://...", "dbName": "myapp" }
  return JSON.parse(res.SecretString);
}

export default async (): Promise<Partial<MigronautConfig>> => {
  const secret = await loadMongoSecret();

  return {
    // ── Connection (from your secret) ───────────────────────
    uri: secret.uri,
    dbName: secret.dbName,

${secretConfigOptions('ts', migrationsDir)}
  };
};
`;
}

/**
 * Return the config file contents for the requested format. When
 * `secretProvider` is true a runtime secret-loading template is emitted instead
 * of the static object form — only valid for `js`/`ts` (JSON cannot hold code).
 */
function configTemplateContent(format, values = {}, secretProvider = false) {
  if (secretProvider) {
    if (format === 'json') {
      throw new ConfigInvalidError('Secret-provider configs are only available for js/ts', {
        format,
      });
    }
    return format === 'ts' ? secretConfigTs(values) : secretConfigJs(values);
  }
  if (format === 'js') {
    return defaultConfigJs(values);
  }
  if (format === 'json') {
    return defaultConfigJson(values);
  }
  return defaultConfigTs(values);
}

/**
 * Create an `migronaut.config.<format>` file on disk and return its absolute path.
 * Throws ConfigFileExistsError if the file exists and `force` is false.
 */
async function createConfigFile(options) {
  const filepath = path.join(options.dir, `migronaut.config.${options.format}`);
  if (!options.force) {
    const exists = await fs
      .access(filepath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new ConfigFileExistsError('Config file already exists', { path: filepath });
    }
  }
  const content = configTemplateContent(
    options.format,
    options.values ?? {},
    options.secretProvider ?? false,
  );
  await fs.writeFile(filepath, content, 'utf8');
  return filepath;
}

module.exports = {
  slugify,
  buildPrefix,
  nextSequenceIndex,
  defaultTemplateTs,
  defaultTemplateJs,
  resolveTemplateContent,
  createMigrationFile,
  defaultConfigTs,
  defaultConfigJs,
  defaultConfigJson,
  secretConfigJs,
  secretConfigTs,
  configTemplateContent,
  createConfigFile,
};
