# Declared Collections

Some changes have a history worth keeping — a backfill, a field rename, a data fix that must run
exactly once. Those are [migrations](/guide/writing-migrations). Others only ever have a *current
value*: which indexes a collection has, and which validator guards it. For those, a migration
file per change is ceremony — an `up` that creates the index, a `down` that drops it, a new file
every time an option changes — when all anyone cares about is the end state.

Declared collections are migronaut's answer for the second kind. You declare the indexes and the
validator you want; [`migronaut converge`](/commands/converge) compares that with the live
database and makes the difference. No history, no state stored anywhere: every run reads the
database afresh and plans against what it finds.

::: warning Experimental
New in 2.1. The definition shape, the result shape and the queue job contract may still change
in a minor release.
:::

## Declaring a collection

```js
// migronaut.config.js
export default {
  uri: process.env.MIGRONAUT_URI,
  dbName: 'my_app',
  collections: [
    {
      name: 'users',
      indexes: [
        { key: { email: 1 }, unique: true },
        { key: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 30 },
        { key: { name: 1 }, collation: { locale: 'en', strength: 2 } },
      ],
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['email'],
          properties: { email: { bsonType: 'string' } },
        },
      },
      validationLevel: 'strict', // the default
      validationAction: 'error', // the default
    },
  ],
};
```

An index is declared in the driver's own `createIndexes` shape — `key` plus options, flat:

| Field | Meaning |
|---|---|
| `key` | Field → direction (`1`, `-1`, `'text'`, `'hashed'`, `'2d'`, `'2dsphere'`), in index order. A compound key with an integer-like field name (`'2'`) must be a `Map` — a plain object reorders such names — and that field must come first: the driver reads the live key back as a plain object, so any other order could never compare as unchanged (manage such an index in a migration) |
| `name` | Defaults to the name MongoDB generates — `email_1`, `a_1_b_-1` |
| `unique`, `sparse`, `hidden` | Booleans |
| `expireAfterSeconds` | A TTL, in seconds |
| `partialFilterExpression`, `collation`, `wildcardProjection` | As MongoDB defines them |
| `weights`, `default_language`, `language_override` | Text indexes |
| `bits`, `min`, `max`, `2dsphereIndexVersion`, `textIndexVersion`, `storageEngine` | Compared only when you declare them |

Every option is checked, and an unknown one is an error. That strictness is on purpose: the driver
silently drops options it does not know, so a typo like `uniqe: true` would build a non-unique
index — and then look in sync forever.

Leave a part out to leave it alone:

- **No `indexes`** — the collection's indexes are not managed at all (a validator-only definition
  never touches an index).
- **No `validator`** — the validator is not managed. `validator: null` (or `{}`) means *there must
  be none*.

A definition that declares neither is refused: it would manage nothing.

## One file per collection

For more than a handful of collections, point `collectionsDir` at a directory with one definition
per file — the collection name defaults to the file name:

```js
// migronaut.config.js
export default {
  uri: process.env.MIGRONAUT_URI,
  dbName: 'my_app',
  collectionsDir: './collections',
};
```

```ts
// collections/users.ts
import type { CollectionDefinitionFile } from '@alexify/migronaut';

export default {
  indexes: [{ key: { email: 1 }, unique: true }],
  validator: { $jsonSchema: { bsonType: 'object', required: ['email'] } },
} satisfies CollectionDefinitionFile;
```

```json
// collections/orders.json
{ "indexes": [{ "key": { "customerId": 1, "createdAt": -1 } }] }
```

- Extensions are your `fileExtensions` (`.ts`, `.js` by default) plus `.json`; dotfiles and
  `.d.ts` files are skipped, and subdirectories are not read.
- Set `name` explicitly when the collection name cannot be a file name, or differs from it.
- A file must export **one plain object**. A function is refused — a Mongoose model is one, and a
  definitions directory is exactly where one might be left by mistake.
- The directory is opt-in: nothing is read unless `collectionsDir` is set, and a configured one
  that does not exist is an error. Files are loaded when a converge runs, not when the config is
  read — a broken definition file never blocks `status` or an emergency `down`.

Both sources combine: `collections` first, then the files. A collection declared twice — in both,
or in two files — is refused.

## What converge does

```bash
migronaut converge --dry-run
```

```
◎ Planned  3 change(s) in 1 of 2 collection(s)
┌────────────┬───────────┬────────────┬──────────┬────────────────────┐
│ Collection │ Target    │ Index      │ Action   │ Detail             │
├────────────┼───────────┼────────────┼──────────┼────────────────────┤
│ users      │ validator │            │ modify   │ validator          │
│ users      │ index     │ email_1    │ recreate │ unique             │
│ users      │ index     │ ttl        │ modify   │ expireAfterSeconds │
│ users      │ index     │ legacy_1   │ keep     │ not declared       │
└────────────┴───────────┴────────────┴──────────┴────────────────────┘
Would make 3 change(s) in 1 of 2 collection(s) · 1 drop/rebuild · 1 undeclared index(es) kept · 4 unchanged
```

