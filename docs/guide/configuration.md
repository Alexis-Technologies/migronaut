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
| `ensureIndexes` | `boolean` | `true` | Create the changelog indexes on first connect |
| `clientOptions` | `MongoClientOptions` | — | Driver options: TLS, AWS IAM / X.509 auth, proxies, pool sizing |
| `client` | `MongoClient` | — | An already-connected client to reuse; migronaut never closes it |
| `timeoutMs` | `number` | — | Stop the run when one migration exceeds this (best-effort) |
| `reloadMigrations` | `boolean` | `false` | Bypass the ESM module cache (long-lived processes only) |
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

::: tip Connection timeout
The driver waits up to 30 s (its default `serverSelectionTimeoutMS`) before a
connection failure surfaces — a long time for a boot-time `runMigrations` or a
serverless cold start. Tighten it via `clientOptions`:

```js
clientOptions: { serverSelectionTimeoutMS: 5000 }
```
:::

## Environment variables

Every *scalar* option has an `MIGRONAUT_*` variable — which is what makes "a
config file is never required" literally true, not just a slogan. These
**override the config file**:

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
| `MIGRONAUT_TEMPLATE_PATH` | `templatePath` |
| `MIGRONAUT_TIMEOUT_MS` | `timeoutMs` |
| `MIGRONAUT_ON_LOCK_LOST` | `onLockLost` |
| `MIGRONAUT_ENSURE_INDEXES` | `ensureIndexes` |
| `MIGRONAUT_RELOAD_MIGRATIONS` | `reloadMigrations` |
| `MIGRONAUT_ENV_FILE` | `envFile` |

The remaining options — `fileExtensions`, `clientOptions`, and the live
instances `client`, `mongoose`, `hooks`, `logger` — are config-file/API only.
They hold arrays, objects or live handles, which a single environment string
cannot express.

::: warning Values are rejected, never coerced
A value that doesn't parse fails the run with a `CONFIG_INVALID` error naming
the variable. `MIGRONAUT_STRICT=on` does **not** quietly mean `false`, and
`MIGRONAUT_LOCK_TTL=abc` does not quietly mean "no TTL" — a typo in a safety
setting must never be the reason a safety setting is off.

Booleans accept `true`/`1`/`yes` and `false`/`0`/`no`, case-insensitive and
trimmed. Numbers must be positive integers.
:::

### Variables that shape the CLI, not the config

| Env var | Effect |
|---|---|
| `MIGRONAUT_NO_COLOR` | Disable ANSI color for migronaut only |
| `MIGRONAUT_FORCE_COLOR` | Force color on even when piped; `0` forces it off |
| `MIGRONAUT_USER` | Who to record in a changelog record's `executedBy`, overriding the OS user |

Color precedence, most specific first: `MIGRONAUT_FORCE_COLOR` >
`MIGRONAUT_NO_COLOR` > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > whether the
stream is a TTY. The `--no-color` flag beats all of them. The prefixed pair is
there so you can pin migronaut's own output without disturbing every other tool
in the same shell; the unprefixed pair is still honored underneath, because
[no-color.org](https://no-color.org) is an ecosystem-wide convention. There is
no `MIGRONAUT_TERM` — `TERM` describes what your terminal can render, not what
migronaut should do.

`MIGRONAUT_USER` matters in CI, where the OS user is a meaningless `runner` or
`root` and the identity worth stamping on the changelog is the deploy actor.

### `.env` files

`.env` is loaded from the working directory before env vars are read. Point
elsewhere with `--env-file <path>` (or `MIGRONAUT_ENV_FILE`), or skip it
entirely with `--no-env` / `envFile: false` — worth doing in CI, so a stray
`.env` cannot silently outrank a committed config. Loading uses Node's native
`util.parseEnv` — always present on the supported Node range (≥ 22.18), no dependency needed.
Real environment variables always win over `.env` values. Files above 1 MB (or anything that is
not a regular file) are rejected with `CONFIG_INVALID`. Supported syntax: one
`KEY=VALUE` per line, optional `export ` prefix, matching quotes, full-line and inline `#`
comments, and multiline values inside double quotes; `${VAR}` interpolation is not supported.

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
