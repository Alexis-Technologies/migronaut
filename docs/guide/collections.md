# Declared Collections

Some changes have a history worth keeping — a backfill, a field rename, a data fix that must run
exactly once. Those are [migrations](/guide/writing-migrations). Others only ever have a *current
value*: which indexes a collection has, which Atlas Search indexes, and which validator guards it.
For those, a migration
file per change is ceremony — an `up` that creates the index, a `down` that drops it, a new file
every time an option changes — when all anyone cares about is the end state.

Declared collections are migronaut's answer for the second kind. You declare the indexes, the
[search indexes](#search-indexes) and the validator you want;
[`migronaut converge`](/commands/converge) compares that with the live
database and makes the difference. No history, no state stored anywhere: every run reads the
database afresh and plans against what it finds.

::: warning Experimental
New in 2.1 — search indexes in 2.2, [versioning](#versioning) in 2.3. The definition shape, the
result shape and the queue job contract may still change in a minor release.
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
- **No `searchIndexes`** — its search indexes are not managed, and converge never even asks the
  server about Search for it.
- **No `validator`** — the validator is not managed. `validator: null` (or `{}`) means *there must
  be none*.

A definition that declares none of the three — nor [`versioning`](#versioning) — is refused: it
would manage nothing.

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

## Search indexes

[Atlas Search](https://www.mongodb.com/docs/atlas/atlas-search/) and
[Atlas Vector Search](https://www.mongodb.com/docs/atlas/atlas-vector-search/) indexes are
declared next to the regular ones, and the same `converge` keeps them in step — same lock, same
history, same plan-then-apply:

```js
{
  name: 'movies',
  indexes: [{ key: { year: 1 } }],
  searchIndexes: [
    { definition: { mappings: { dynamic: true } } }, // "default", a search index
    {
      name: 'plot_vectors',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
          { type: 'filter', path: 'year' },
        ],
      },
    },
  ],
}
```

| Field | Meaning |
|---|---|
| `name` | Defaults to `default`, as on the server |
| `type` | `'search'` (the default) or `'vectorSearch'` |
| `definition` | The definition exactly as Atlas documents it: `{ mappings, analyzer, … }` for search, `{ fields: [...] }` for vector search — automated-embedding (`autoEmbed`) fields included |

The definition is Atlas's own document, so it is checked lightly — the shape that tells the two
types apart, no repeated field, vector and `autoEmbed` fields not mixed — and compared whole.
Comparisons ignore key order and fill in the defaults the server writes into what it reports, on
both sides: at the top (`analyzer: 'lucene.standard'`, `searchAnalyzer` the same as `analyzer`,
`dynamic: false`, `storedSource: false`, `numPartitions: 1`), in field mappings (a `string` field's
`indexOptions`, `store` and `norms`, a `number` field's representation, an `autocomplete` field's
grams and tokenization, a `document` field's `dynamic` — nested fields and `multi` analyzers
too), and on vector fields (`quantization: 'none'`, `indexingMethod: 'hnsw'`, `hnswOptions: {
maxEdges: 16, numEdgeCandidates: 100 }`). Vector `fields`, and a field indexed as several types,
compare as sets. So a definition that leaves a default out matches a server that spells it out. Removing an option
you had declared is a change, like any other — when migronaut knows its default.

An option the server reports that the declaration does not set, and whose default migronaut does
**not** know — a newer `mongot` writing a new one into every definition — is left out of the
comparison: compared, it would make every converge update the index, and the server builds a search
index again on every update. converge names such options in a warning and on the row
(`ignored: ['mappings.fields.title.similarity']`). The cost: removing such an option from a
declaration goes unnoticed — to change it, declare the value you want. A *field* only the server has
is still a difference, and so is a field mapped as another type.

The plan's Detail column names what differs down to the option (`mappings.fields.title.norms`),
the first five paths and how many more.

**Where it works:** Atlas (every tier — the free tier holds at most 3 search and vector indexes,
Flex 10), an [Atlas CLI local deployment](https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-local/)
or its `mongodb/mongodb-atlas-local` Docker image, and MongoDB 8.3+ with `mongot`. A plain
`mongod` has no Search — see [below](#a-server-without-atlas-search).

| Action | When | How |
|---|---|---|
| `create` | A declared search index is missing | `createSearchIndexes` — one command per collection |
| `modify` | Its definition differs | `updateSearchIndex`, **in place** — on Atlas the old definition keeps serving queries until the new one is built |
| `drop` | A live search index is not declared, and `prune` is on | `dropSearchIndex` — **destructive**, asked for like an index drop |
| `keep` | Not declared, `prune` off — or already being deleted | Nothing — reported only |
| `conflict` | A change no update can make, a name the server is still deleting, or no Search on the server | The whole run is refused before the first write |
| `skip` | No Search on the server and `onSearchUnavailable: 'skip'` | Nothing — reported only |

`prune` covers search indexes only in a definition that declares `searchIndexes` — `searchIndexes:
[]` with prune drops every one (converge says so out loud).

### Never a rebuild

A `$search` against an index that does not exist returns no results — not an error. Dropping a
search index to build it again would be a silent outage for as long as the build takes, so
converge never does: what an update can change is updated in place, and what it cannot — the
**type** (`search` ↔ `vectorSearch`), or an `autoEmbed` field's **path, model, numDimensions,
quantization or modality** — is a `conflict`. The way through is a new index under a **new name**:
declare it next to the old one, converge (with `--wait-search`), move your queries to it, then
remove the old declaration and converge with `prune`.

::: warning Vector index updates on a local deployment
An Atlas CLI local deployment (the `mongodb/mongodb-atlas-local` image — MongoDB 8.0 and 8.3 in our
tests) refuses every update of a **vector** index; Atlas updates one in place. converge stops at
that step with `CONVERGE_FAILED` and the same new-name recipe as a hint. Search indexes update
fine everywhere.
:::

### Builds happen in the background

The server accepts a created or updated search index at once and builds it afterwards — seconds on
a small collection, longer on a large one. converge reports where each build is: in the plan's
Detail column (`PENDING`, `BUILDING`, `updating`, `FAILED: …`), in a closing line, and as
`result.search.notReady`. A build under way is not drift: `inSync` stays `true` and
`converge --check` passes. A **FAILED** build fails `--check` — but converge never resubmits a
definition that has not changed, so it stays failed until you change the definition (or the data
behind the failure).

```bash
migronaut converge --wait-search
```

With `waitForSearchIndexes: true` (`--wait-search` for one run) converge holds until every declared
search index is queryable with its declared definition, and fails with
[`CONVERGE_FAILED`](/reference/error-codes) (`phase: 'wait'`) on a FAILED build of an index the
run created or changed, or after `searchIndexWaitTimeoutMs` (10 minutes by default; the server goes
on building). An index that failed — or went `STALE` — before the run, its definition unchanged,
does not hold the wait: converge cannot fix it, so it is named and warned about instead, and
`converge --check` still fails on a FAILED one. Turn the wait on when a deploy needs a *new* index
ready as soon as it finishes. The wait only reads, so converge releases the migration lock when it
starts (`lock:released` with `early: true`): the next deploy, or a queue's next job, does not wait
out a long build. Meanwhile a newer converge may change the index — the wait accepts its newer
definition — or drop it, and then the wait runs out. The wait is reported as `converge:wait` events
(started, every 30 s, how it ended), in `result.search.wait` (`{ outcome, waitedMs }`) and the
converge history, and — with [`telemetry`](/guide/opentelemetry) — as
`migronaut.converge.search.wait.duration`. On Atlas an update needs no wait — the old
definition serves meanwhile; a local deployment reports the index not queryable for the moment
its new definition builds.

### A server without Atlas Search

Declared search indexes need Search. On a server without it, converge refuses the run before
writing anything — in every collection — and says how to get Search. When that server is
expected (a plain `mongo` container in development while production runs on Atlas), set
`onSearchUnavailable: 'skip'`: everything else converges, and the search indexes are reported as
`skip`. A converge with no `searchIndexes` declared anywhere never asks the server about Search.

```js
export default {
  // …
  onSearchUnavailable: process.env.NODE_ENV === 'development' ? 'skip' : 'fail',
};
```

`migronaut audit` checks the same thing ahead of time: its `search` check fails where converge
would refuse, and warns about a FAILED build.

## Versioning

A definition can also declare the **shape version** its documents are at and, for optimistic
concurrency, a **revision** — the `__v` / `__rev` contract that the repository helpers and
background migrations share. [Document Versioning](/guide/versioning) covers the whole release
cycle; this is what converge makes of it.

```js
{
  name: 'orders',
  versioning: { current: 2, min: 1 },
  indexes: [{ key: { customerId: 1 } }],
}
```

| Key | Default | Meaning |
|---|---|---|
| `current` | required | The shape version new documents are written at (an integer ≥ 1) |
| `min` | `1` | The oldest shape still allowed, from 0 to `current`. `0` types the fields without requiring them — for a collection whose documents predate versioning |
| `field` | `'__v'` | The version field: top level (no `.`, no leading `$`), at most 64 characters, not `_id` |
| `revision` | `true` | Also keep a revision field |
| `revisionField` | `'__rev'` | The revision field, by the same rules — and not the version field. An error with `revision: false` |
| `index` | `true` | Declare the version index |

The keys are checked like every other part of a definition: an unknown one is an error, so a typo
never reads as "not versioned". Versioning adds no new kind of row — its rules arrive as the
ordinary `validator` row, its index as an ordinary `index` row.

### The validator rules

```js
{
  $jsonSchema: {
    required: ['__v', '__rev'], // left out with min: 0
    properties: {
      __v: { bsonType: 'int', minimum: 1 }, // the minimum is min
      __rev: { bsonType: ['int', 'long'], minimum: 0 }, // without revision: false
    },
  },
}
```

How they meet your own validator:

- **None declared** (or `{}`) — these rules are the validator, at `validationLevel: 'moderate'`
  unless you set a level: an update to a legacy document that predates the rules still goes through.
- **A `$jsonSchema`** — merged in: your `required` and `properties` first, these after. The level
  stays yours (`strict` by default).
- **Query operators only** — the rules are added beside them as a top-level `$jsonSchema`, and the
  server applies both.
- **A rule of your own on `__v` or `__rev`** — in `properties`, in `required` or as a query — is an
  error: the fields are managed by versioning. So is `validator: null`, which would remove the rules.

The version gets a `minimum` and never a `maximum`: during a rolling deploy, or after a rollback, a
newer release writes a version the declaration does not know yet, and refusing that write would turn
the deploy into an outage. It must be an `int` — what the Node.js driver stores for a whole number
that fits in 32 bits. The revision may be an `int` or a `long`, because `$inc` turns it into a
`long` once it outgrows 32 bits.

### The version index

`{ __v: 1, _id: 1 }` (`__v_1__id_1`) — background migrations select documents by version through it,
and the `min` check below reads a single key of it.

- **With `indexes` declared**, it is added to them, and the list stays the whole truth: `prune`
  drops the other undeclared indexes as usual.
- **Without `indexes`**, it is the only index converge manages: the collection's other indexes are
  not listed and never dropped, `prune` or not — declaring versioning does not make them undeclared.
- **Declaring the same key yourself** while `index` is on is an error — remove it, or set
  `versioning.index: false` (then no version index is declared at all).

On a **sharded** collection — when converge can read the shard key, behind a `mongos` — the index
takes the shard key between the version field and `_id`: `{ __v: 1, region: 1, _id: 1 }` for a
shard key `{ region: 1 }`, so a background migration's batch over one chunk range is an index range.
A hashed shard-key field stays hashed, and `_id` is not repeated when the shard key holds it. If
the collection already has the ordinary version index (say, it was sharded after the index was
built), converge builds the new one and keeps the old — a `keep` row on `__v_1__id_1` whose reason reads
*replaced by the shard-key-prefixed version index — drop it once nothing hints it (prune does, when
the indexes are declared)*.

A background migration in flight may still be hinting it. With `indexes` declared, a converge with
`prune` drops it as any undeclared index; without them, `prune` never reaches it — drop it in a
migration once no background migration uses it.

### Raising `min`

Raising the floor is the contract step of a release, and converge checks the data before it takes
it. When `min` rises above the floor the live validator enforces, converge first looks for one
document below the new `min` — `_id` only, through the version index, for at most 60 seconds. If it
finds one, the `validator` row is a `conflict` and the whole run is refused before its first write:

> documents below version 2 remain — raising versioning.min would leave them invalid; let the
> background migration that upgrades them finish (migronaut background status), then converge again

If the check cannot run — a timeout on a large collection that has no version index yet — the raise
is refused too: converge with the old `min` first, so the index exists, then raise it. The
`converge --check` dry run reports a raise that cannot happen yet as drift. No document is ever
named: its id may be personal data.

The check costs nothing in the steady state: it runs only when `min` actually rises — never for a
collection that does not exist yet, never at `min: 0`. If an old release writes old-shape documents
while the raise is being applied, converge cannot take the validator back: it warns, after the run,
that documents below `min` were written — run the background migration again once that release is
gone.

Since `min` defaults to 1, declaring versioning over documents that have no `__v` yet is refused the
same way. Adopt with `min: 0`, upgrade them with a background migration `from: 0`, then raise it —
see [Adopting an existing collection](/guide/versioning#adopting-an-existing-collection).

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

## History

Converge is stateless — it never acts on a record of what it did — but it keeps one for you. Every
converge that changes something or fails appends an entry to `_migronaut_converge`
(`convergeLogCollection`): when, triggered how (`converge` or the converge after `up`), the run id,
who ran it and where (`executedBy`, `host`, `environment`), who asked and why (`requestedBy`,
`reason`), and every index or validator it touched with its `from` and `to`. A converge that finds
everything in place is not recorded, and a database that never converges never gets the
collection.

```bash
migronaut converge --reason "TICKET-123: email must be unique"
migronaut converge --history            # the newest 20; --limit n, --json
```

```js
await kit.converge({ requestedBy: 'alice', reason: 'TICKET-123' });
const [last] = await kit.convergeHistory({ limit: 1 });
```

Writing the history is best-effort, like the changelog's failure trace: if it cannot be written the
converge warns and carries on.

## When to use a migration instead

Use a migration when the change needs **ordering against data**:

- a unique index over data that must be deduplicated first — write the dedupe as a migration,
  then declare the index (with `convergeAfterUp` the converge follows it automatically);
- moving data between collections, renaming fields, backfills;
- dropping or renaming a collection — converge never does either.

## Things to know

- **Index builds hold the migration lock.** A large build can take minutes, and every pod that
  converges at boot waits for it. Converge big collections from a deploy step, not application
  startup. New indexes of one collection are built by a single `createIndexes` — one pass over
  the collection, all or nothing — and each build is announced as it starts (`converge:action`
  with status `started`, and a log line).
- **A broken connection mid-build is reported, not repaired.** If the connection fails (or a
  client-side timeout fires) while a rebuild's new index is being built, the server may still be
  building it, so the old index is not put back; the error says so, and `converge --dry-run`
  shows what the server finished. Give the client used for converge timeouts that outlast your
  largest build.
- **Permissions.** Creating and dropping indexes needs `readWrite`; `collMod` — validators, TTL
  and `hidden` changes — needs `dbAdmin`; search indexes need the `createSearchIndexes`,
  `updateSearchIndex`, `dropSearchIndex` and `listSearchIndexes` actions (`readWrite` on Atlas). A
  missing privilege fails with a hint.
- **Mongoose `autoSearchIndex`.** Leave it off (the default) for collections converge manages —
  it creates search indexes without comparing, and the two would fight over the definition.
- **Search indexes on views** (Atlas 8.0+) are not managed: converge manages regular collections
  only.
- **Some changes need no rebuild.** Where the server can, converge changes an index in place
  instead of dropping it: `hidden`, a TTL's value, **making an index unique** (MongoDB 7.0+:
  `collMod` with `prepareUnique`, then `unique` — duplicates make it fail and the index is left as
  it was; 6.0 has the commands but did not enforce the converted index in our tests, so it gets a
  rebuild) and **adding a TTL** to a single-field index (5.1+). The plan shows these as `modify`.
- **No zero-gap rebuild.** Anything else is a `recreate`, which drops before it creates. To change an index with no
  window, declare the new one under a **new name**, converge, then remove the old declaration
  and converge with `prune`. For a **unique** index the window is a real risk — a duplicate
  written during the build leaves neither index buildable — so such a rebuild is a `conflict`
  unless you converge with `rebuildUnique` (`--rebuild-unique`); after `up` and in a queue job it
  never happens.
- **A changed definition reaches each worker on redeploy.** A worker still running old code
  converges to the old declaration — with `prune`, it can drop an index the new one added. Roll
  the workers before relying on a new declaration.
- **Sharded clusters.** Behind a `mongos`, converge reads each collection's shard key (from
  `config.collections`, when the user may) and never prunes the index that backs it; if the key
  cannot be read and the server refuses the drop, the index is kept with a warning. Index builds
  go through `mongos` as usual. CI proves replica sets, not sharded clusters — try a converge
  with `--dry-run` there first.
- **Tested on MongoDB 5.0, 6.0, 7.0 and 8.0** — search indexes against
  `mongodb/mongodb-atlas-local` 8.0 and 8.3. The comparison rules follow what the server reports; on
  another version (or as Atlas adds to the definition format), anything that does not settle shows
  up under `unstable` rather than looping.

## Programmatic use

```js
const { MigratorKit } = require('@alexify/migronaut');

const kit = new MigratorKit({ uri, dbName, collections });
const plan = await kit.converge({ dryRun: true });   // no lock, no writes
if (!plan.inSync) await kit.converge();              // under the lock
await kit.disconnect();
```

`converge()` resolves with `{ dryRun, changed, inSync, collections: [{ name, actions }],
unstable?, search? }`. See the [Programmatic API](/guide/api#declared-collections) for the full shape and
the events, and [Migrations as a Queue](/guide/bullmq#converge-jobs) to run it as a job.