| Action | When | How |
|---|---|---|
| `create` | A declared index (or the collection itself, or its validator) is missing | `createIndexes`, `createCollection`, `collMod` |
| `modify` | Only the TTL of an index that already has one, or `hidden`, changed — or the validator | `collMod`, in place, no rebuild |
| `recreate` | Anything else about a declared index changed | Drop, then create — **destructive** |
| `drop` | A live index is not declared, and `prune` is on | `dropIndex` — **destructive** |
| `keep` | A live index is not declared, and `prune` is off | Nothing — reported only |
| `unchanged` | Already as declared | Nothing |
| `conflict` | See [below](#conflicts) | The whole run is refused before the first write |

Comparisons are made the way the server stores things, so what converge creates compares as
unchanged on the next run: a text index is matched in its `_fts`/`_ftsx` form, a collation is
compared field by field against the full spec the server expands it to — `strength`, `caseLevel`
and `numericOrdering` default to `3`, `false` and `false` when left out (the same for every
locale, so `{ locale: 'en' }` does not match a live strength-2 index), every other field only when
declared — an index that carries the
collection's default collation is not mistaken for a changed one, and `{ locale: 'simple' }` means
*no collation*. As a last guard, every collection that was changed is read again afterwards:
anything that still differs is reported under `unstable` (and logged) instead of being rebuilt on
every run.

Steps run one at a time, in a fixed order per collection: the collection, its validator, new
indexes, in-place changes, rebuilds, and only then drops — so an index is removed only once
everything declared exists. The first failure stops the run with
[`CONVERGE_FAILED`](/reference/error-codes); a rebuild whose new index fails to build (a unique
index over duplicate values, typically) puts the old one back first.

## Undeclared indexes and `prune`

By default converge never drops an index you did not declare. It lists it as `keep`, and that
does not count as drift. Turn on `prune` to make the declaration the whole truth:

```js
{ name: 'users', indexes: [/* … */], prune: true }   // this collection only
```

```bash
migronaut converge --prune   # every collection whose definition does not say
```

A definition's own `prune` always wins over the flag (or `converge({ prune })`) — so
`prune: false` protects a collection where other tools create indexes too.

::: warning Mongoose autoIndex
If Mongoose (or anything else) also creates indexes on a collection, do not prune it: the two
would drop and recreate each other's indexes forever. Either declare those indexes, or leave
`prune` off for that collection.
:::

## Conflicts

MongoDB keeps one index per key, partial filter and collation, whatever the names — and at most
one text index per collection. When a declared index would collide with an undeclared live one:

- **identical but differently named** — accepted as is (`unchanged`, with a warning). Renaming
  would mean a full rebuild and, for a unique index, a window without the constraint.
- **different** — a `conflict`, and the run is refused before anything is written. Declare the
  index under the name it already has, or converge with `prune` to replace it.

With `prune` on, both cases are resolved by replacing the live index. A view or a time-series
collection is a conflict too: converge manages regular collections only.

## After every deploy

```js
export default {
  // …
  convergeAfterUp: true,
};
```

With `convergeAfterUp`, a bulk `migronaut up` (and `runMigrations`) ends by converging, under the
same lock — even when no migration was pending, so a converge that failed last time is retried by
the next deploy. It never runs after `up <file>`, `up --to` or `redo`: the declared state
describes the *newest* schema, and a unique index often depends on a dedupe migration that a
partial run has not reached. `up --converge` / `--no-converge` decide for one run.

`up` keeps returning its migration rows; the converge outcome arrives as the `converge:end`
event, as `summary.converge` from `runMigrations`, and in the log. In this mode there is no
prompt: `convergeAfterUp` is the consent.

`migronaut dry-run up` does not preview the converge — the plan is only meaningful against the
database the migrations leave behind. Run `migronaut converge --dry-run` once they are applied.

## When to use a migration instead

Use a migration when the change needs **ordering against data**:

- a unique index over data that must be deduplicated first — write the dedupe as a migration,
  then declare the index (with `convergeAfterUp` the converge follows it automatically);
- moving data between collections, renaming fields, backfills;
- dropping or renaming a collection — converge never does either.

## Things to know

- **Index builds hold the migration lock.** A large build can take minutes, and every pod that
  converges at boot waits for it. Converge big collections from a deploy step, not application
  startup.
- **Permissions.** Creating and dropping indexes needs `readWrite`; `collMod` — validators, TTL
  and `hidden` changes — needs `dbAdmin`. A missing privilege fails with a hint.
- **No zero-gap rebuild.** A `recreate` drops before it creates. To change an index with no
  window, declare the new one under a **new name**, converge, then remove the old declaration
  and converge with `prune`. For a **unique** index the window is a real risk — a duplicate
  written during the build leaves neither index buildable — so such a rebuild is a `conflict`
  unless you converge with `rebuildUnique` (`--rebuild-unique`); after `up` and in a queue job it
  never happens.
- **A changed definition reaches each worker on redeploy.** A worker still running old code
  converges to the old declaration — with `prune`, it can drop an index the new one added. Roll
  the workers before relying on a new declaration.
- **Tested on MongoDB 5.0, 6.0, 7.0 and 8.0.** The comparison rules follow what the server
  reports; on another version, anything that does not settle shows up under `unstable` rather
  than looping.

## Programmatic use

```js
const { MigratorKit } = require('@alexify/migronaut');

const kit = new MigratorKit({ uri, dbName, collections });
const plan = await kit.converge({ dryRun: true });   // no lock, no writes
if (!plan.inSync) await kit.converge();              // under the lock
await kit.disconnect();
```

`converge()` resolves with `{ dryRun, changed, inSync, collections: [{ name, actions }],
unstable? }`. See the [Programmatic API](/guide/api#declared-collections) for the full shape and
the events, and [Migrations as a Queue](/guide/bullmq#converge-jobs) to run it as a job.
