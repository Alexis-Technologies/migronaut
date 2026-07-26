# Configuration

`migronaut` resolves configuration from four sources, in priority order:

```
CLI flags  >  Environment variables  >  Config file  >  Defaults
```

A config file is **never required** — env vars alone are always sufficient.

## Config file

On startup, `migronaut` looks in the current working directory for the first of:

1. `migronaut.config.ts`
2. `migronaut.config.js`
3. `migronaut.config.json`

Generate one with [`migronaut init`](/commands/create#migronaut-init). Override discovery with `--config <path>`.

::: code-group

```js [migronaut.config.js]
export default {
  uri: process.env.MIGRONAUT_URI ?? 'mongodb://localhost:27017',
  dbName: 'my_app',
  migrationsDir: './migrations',
  migrationsCollection: '_migronaut_migrations',
  strict: false,
  useTransaction: false,
  createExtension: 'js',
};
```

```ts [migronaut.config.ts]
import type { MigronautConfig } from '@alexify/migronaut';

const config: Partial<MigronautConfig> = {
  uri: process.env.MIGRONAUT_URI ?? 'mongodb://localhost:27017',
  dbName: 'my_app',
  migrationsDir: './migrations',
  createExtension: 'ts',
};

export default config;
```

```json [migronaut.config.json]
{
  "uri": "mongodb://localhost:27017",
  "dbName": "my_app",
  "migrationsDir": "./migrations"
}
```

:::

## Async / factory config (secret managers)

A `.ts`/`.js` config may `export default` a **function** (sync or async) that returns the config.
This is the dependency-free way to load a connection from a secret manager at runtime — the library
ships no cloud SDKs, you bring your own inside the function:

```ts
import type { MigronautConfigInput } from '@alexify/migronaut';

const loadConfig: MigronautConfigInput = async () => {
  const { uri, dbName } = await fetchFromSecretsManager(); // your code
  return { uri, dbName, migrationsDir: './migrations' };
};

export default loadConfig;
```

Generate a ready-made AWS Secrets Manager template with `migronaut init --secret-provider` (swap the body
for Google/Vault/Azure/any source — it just must return `{ uri, dbName }`).

## All options

| Option | Type | Default | Description |
|---|---|---|---|
| `uri` | `string` | — | MongoDB connection URI **(required)** |
| `dbName` | `string` | — | Database name **(required)** |
| `migrationsDir` | `string` | `'./migrations'` | Directory holding migration files |
| `migrationsCollection` | `string` | `'_migronaut_migrations'` | Collection storing the changelog |
| `lockCollection` | `string` | `'_migronaut_locks'` | Collection used for the concurrency lock |
| `lockTTLSeconds` | `number` | `60` | Seconds before a lock is considered stale |
| `strict` | `boolean` | `false` | Abort (vs. warn) on a checksum mismatch |
| `useTransaction` | `boolean` | `false` | Wrap every migration in a transaction globally |
| `fileExtensions` | `string[]` | `['.ts', '.js']` | Extensions scanned in the migrations dir |
| `createExtension` | `'ts' \| 'js'` | `'js'` | Default file type for `migronaut create` |
| `sequential` | `boolean` | `false` | Use `0001-` numbering instead of timestamps |
| `templatePath` | `string` | — | Path to a custom migration template |
| `environment` | `string` | `NODE_ENV` → `'production'` | Value stamped on the `environment` field of changelog records |
| `onLockLost` | `'abort' \| 'warn'` | `'abort'` | What to do if the lock is lost mid-run |
| `envFile` | `string \| false` | `'.env'` | `.env` file to load, or `false` to load none |
| `mongoose` | `Mongoose` | — | Mongoose instance, if your migrations use it |
| `hooks` | `MigrationHooks` | — | [Lifecycle hooks](/guide/hooks) |
| `logger` | `MigronautLogger \| null` | built-in | Custom logger (pino-compatible `{debug, info, warn, error}` — a pino instance works directly); `null` silences all output |

Log methods receive an optional second argument with structured fields —
`{ runId, migration, direction, batch, durationMs }` — so a machine-readable
logger does not have to parse the human string. A pino-style logger (one with
`child()`) gets them in pino's own `(fields, msg)` order instead. A plain
one-argument logger keeps working unchanged.

`runId` is a per-run correlation id: it is also the lock's owner token and is
stored on every changelog record that run writes, so a leftover lock can be
traced to the exact migrations it was holding.

## Environment variables

Every core option has an `MIGRONAUT_*` variable. These **override the config file**:

| Env var | Maps to |
|---|---|
| `MIGRONAUT_URI` | `uri` |
| `MIGRONAUT_DB` | `dbName` |
| `MIGRONAUT_MIGRATIONS_DIR` | `migrationsDir` |
| `MIGRONAUT_COLLECTION` | `migrationsCollection` |
| `MIGRONAUT_LOCK_COLLECTION` | `lockCollection` |
| `MIGRONAUT_LOCK_TTL` | `lockTTLSeconds` |
| `MIGRONAUT_STRICT` | `strict` |
| `MIGRONAUT_USE_TRANSACTION` | `useTransaction` |
| `MIGRONAUT_SEQUENTIAL` | `sequential` |
| `MIGRONAUT_CREATE_EXTENSION` | `createExtension` |
| `MIGRONAUT_ENVIRONMENT` | `environment` |
| `MIGRONAUT_ENV_FILE` | `envFile` |

`.env` is loaded from the working directory before env vars are read. Point
elsewhere with `--env-file <path>` (or `MIGRONAUT_ENV_FILE`), or skip it
entirely with `--no-env` / `envFile: false` — worth doing in CI, so a stray
`.env` cannot silently outrank a committed config. Loading works — natively via `util.parseEnv` on
Node ≥ 20.12, with a built-in fallback parser on older Node (migronaut has zero runtime
dependencies). Real environment variables always win over `.env` values. Supported syntax: one
`KEY=VALUE` per line, optional `export ` prefix, matching quotes, full-line and inline `#`
comments; multiline values, `\n` expansion and `${VAR}` interpolation are not supported.

```bash
# .env
MIGRONAUT_URI=mongodb://localhost:27017
MIGRONAUT_DB=my_app
```

## Global CLI flags

These flags work on every command and have the **highest** precedence:

| Flag | Overrides |
|---|---|
| `--uri <uri>` | `MIGRONAUT_URI` / `uri` |
| `--db <name>` | `MIGRONAUT_DB` / `dbName` |
| `--dir <path>` | `MIGRONAUT_MIGRATIONS_DIR` / `migrationsDir` |
| `--config <path>` | Config file auto-discovery |

```bash
migronaut up --uri "mongodb://localhost:27017" --db my_app --dir ./db/migrations
```
