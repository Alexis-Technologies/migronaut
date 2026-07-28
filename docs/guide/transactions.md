# Transactions

`migronaut` can wrap a migration in a MongoDB session + transaction so that **either every
operation commits, or none do**. This is opt-in and works at two levels.

::: warning Requires a replica set
MongoDB transactions require a replica set (or a sharded cluster). A standalone `mongod` does not
support them. Local development with `mongodb-memory-server` spins up a replica set automatically.
:::

## Enable per file

Export `useTransaction = true` from a migration:

::: code-group

```ts [TypeScript]
import type { MigrationContext } from '@alexify/migronaut';

export const useTransaction = true;

export async function up({ db, session }: MigrationContext): Promise<void> {
  await db.collection('accounts').updateMany({}, { $inc: { balance: 0 } }, { session });
  await db.collection('ledger').insertOne({ migratedAt: new Date() }, { session });
}

export async function down({ db, session }: MigrationContext): Promise<void> {
  await db.collection('ledger').deleteMany({}, { session });
}
```

```js [JavaScript]
export const useTransaction = true;

export async function up({ db, session }) {
  await db.collection('accounts').updateMany({}, { $inc: { balance: 0 } }, { session });
  await db.collection('ledger').insertOne({ migratedAt: new Date() }, { session });
}
```

:::

::: tip Always pass `session`
For operations to participate in the transaction, you **must** pass `ctx.session` to each driver
call. An operation without `{ session }` runs outside the transaction and won't be rolled back.
:::

## Enable globally

Set `useTransaction: true` in your config to wrap **every** migration in a transaction by default. A
per-file `useTransaction` still overrides the global setting.

```js
// migronaut.config.js
export default {
  uri: 'mongodb://localhost:27017',
  dbName: 'my_app',
  useTransaction: true, // every migration is transactional unless it opts out
};
```

## How it behaves

When a transactional migration runs:

1. A MongoDB session starts and the migration body runs inside `session.withTransaction()`.
2. The session is exposed as `ctx.session` to your `up`/`down`.
3. Still **inside** that transaction, migronaut writes the changelog record for the migration.
4. The transaction commits — your writes and the changelog record together, in one commit.
5. On any thrown error → the transaction aborts, the `onError` hook fires, and the batch stops.

This means a failed transactional migration leaves the database in its original state — no partial
writes.

### The changelog is part of the transaction

Step 3 is the reason this matters beyond your own writes. The record that says *"this migration ran"*
commits in the same transaction as the migration itself, so the two can never disagree. Without that,
a crash in the window between committing the migration and recording it would leave the migration
**applied but unrecorded** — and the next `migronaut up` would run it a second time.

`withTransaction` also gives you the driver's documented commit protocol for free: it retries
`TransientTransactionError` and `UnknownTransactionCommitResult` instead of surfacing a network blip
as a failed migration.

### Without `useTransaction`

The non-transactional path is unchanged: the migration runs, and the changelog record is written
immediately afterwards as a separate write. That gap is small but real — a process killed inside it
leaves a migration applied with no record of it.

Turning on `useTransaction` is what closes the gap, which is worth knowing when you choose per file:

| | Migration writes | Changelog record |
|---|---|---|
| `useTransaction: true` | Roll back together on failure | Commits atomically with the migration |
| `useTransaction: false` (default) | Whatever your `up()` already did stays | Written right after — a crash between the two loses it |

If your MongoDB is a standalone `mongod` and transactions aren't available to you, keep migrations
idempotent (`createIndex`, `updateMany` with a guard filter) so a re-run is harmless.
