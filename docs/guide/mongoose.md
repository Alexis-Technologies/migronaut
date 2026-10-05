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

## Document versioning

When a collection declares [`versioning`](/guide/versioning), its model has to write by the same
rules as everything else: stamp new documents with the shape version, bump the revision on every
write. `versioningPlugin` does both for the writes that go through Mongoose:

```js
const mongoose = require('mongoose');
const { versioningPlugin } = require('@alexify/migronaut/versioning');

const orderSchema = new mongoose.Schema({ customerId: String, total: Number });
orderSchema.plugin(versioningPlugin, require('../collections/orders'));
// or, from a registry: orderSchema.plugin(shapes.plugin('orders'));

module.exports = mongoose.model('Order', orderSchema);
```

The second argument is the collection definition — the same file converge reads — or its
`versioning` block. The plugin never imports Mongoose: it works through the schema you pass.

| | What the plugin does |
|---|---|
| **The revision** | Becomes the schema's `versionKey` (`__rev`), with `optimisticConcurrency: true`: every `save()` of a loaded document filters on the revision it was loaded at and bumps it, and a stale one throws Mongoose's `VersionError`. A document loaded without `__rev` is revision 0, guarded the same way |
| **New documents** | Stamped with `current` before validation, and again before save (validation can be skipped) — `create`, `save` and `insertMany` |
| **The version path** | A `Number` with **no default**: Mongoose applies defaults to the documents it *loads*, which would mark a legacy document as current without upgrading it. A schema that gives the field a default is refused |
| **Query updates** | `updateOne`, `updateMany` and `findOneAndUpdate` (and so `findByIdAndUpdate`) get `$inc: { __rev: 1 }` unless they write `__rev` themselves. With `upsert`, the version goes on `$setOnInsert` unless the update sets it, and an inserted document starts at revision 1 |

The plugin sees only document saves and those three query updates. Everything else needs the
[helpers](/guide/versioning#the-repository-layer):

| Write | Instead |
|---|---|
| `insertMany(docs, { lean: true })` | Stamp first: `shapes.onInsert('orders', docs)` |
| `bulkWrite` | Stamp the inserts, `bumpRevision` the updates, `stampUpsert` the upserts |
| `replaceOne`, `findOneAndReplace` | `replaceWithRevision(Order.collection, …)` |
| A pipeline update (an array) | `bumpRevision(pipeline)` — it appends the stage |
| Anything through `Order.collection` | The same helpers — the driver collection is what they take |

From `min: 1` up, the validator catches a forgotten stamp: an insert without `__v` or `__rev` is
refused. Nothing catches a forgotten bump — see
[the revision invariant](/guide/versioning#the-revision-invariant).

With `revision: false` the plugin leaves Mongoose's version key alone — unless it is the version
field itself (both are `__v` by default): then it turns Mongoose's version key off, so array changes
are never counted into the shape version. There are no update hooks in that case.

::: tip Typed documents
A Mongoose document is typed from its schema. For the per-version union, read with
`.lean<AnyShape<Shapes, 'orders'>>()` — see [Typed shapes](/guide/versioning#typed-shapes).
:::

### Adopting versioning in an existing Mongoose app

Every document a Mongoose model has written carries `__v` — Mongoose's own version key, a counter it
raises on some array changes. It is not a shape version, yet it holds the same kind of number: a
legacy document at `__v: 2` would read as shape version 2. Three releases move a collection over
without `__v` ever meaning two things at once.

**R0 — hand the revision to `__rev`.** Declare versioning that requires nothing yet, and turn the
plugin on:

```js
// collections/orders.js
module.exports = { versioning: { current: 1, min: 0 } };
```

`current: 1` names the shape the app writes today. Converge types the fields without requiring them
and builds the version index; the plugin moves Mongoose's version key to `__rev`. From here on
Mongoose never writes its counter into `__v`: new documents get `__v: 1, __rev: 0`, and legacy ones
keep the counter they had — with no `__rev`, they are revision 0.

Two things change for the app. Every `save()` is now guarded: a stale save that used to win
silently throws `VersionError` — reload and retry, or answer with a conflict. And the guard — yours,
and a background migration's — only sees writes that bump `__rev`, so it is complete once every pod
runs R0, not before.

Decide here where the shape version lives:

- **In `__v`** (the default). Mongoose's old counters stay in it until R1 clears them — until then,
  do not branch on `__v`.
- **In a field of its own** — `versioning: { current: 1, min: 0, field: 'shapeVersion' }`. Nothing
  to clear: the old `__v` values are dead data Mongoose no longer uses, and the R1 background
  migration can drop them.

**R1 — backfill.** Once R0 runs everywhere, a [background migration](/guide/background-migrations)
lifts the legacy documents — version 0 — to version 1:

```js
// migrations/20261012090000-orders-adopt-versioning.js
export const background = {
  collection: 'orders',
  from: 0,
  to: 1,
  migrate: (doc) => doc, // the shape does not change: the engine sets __v and bumps __rev
};
```

With a field of its own, `migrate: ({ __v, ...doc }) => doc` drops Mongoose's old counter on the way.

Keeping `__v`, two kinds of legacy document slip past it. A counter above 1 is not version 0, so the
background migration skips it — and it would later pass for shape version 2, 3, … without ever
having been migrated. A counter of exactly 1 reads as version 1, the right shape — but a legacy
document R0 never wrote has no `__rev`, which R2's validator requires. Put both back to version 0
first, in a regular migration that sorts before the background one:

```js
// migrations/20261012085900-orders-clear-mongoose-counters.js
import { bumpRevision } from '@alexify/migronaut/versioning';

export const description = "Orders: clear Mongoose's old counters out of __v";

export async function up({ db }) {
  await db
    .collection('orders')
    .updateMany(
      { $or: [{ __v: { $gt: 1 } }, { __v: 1, __rev: { $exists: false } }] },
      bumpRevision({ $set: { __v: 0 } }),
    );
}

export async function down() {
  // Nothing to restore: the counters meant nothing once R0 shipped.
}
```

It reads through the version index and writes only the documents it fixes. On a very large
collection with many of them, run the same update from a `step` background migration instead, so it
does not hold the migration lock.

**R2 — tighten.** Once the background migration has completed (`migronaut background status`):

```js
// collections/orders.js
module.exports = { versioning: { current: 1, min: 1 } };
```

Converge refuses the raise while a single document is below version 1 — a `conflict`, nothing
written — so R2 cannot land early. From then on the validator requires `__v` and `__rev` on every
document and refuses an insert that skipped the stamp. Real shape changes now follow the ordinary
[expand → background migration → contract](/guide/versioning#a-release-end-to-end) release.

## Next

- [Transactions](/guide/transactions) — atomic migrations, per file or globally
- [Programmatic API](/guide/api) — `runMigrations`, injected clients, lifecycle events
- [Writing Migrations](/guide/writing-migrations) — file anatomy, context, ordering
- [Document Versioning](/guide/versioning) — shape versions, optimistic concurrency, typed shapes
