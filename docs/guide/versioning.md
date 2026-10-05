# Document Versioning

A document's shape changes over the life of a product: a field is renamed, an address moves into a
subdocument, a status becomes an object. Two numbers on every document keep that manageable:

- **`__v` — the shape version.** Which shape the document is in. New documents are written at the
  current version; older ones are rewritten by a [background migration](/guide/background-migrations)
  after the release that introduced the new shape.
- **`__rev` — the revision.** How many times the document has been written. A write that must not
  overwrite someone else's change filters on the revision it read and bumps it — optimistic
  concurrency.

migronaut keeps both under one contract. You declare it once, on the
[collection definition](/guide/collections); converge enforces it in the database (a validator, an
index, a guard on the contract step); and `@alexify/migronaut/versioning` gives your repository layer
the same rules the background migration engine writes by.

::: warning Experimental
New in 2.3. The `versioning` key, the `@alexify/migronaut/versioning` API and its types may still
change in a minor release (named in the CHANGELOG).
:::

## The contract

Everything that writes a versioned collection — the repository helpers, the
[Mongoose plugin](/guide/mongoose#document-versioning) and background migrations — follows the same
three rules:

1. **A missing (or `null`) field counts as 0.** A document that predates versioning is version 0 and
   revision 0. Nothing needs a backfill before the first guarded write: a write that expects
   revision 0 matches a document with no `__rev` at all.
2. **Every write bumps the revision** (`$inc: { __rev: 1 }`) in a collection that keeps one — guarded
   or not. See [the revision invariant](#the-revision-invariant).
3. **The version is set, never incremented.** Two releases that write the same shape agree on its
   number.

## Declaring versioning

```ts
// collections/orders.ts
import type { CollectionDefinitionFile } from '@alexify/migronaut';

export default {
  versioning: { current: 2, min: 1 },
  indexes: [{ key: { customerId: 1, createdAt: -1 } }],
} as const satisfies CollectionDefinitionFile;
```

`as const` keeps `current` a literal for [typed shapes](#typed-shapes); a plain `.js` or `.json`
definition works the same at run time.

| Key | Default | Meaning |
|---|---|---|
| `current` | required | The shape version new documents are written at (an integer ≥ 1) |
| `min` | `1` | The oldest shape still allowed, from 0 to `current`. `0` types the fields without requiring them |
| `field` | `'__v'` | The version field — top level, not `_id` |
| `revision` | `true` | Also keep a revision. Without one, a background migration on the collection must say `occ: 'version-only'` |
| `revisionField` | `'__rev'` | The revision field — not the version field |
| `index` | `true` | Declare the version index `{ __v: 1, _id: 1 }` |

Every key is checked, and an unknown one is an error — a typo like `currnet` must not read as
"not versioned". Converge then makes three things of the block:

- **validator rules** — the version an `int` with a `minimum` of `min`, the revision an `int` or a
  `long` ≥ 0, both required unless `min` is 0 — merged into your validator, or making up the whole
  validator (at `validationLevel: 'moderate'`) when you declare none;
- **the version index** that background migrations scan — on a sharded collection, with the shard
  key between `__v` and `_id`;
- **a guard on `min`**: it refuses to raise the floor while documents below it remain, before
  writing anything.

[Declared Collections → Versioning](/guide/collections#versioning) has the details. The version
deliberately gets no `maximum`: during a rolling deploy — or after a rollback — a newer release
writes a version the declaration does not know yet, and refusing that write would turn a deploy into
an outage.

### Adopting an existing collection

`min` defaults to 1, so declaring `{ current: 1 }` over documents that have no `__v` is refused —
every one of them is below version 1. Adopt in three steps:

1. `versioning: { current: 1, min: 0 }` — the fields are typed, nothing is required yet, and your
   code starts stamping new documents (`stamp`, or the Mongoose plugin).
2. A background migration `from: 0, to: 1` — `migrate: (doc) => doc` when the shape itself does not
   change: the engine sets the version and bumps the revision.
3. `min: 1`, once it has completed. Converge refuses the raise until then.

A Mongoose app has one more thing to untangle — there, `__v` is Mongoose's own version key. See the
[Mongoose runbook](/guide/mongoose#adopting-versioning-in-an-existing-mongoose-app).

## The repository layer

`@alexify/migronaut/versioning` is a separate entry point for the code that reads and writes your
documents. It loads no part of the migration engine, and neither the driver nor Mongoose: the
helpers take your collection and use only its methods — a driver `Collection`, a Mongoose model's
`Model.collection`, or anything with the same `updateOne`, `replaceOne`, `findOneAndUpdate` and
`findOne`.

### `defineShapes` — one source of truth

```js
const { defineShapes } = require('@alexify/migronaut/versioning');

// The same definition files converge declares the collections with
const shapes = defineShapes({ orders: require('./collections/orders') });
```

It also takes a list of definitions with a `name` — `defineShapes(config.collections)` — and skips
the unversioned ones. Either way, the version your repository writes and the version the validator
demands come from the same file and cannot drift apart.

| Member | What it does |
|---|---|
| `stamp(name, doc)` | A copy of `doc` with `__v: current` and `__rev: 0` — each only when missing, so stamping twice changes nothing |
| `onInsert(name, docs)` | `stamp` for one document or each of an array — for `insertOne` / `insertMany` |
| `stampUpsert(name, update)` | An upsert's operator update with `$setOnInsert` of the version (unless the update sets it) and the revision bumped — an inserted document starts at revision 1 |
| `current(name)` | The version new documents are written at |
| `get(name)` | The collection's versioning, every default filled in |
| `versionOf(name, doc)` | A document's version — 0 when the field is missing |
| `isCurrent(name, doc)` / `isVersion(name, doc, v)` | Version checks — type guards in the [typed form](#typed-shapes) |
| `upcaster(name, steps, options?)` | An [upcaster](#upcaster) over the collection's versioning |
| `plugin(name)` | The [Mongoose plugin](/guide/mongoose#document-versioning), bound to the collection |
| `names`, `has(name)` | The versioned collections |

An unknown name throws `ConfigInvalidError`; a version field that is not a non-negative integer
throws `ShapeVersionError` (`reason: 'invalid'`).

```js
await orders.insertOne(shapes.stamp('orders', { customerId, shipping: { address }, total }));
// → { customerId, shipping, total, __v: 2, __rev: 0 }

await orders.insertMany(shapes.onInsert('orders', drafts));

await orders.updateOne(
  { orderNo },
  shapes.stampUpsert('orders', { $set: { total } }),
  { upsert: true },
); // → { $set: { total }, $setOnInsert: { __v: 2 }, $inc: { __rev: 1 } }
```

`stampUpsert` refuses a pipeline or a replacement — `$setOnInsert` has no place in either.

## Optimistic concurrency

```js
const { updateWithRevision } = require('@alexify/migronaut/versioning');

const order = await orders.findOne({ _id });
await updateWithRevision(orders, { _id }, order.__rev ?? 0, { $set: { status: 'paid' } });
```

The write matches `{ _id, __rev: <the revision you read> }` and adds `$inc: { __rev: 1 }`. The
expected revision must be a number — pass `order.__rev ?? 0` for a document without one: expected
revision 0 also matches a missing or `null` `__rev`. If the write matches nothing, someone wrote in
between or the document is gone, and it throws `RevisionConflictError` (`REVISION_CONFLICT`). To
say which, it reads the document once more and sets `context.reason`:

| `reason` | Meaning |
|---|---|
| `'conflict'` | The document is at another revision — `context.actual` |
| `'not-found'` | Nothing matches the filter |
| `'unknown'` | Could not tell: the read was turned off (`verify: false`), it failed, or it found the expected revision again (the filter missed on something else) |

`context.expected` is the revision you held, and `context.collection` the collection's name (when
the collection object has one). The filter is never copied into the error — it may carry personal
data.

| Helper | |
|---|---|
| `updateWithRevision(collection, filter, expectedRevision, update, options?)` | `updateOne` under the guard — an operator update or a pipeline. Resolves to the driver's result plus `revision`, the new one |
| `replaceWithRevision(collection, filter, expectedRevision, replacement, options?)` | `replaceOne` under the guard. The replacement's revision field is set to the next revision |
| `findOneAndUpdateWithRevision(collection, filter, expectedRevision, update, options?)` | `findOneAndUpdate` under the guard. Resolves to the document — after the update, unless `returnDocument: 'before'` — the same way on every driver version |

| Option | Default | Meaning |
|---|---|---|
| `field`, `revisionField` | `'__v'`, `'__rev'` | The field names — the helpers do not read your definition, so pass custom names here |
| `version` | — | Also set the version field to this: an upgrade written on the way |
| `verify` | `true` | On a miss, read the document once more to say why; `false` reports `unknown` |

Everything else goes to the driver — `session` (the follow-up read uses it too), `hint`,
`collation`, `arrayFilters`, … Refused with `ConfigInvalidError` before anything is sent:
`upsert: true` (a miss would insert a second document instead of reporting the conflict), `w: 0` (a
conflict could not be seen), a filter that already constrains `__rev`, an update that writes `__rev`
itself — or `__v` while `version` is given — and, for the two update helpers, a replacement document
or a pipeline that projects or replaces the root.

::: warning A replacement is the whole document
`replaceWithRevision` writes exactly what you pass, plus the new revision. Carry the version field
over, or pass `version` — a replacement without `__v` turns the document into version 0.
:::

### Retrying a conflict

```js
const { retryOnConflict, updateWithRevision } = require('@alexify/migronaut/versioning');

await retryOnConflict(async () => {
  const order = await orders.findOne({ _id });
  if (order === null) return null;
  return updateWithRevision(orders, { _id }, order.__rev ?? 0, {
    $set: { status: nextStatus(order) },
  });
});
```

`retryOnConflict(fn, options?)` runs `fn(attempt)` — read, decide, write with a guard — again after a
`RevisionConflictError`, up to `attempts` times in all (default 3), with a full-jitter backoff in
between: `backoff: { baseMs, maxMs }` (default 10 and 1000), or a function of the attempt number
returning milliseconds. A `signal` cuts a wait short. A `not-found` is never retried — reading again
will not bring the document back — and any other error is thrown at once.

What a final conflict becomes — an HTTP 409, a retry later, a message to the user — is the
application's call; `context.reason` gives it what it needs to decide.

### The revision invariant

In a collection with revisions, **every write must bump `__rev`** — not only the guarded ones. A
background migration rewrites each document under the same kind of filter — the `_id`, version and
revision it read — so a write that leaves the revision alone is invisible to it: when both changed
the same field, the application's write is lost without a trace.

The helpers and the Mongoose plugin bump for you. For a write that needs no guard, `bumpRevision`
adds the bump to the update you already have:

```js
const { bumpRevision } = require('@alexify/migronaut/versioning');

await orders.updateMany({ customerId }, bumpRevision({ $set: { region: 'eu' } }));
// → { $set: { region: 'eu' }, $inc: { __rev: 1 } }
```

It takes an operator update or a pipeline (one stage appended), and refuses a replacement or an
update that writes `__rev` itself. Nothing in the database notices a forgotten bump — the validator
checks types, not history — so make these helpers the way your code writes a versioned collection.

The guard itself stays a choice per write: protect the aggregates where a lost update matters, bump
everywhere else.

## Upcasting on read — the exception {#upcaster}

An upcaster holds one collection's shape changes as plain functions, one per version step:

```js
// src/shapes.js
const { defineShapes } = require('@alexify/migronaut/versioning');

const shapes = defineShapes({ orders: require('../collections/orders') });
const orderShapes = shapes.upcaster('orders', {
  1: ({ address, ...doc }) => ({ ...doc, shipping: { address } }), // v1 → v2
});

module.exports = { shapes, orderShapes };
```

(`upcaster(definition, steps, options?)` builds the same from a collection definition or its
`versioning` block.) It is used two ways, and they are not equal:

- **`step(from)` — the norm.** The `migrate` of the background migration that rewrites the stored
  documents: `migrate: orderShapes.step(1)`. The database ends up in the new shape.
- **`upcast(doc)` — the exception.** Lifts a document to the current shape in memory, without writing
  it, for a read path that cannot wait for the background migration.

```js
const order = orderShapes.upcast(await orders.findOne({ _id })); // always the v2 shape
```

Why only the exception: the database keeps the old shape. Queries, indexes and other services still
see v1, every read pays for the transformation again, and the old shape never leaves until a
background migration rewrites it. That is also why migronaut has no automatic on-read hook — an
explicit `upcast` keeps the cost where you can see it.

- **Every version from `min` to `current − 1` needs a step.** A missing one, a step past `current`,
  an `async` step or one that is not a function is a `ConfigInvalidError` when the upcaster is
  created. Steps below `min` are allowed — a background migration file may still use one.
- **Steps are synchronous and pure.** A step gets a private copy (plain objects, arrays and `Date`s
  copied, BSON values shared), may change it freely, and returns the document at the next version.
  The helper sets `__v`: a step only reshapes.
- **`upcast`** returns a current document as is — the same object — and lifts an older one on a copy.
  It throws `ShapeVersionError` (`SHAPE_VERSION_UNSUPPORTED`) with `context.reason`:
  - `'newer'` — the document is newer than `current`: a newer release wrote it (an old pod meeting a
    new document during a rolling deploy). With `{ newer: 'keep' }` it is returned as is instead;
  - `'below-min'` — it is older than the oldest step;
  - `'invalid'` — its version field is not a non-negative integer, or a step returned something that
    is not a document.
- **`needsUpcast(doc)`** says whether `upcast` would change the document; **`step(from, to)`** spans
  several versions at once.

## Typed shapes

`versioning.d.ts` types documents by version without a code generator: you declare each shape once,
as a TypeScript type, and the rest is derived. It needs **TypeScript ≥ 5.0**.

```ts
// src/shapes.ts
import type { ObjectId } from 'mongodb';
import { type AnyShape, defineShapes } from '@alexify/migronaut/versioning';
import orders from '../collections/orders.js'; // { versioning: { current: 2, min: 1 } } as const

interface OrderV1 {
  _id: ObjectId;
  customerId: string;
  address: string;
  total: number;
}
interface OrderV2 {
  _id: ObjectId;
  customerId: string;
  shipping: { address: string };
  total: number;
}

export type Shapes = { orders: { 1: OrderV1; 2: OrderV2 } };
export type AnyOrder = AnyShape<Shapes, 'orders'>;

export const shapes = defineShapes<Shapes>()({ orders });
export const orderShapes = shapes.upcaster('orders', {
  1: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
});
```

Bodies are declared **without** `__v` and `__rev`: the version comes from the key, as a literal, so
the two can never disagree. A collection typed with the union narrows on the version:

```ts
const collection = db.collection<AnyOrder>('orders');

function addressOf(order: AnyOrder): string {
  switch (order.__v) {
    case 1:
      return order.address; // OrderV1
    case 2:
      return order.shipping.address; // OrderV2
  }
}

await collection.insertOne(
  shapes.stamp('orders', { _id: new ObjectId(), customerId, shipping: { address }, total }),
);
```

| Type | What it is |
|---|---|
| `AnyShape<S, C>` | Any stored document of `C` — a union discriminated by the version field; `switch (doc.__v)` or `isVersion` narrows it |
| `CurrentShape<S, C>` | A stored document at the current (highest) version |
| `ShapeAt<S, C, V>` | A stored document at version `V`, with its system fields |
| `CurrentVersion<S, C>` | The highest version, as a literal |
| `Body<T>` | `T` without its system fields — what a transformation returns, since the engine writes them |
| `Stamped<T, V>` | `T` with its system fields at `V` |
| `BackgroundMigrationFor<S, C, F, T>` | A background migration from `F` to `T`, its `migrate` and `revert` typed by both shapes |

Version 0 may be in the map too — `{ 0: LegacyUser; 1: UserV1 }` — typed as a document whose `__v`
is missing, `null` or 0 and whose `__rev` is optional. `isVersion(doc, version, { field? })` narrows
outside the registry the same way.

The typed registry, `defineShapes<Shapes>()(definitions)`, is curried so that the shape map is given
and the definitions inferred — at run time it is the plain `defineShapes`.

- **The definitions must cover exactly the map's collections** — a missing or an extra one does not
  compile.
- **A literal `current` must be the highest version in the map.** The error is terse: written
  inline, it reads `Type 'number' is not assignable to type 'never'`; from an imported `as const`
  definition, `Type '3' is not assignable to type '2'`. A `current` the compiler only knows as
  `number` — a definition without `as const` — cannot be checked, and is accepted.
- **`stamp('orders', body)`** takes a body of the current shape and returns a `CurrentShape`;
  `isCurrent` and `isVersion` are type guards; `current('orders')` is the literal `2`.
- **Upcaster steps are typed by the map** — the document at `v` in, the body at `v + 1` out — so a
  missing step or a wrong result does not compile. `{ newer: 'keep' }` widens what `upcast` returns.
- **Custom names flow through** — a `field`, a `revisionField` or `revision: false` in the
  definition changes every type the registry returns.

A background migration typed by the map:

```ts
// migrations/20261012090000-orders-shipping-v2.ts
import type { BackgroundMigrationFor } from '@alexify/migronaut/versioning';
import { orderShapes, type Shapes } from '../src/shapes.js';

export const background: BackgroundMigrationFor<Shapes, 'orders', 1, 2> = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: orderShapes.step(1),
  revert: ({ shipping, ...doc }) => ({ ...doc, address: shipping.address }),
};
```

::: tip Projections and Mongoose
A projection or an aggregation changes the shape — give `project()` or `aggregate()` a type of its
own. A Mongoose document is typed from its schema, not from the map: read with
`.lean<AnyOrder>()` to get the union.
:::

## A release, end to end

Orders move the address into `shipping.address`: version 1 becomes version 2. Three steps — expand,
background migration, contract — and at no point a release that breaks the one before it.

### 1. Expand

The release ships code that **reads both shapes and writes the new one**, the declaration that says
so, and the background migration that will do the rewrite:

```js
// collections/orders.js
module.exports = { versioning: { current: 2, min: 1 }, indexes: [/* … */] };
```

`current: 2` stamps new documents at v2; `min: 1` keeps every v1 document valid.

```js
const { isVersion, replaceWithRevision } = require('@alexify/migronaut/versioning');

// Read: both shapes
const order = await orders.findOne({ _id });
const address = isVersion(order, 1) ? order.address : order.shipping.address;

// Write: the new shape
await orders.insertOne(shapes.stamp('orders', { customerId, shipping: { address }, total }));

// Rewriting a v1 document anyway? Upgrade it on the way — the whole v2 shape, one guarded write.
await replaceWithRevision(orders, { _id }, order.__rev ?? 0, {
  ...orderShapes.upcast(order),
  status: 'paid',
});
```

A partial update of a v1 document must leave it a valid v1 document — or upgrade it whole, as above
(`updateWithRevision` with `version: 2` does the same for an update).

```js
// migrations/20261012090000-orders-shipping-v2.js
import { orderShapes } from '../src/shapes.js';

export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: orderShapes.step(1),
  revert: ({ shipping, ...doc }) => ({ ...doc, address: shipping.address }),
};
```

`up` only registers it: the migration line stays free, and nothing waits for the rewrite. A
background migration's `to` cannot pass the collection's `current`, so the file and the declaration
ship together.

::: tip The rolling deploy
While the release rolls out, pods of the previous one still write v1 — `min: 1` allows it, and the
background migration picks those documents up on a later pass (or, once it has completed, its drift
watch does). They also meet v2 documents written by the new pods. If the previous release cannot
read v2 — an upcaster there throws `ShapeVersionError` with `reason: 'newer'` — ship the reading half
first: a release that reads both shapes and still writes v1.
:::

### 2. The background migration

It runs beside the migration line — `migronaut background run`, `startBackgroundRunner()` inside
your app, or [the queue](/guide/bullmq) — in partitions, with checkpoints, pause and resume, and the
same optimistic filter as your repository, so an application write in between is never lost. Watch
it with `migronaut background status`. [Background Migrations](/guide/background-migrations) covers
it all.

### 3. Contract

Once it has completed, a release drops v1:

```js
// collections/orders.js
module.exports = { versioning: { current: 2, min: 2 }, indexes: [/* … */] };
```

```js
// migrations/20261109090000-orders-contract.js
export const requires = ['20261012090000-orders-shipping-v2.js'];
export const description = 'Orders: drop the v1 address index an earlier migration built';

export async function up({ db }) {
  await db.collection('orders').dropIndex('address_1');
}

export async function down({ db }) {
  await db.collection('orders').createIndex({ address: 1 });
}
```

Two gates keep this release from landing early:

- **`up` will not apply a migration whose `requires` has not completed.** It throws
  `BackgroundPendingError` (`BACKGROUND_PENDING`) with nothing run — or, with
  `onBackgroundPending: 'stop'`, ends the run there cleanly. It checks the data, not only the
  status: a completed background migration whose collection holds v1 documents again is reopened,
  and the migration waits for it.
- **Converge will not raise `min`** while a single v1 document remains — a `conflict`, refused before
  any write.

From then on the validator refuses any v1 write — a forgotten worker's included — and the code can
drop the v1 branch. Keep the background migration file loadable, though: it stays in `migrations/`,
and `down` runs its `revert`. If its `migrate` comes from your upcaster, keep that step (and, typed,
version 1 in the shape map) — steps below `min` are allowed.

## What migronaut deliberately does not do

- **No base repository, no ODM.** The helpers are functions over your collection. Caching, domain
  invariants and aggregates belong to your code — or to Mongoose.
- **No automatic on-read hooks.** Nothing upgrades or rewrites a document because it was read (no
  Mongoose `post('init')` magic): it would hide the cost, turn reads into writes and race your
  optimistic writes. `upcast` is explicit and never writes.
- **No HTTP 409 policy.** `RevisionConflictError` says why the write missed (`context.reason`);
  mapping that onto a status code or a retry policy is the transport's job.
- **No mandatory guard on every write.** Optimistic concurrency is per write, where a lost update
  matters. What is universal is the bump — [the revision invariant](#the-revision-invariant).
- **No `maximum` on the version.** A newer release writes ahead of the declaration during a rolling
  deploy or after a rollback.
- **No automated contract step.** Raising `min` is a change you make to the definition; converge
  guards it and never makes it on its own.
- **No types generated from `$jsonSchema`.** Shapes are TypeScript types you write; the type-level
  machinery derives the rest, with no build step.

## Next

- [Background Migrations](/guide/background-migrations) — running the rewrite: partitions, lanes,
  pause and resume, the drift watch
- [Declared Collections → Versioning](/guide/collections#versioning) — the validator, the index and
  the `min` guard in detail
- [Using Mongoose → Document versioning](/guide/mongoose#document-versioning) — the plugin and the
  runbook for an existing Mongoose app
- [Error Codes](/reference/error-codes) — `REVISION_CONFLICT`, `SHAPE_VERSION_UNSUPPORTED`,
  `BACKGROUND_PENDING`
