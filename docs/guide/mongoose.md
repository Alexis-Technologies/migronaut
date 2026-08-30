# Using Mongoose

`migronaut` works against the native MongoDB driver, but if your application is built on
[Mongoose](https://mongoosejs.com/), your migrations can use your models too. Mongoose is an
**optional peer dependency**: migronaut never imports it — you inject your own instance, and every
migration receives it as `ctx.mongoose`.

::: tip When to reach for models
Schema defaults, validators and middleware run inside a migration exactly as they do in your app.
That is the point of using models — and also the risk. For pure data reshaping (renames, backfills,
index changes), the native `ctx.db` is often the safer tool; use `ctx.mongoose` when you *want*
your schema semantics applied.
:::

## Inject your instance

Pass your Mongoose instance through the config (a `.ts`/`.js` config file or the programmatic API —
JSON configs cannot hold live objects):

```js
// migronaut.config.js
import mongoose from 'mongoose';

export default async () => {
  await mongoose.connect(process.env.MIGRONAUT_URI, { dbName: 'my_app' });

  return {
    // Reuse the SAME pool mongoose already opened — migronaut will not open a
    // second connection, and disconnect() leaves an injected client alone.
    client: mongoose.connection.getClient(),
    dbName: 'my_app',
    mongoose,
  };
};
```

Two things happen here:

- **`mongoose`** makes the instance available to every migration as `ctx.mongoose`.
- **`client`** hands migronaut the driver connection mongoose already holds
  (`mongoose.connection.getClient()`), so both run on one pool. Ownership stays with you:
  `disconnect()` never closes an injected client.

## Use models in a migration

Import your application's models, or define a throwaway schema inline:

::: code-group

```ts [TypeScript]
import type { MigrationContext } from '@alexify/migronaut';
import { User } from '../src/models/user.js';

export const description = 'Backfill display names from first/last name';

export async function up({ mongoose }: MigrationContext): Promise<void> {
  const users = await User.find({ displayName: { $exists: false } });
  for (const user of users) {
    user.displayName = `${user.firstName} ${user.lastName}`.trim();
    await user.save(); // validators + middleware run, exactly like in the app
  }
}

export async function down(_ctx: MigrationContext): Promise<void> {
  await User.updateMany({}, { $unset: { displayName: '' } });
}
```

```js [JavaScript]
import { User } from '../src/models/user.js';

export const description = 'Backfill display names from first/last name';

export async function up() {
  const users = await User.find({ displayName: { $exists: false } });
  for (const user of users) {
    user.displayName = `${user.firstName} ${user.lastName}`.trim();
    await user.save();
  }
}

export async function down() {
  await User.updateMany({}, { $unset: { displayName: '' } });
}
```

:::

Models imported from your app are bound to your app's Mongoose instance — the same one you injected,
so everything shares the one connection.

## Transactions with models

When a migration runs with `useTransaction` (see [Transactions](/guide/transactions)), the active
driver session arrives as `ctx.session`. Pass it to every Mongoose operation so model writes join
the migration's transaction:

```ts
import type { MigrationContext } from '@alexify/migronaut';
import { Account } from '../src/models/account.js';

export const useTransaction = true;

export async function up({ session }: MigrationContext): Promise<void> {
  await Account.updateMany({}, { $set: { currency: 'EUR' } }, { session });
  await Account.deleteMany({ balance: null }, { session });
}

export async function down({ session }: MigrationContext): Promise<void> {
  await Account.updateMany({}, { $unset: { currency: '' } }, { session });
}
```

::: warning Bodies may run more than once
The driver's `withTransaction` retries transient failures, so a transactional migration body can
execute twice. Keep model operations idempotent — the same rule as for native-driver migrations.
And as always: an operation without `{ session }` runs *outside* the transaction and won't be
rolled back.
:::

## At application startup

The same wiring works with the programmatic API — run migrations on boot against the connection
your app already opened:

```js
const mongoose = require('mongoose');
const { runMigrations } = require('@alexify/migronaut');

await mongoose.connect(process.env.MIGRONAUT_URI, { dbName: 'my_app' });

const { applied, upToDate } = await runMigrations(
  {
    client: mongoose.connection.getClient(),
    dbName: 'my_app',
    mongoose,
  },
  { onLockHeld: 'wait' },
);
if (!upToDate) console.log(`Applied ${applied.length} migration(s)`);
```

`runMigrations` still manages the migration lifecycle, but the injected client (and your mongoose
connection with it) stays open for the app afterwards.

## TypeScript note

`ctx.mongoose` is typed as `MongooseLike` — a structural stand-in, because a hard
`import type { Mongoose } from 'mongoose'` would break the declaration file for the majority of
users who never install the optional peer. When you need the full Mongoose type, cast once:

```ts
import type { Mongoose } from 'mongoose';

export async function up(ctx: MigrationContext): Promise<void> {
  const mongoose = ctx.mongoose as Mongoose;
  // full typings from here on
}
```

Models imported directly from your app (the examples above) are fully typed already — the cast is
only needed when you drive the instance itself.

## Next

- [Transactions](/guide/transactions) — atomic migrations, per file or globally
- [Programmatic API](/guide/api) — `runMigrations`, injected clients, lifecycle events
- [Writing Migrations](/guide/writing-migrations) — file anatomy, context, ordering
