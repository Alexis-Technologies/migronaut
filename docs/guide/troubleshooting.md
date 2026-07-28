# Troubleshooting

Common problems and how to fix them. Each entry names the error you'll see, why it happens, and what
to do. For the full list of error codes, see the [Error Codes reference](/reference/error-codes).

## "Lock already held"

```
LockAlreadyHeldError: Migration lock is held by pid 48213 on host deploy-runner-7
```

**Why:** another `migronaut` process is running migrations, *or* a previous run crashed and left the lock
behind.

**Fix:**
- If a migration really is running elsewhere, wait — this is the lock doing its job.
- If you're sure nothing is running (e.g. a CI job was killed), clear it:
  ```bash
  migronaut unlock
  ```
- The lock also auto-expires after `lockTTLSeconds` (default 60), so waiting works too.

## "Checksum mismatch"

```
⚠ Warning  Checksum mismatch: 2026...-add-users-index.js
```

**Why:** the file was **edited after it was already applied**. `migronaut` detects this to stop you
silently changing history.

**Fix:**
- **Never edit an applied migration.** Instead, write a *new* migration for the change.
- If the edit was intentional and harmless (a comment, formatting), the warning is informational in
  the default (non-strict) mode and the file is skipped.
- If you truly need to re-run it, that's `migronaut up <file> --force` — but understand you're rewriting
  history. See [`migronaut up --force`](/commands/up#re-running-an-applied-migration).

## "Connection failed"

```
ConnectionFailedError: Failed to connect to MongoDB
```

**Why:** the `uri`/`dbName` is wrong, MongoDB isn't running, or the network/credentials are off.

**Fix:**
- Verify the server is up: `mongosh "<your-uri>"`.
- Check your config or env vars (`MIGRONAUT_URI`, `MIGRONAUT_DB`). See [Configuration](/guide/configuration).
- In Docker/CI, make sure the host is reachable (often `mongodb://mongo:27017`, not `localhost`).

## A `.ts` migration won't load

```
Cannot import a TypeScript migration: ERR_UNKNOWN_FILE_EXTENSION
```

**Why:** you're on a Node version below 22.18, which can't import `.ts` directly, and no TypeScript
loader is registered. `migronaut` runs under your Node and does not bundle a loader.

**Fix:** any one of:
- **Upgrade to Node ≥ 22.18** — `.ts` then loads natively, no setup.
- **Register a loader:** install `tsx` and run migronaut under it, e.g.
  `node --import tsx node_modules/@alexify/migronaut/bin/migronaut.js up`.
- **Use `.js` instead** (`migronaut create <name> --js`) — runs with zero setup on any supported Node.

See [Running TypeScript migrations](/guide/writing-migrations#running-typescript-migrations) for the
full breakdown.

## "MODULE_TYPELESS_PACKAGE_JSON" warning on every command

```
(node:48213) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///app/migronaut.config.js
is not specified and it doesn't parse as CommonJS. Reparsing as ES module because
export syntax was detected.
```

**Why:** Node's, not migronaut's. Your config or migration file uses ESM syntax (`export default`,
`export async function up`), but the nearest `package.json` has no `"type"` field. Node has to parse
the file twice to find out which module system it is, and warns each time. migronaut loads these files
with dynamic `import()` — the one mechanism that handles `.ts`, `.mjs`, `.cjs` and `.js` uniformly —
so the file reaches Node exactly as you wrote it.

It is only a warning: nothing is broken, and every command still works.

**Fix:** make the module type explicit, whichever suits the project:

- **Declare it once** — add `"type": "module"` to your `package.json` if the project is ESM.
- **Rename the file** — `migronaut.config.mjs` (or `.mts`) is unambiguously ESM, `.cjs` unambiguously
  CommonJS. Both load fine.
- **Use CommonJS syntax** in a `"type"`-less project:
  ```js
  // migronaut.config.js
  module.exports = { uri: 'mongodb://localhost:27017', dbName: 'my_app' };
  ```
  In a `.ts` config, `import type { MigronautConfig } from '@alexify/migronaut'` disappears during
  type-stripping, so it can be paired with `module.exports` and stays warning-free.

`migronaut init` and `migronaut create` already generate whichever syntax matches the `"type"` of your
nearest `package.json`, so files they create never trigger this.

## "Transaction numbers are only allowed on a replica set"

**Why:** you set `useTransaction` but your MongoDB is a standalone server. Transactions require a
replica set or sharded cluster.

**Fix:**
- Run a single-node replica set locally, or use a managed cluster (Atlas) which already is one.
- Or drop `useTransaction` for that migration if you don't need atomicity.

See [Transactions](/guide/transactions).

## "Migration is not applied"

```
NotAppliedError: 2026...-add-users-index.js has not been applied
```

**Why:** you tried to `down` (revert) a migration that isn't currently applied.

**Fix:** run `migronaut status` to see what's actually applied, then target a file that is.

## An imported migration won't revert

```
IrreversibleMigrationError: 2026...-legacy.js was imported from migrate-mongo and cannot be reverted
```

**Why:** migrations adopted via [`migronaut import`](/commands/import) use migrate-mongo's positional
`up(db, client)` signature, which migronaut can't run safely in reverse. This is intentional — it's caught
*before* anything is touched.

**Fix:** imported history is forward-only. To undo such a change, write a new migration that performs
the reverse operation.

## Still stuck?

- Run any command with `--json` to get a structured error object you can inspect.
- Check the [Error Codes reference](/reference/error-codes) for the exact `code` and its meaning.
- Open an issue: <https://github.com/Alexis-Technologies/migronaut/issues>.
