# Seeding Data

`migronaut` has no dedicated seeding feature — deliberately. A seed run is just a **second
migration profile**: the same engine, the same file format, the same lock, pointed at its own
directory and its own changelog collection. Everything on this page uses configuration that
already exists — no new commands, no plugins.

## Why seeds don't belong in your migration history

It is tempting to write `insertMany` calls into an ordinary migration. It works — and then it
slowly poisons the history:

- The [changelog](/guide/concepts#the-changelog) is an **append-only audit trail** of your schema's
  history. Reverting never deletes a record, so every dev fixture you insert and remove stays in
  `_migronaut_migrations` forever, interleaved with real schema changes.
- **Fixtures get coupled to schema history.** A fresh production database now has to run (or
  carefully skip) your demo users on its way to the current schema.
- **Environments want different data.** Development wants rich fixtures, staging wants realistic
  demo content, production wants none of it — one linear history cannot serve all three.

The fix is separation, not a new tool: keep seeds in their own directory, recorded in their own
changelog collection. Three config keys make the two profiles fully independent:

| Key | Migrations profile | Seeds profile |
|---|---|---|
| `migrationsDir` | `./migrations` | `./seeds` |
| `migrationsCollection` | `_migronaut_migrations` | `_migronaut_seeds` |
| `lockCollection` | `_migronaut_locks` | `_migronaut_seed_locks` |

## The two configs

Keep your normal `migronaut.config.js` exactly as it is — it stays auto-discovered and drives
every regular command. Add a second file for the seeds profile that reuses it:

```js
// migronaut.config.js — auto-discovered, used by every normal command
export default {
  uri: 'mongodb://localhost:27017',
  dbName: 'my_app',
  migrationsDir: './migrations',
};
```

```js
// migronaut.seeds.config.js — the seeds profile: same database, its own history
import base from './migronaut.config.js';

export default {
  ...base,
  migrationsDir: './seeds',
  migrationsCollection: '_migronaut_seeds',
  lockCollection: '_migronaut_seed_locks',
};
```

Point any command at the seeds profile with `--config`, which overrides auto-discovery:

```bash
migronaut up --config migronaut.seeds.config.js        # apply pending seeds
migronaut status --config migronaut.seeds.config.js    # the seed changelog only
migronaut down --config migronaut.seeds.config.js      # revert the last seed batch
```

### Flags and env vars instead of a second file

A second config file is optional. `--dir` overrides the directory from the command line, and every
scalar option has a [`MIGRONAUT_*` variable](/guide/configuration#environment-variables) — the
collection overrides ride along as env vars, since they have no dedicated flag:

```bash
MIGRONAUT_MIGRATIONS_DIR=./seeds \
MIGRONAUT_COLLECTION=_migronaut_seeds \
MIGRONAUT_LOCK_COLLECTION=_migronaut_seed_locks \
migronaut up
```

::: warning `--dir` alone is not a profile
`migronaut up --dir ./seeds` runs the seed files but records them in `_migronaut_migrations` —
fixtures interleaved with schema history, the exact thing this page exists to avoid. The directory
and the changelog collection always move **together**.
:::

### Programmatic

The same profile works through [`runMigrations()`](/guide/api#runmigrations-config-options) — for
seeding in test setup, or on app startup in development:

```js
import { runMigrations } from '@alexify/migronaut';

await runMigrations({
  uri: process.env.MIGRONAUT_URI,
  dbName: 'my_app',
  migrationsDir: './seeds',
  migrationsCollection: '_migronaut_seeds',
  lockCollection: '_migronaut_seed_locks',
});
```

It carries the usual guarantees: opens its own connection, always disconnects — even when a seed
throws.

## One lock or two?

The [lock](/guide/concepts#safety-mechanisms) is a single document inside whatever collection
`lockCollection` names, so the choice is yours:

- **A separate `lockCollection` (shown above)** gives the seeds profile its own lock: a seed run
  never waits behind a schema migration, and vice versa. This is the right default — the two are
  different concerns, and a `seed` blocked behind a long deploy migration helps nobody.
- **Deliberately share one** — point both profiles at `_migronaut_locks` — and the two kinds of
  run serialize: only one of either runs at a time. Choose this when your seeds write to the same
  collections a migration might be reshaping mid-deploy.

## Writing seed files

Seed files are ordinary [migration files](/guide/writing-migrations): the same `up`/`down`, the
same context, the same optional exports (`description`, [`useTransaction`](/guide/transactions)).
`up` inserts the data; `down` removes exactly that data, so `seed:undo` returns the database to
its unseeded state:

::: code-group

```ts [TypeScript]
// seeds/20260829120000-demo-users.ts
import type { MigrationContext } from '@alexify/migronaut';

export const description = 'Demo user accounts for local development';

const DEMO_EMAILS = ['ada@example.com', 'linus@example.com'];

export async function up({ db }: MigrationContext): Promise<void> {
  for (const email of DEMO_EMAILS) {
    await db.collection('users').updateOne(
      { email },
      { $setOnInsert: { email, name: email.split('@')[0], demo: true } },
      { upsert: true },
    );
  }
}

export async function down({ db }: MigrationContext): Promise<void> {
  await db.collection('users').deleteMany({ email: { $in: DEMO_EMAILS } });
}
```

```js [JavaScript]
// seeds/20260829120000-demo-users.js
export const description = 'Demo user accounts for local development';

const DEMO_EMAILS = ['ada@example.com', 'linus@example.com'];

export async function up({ db }) {
  for (const email of DEMO_EMAILS) {
    await db.collection('users').updateOne(
      { email },
      { $setOnInsert: { email, name: email.split('@')[0], demo: true } },
      { upsert: true },
    );
  }
}

export async function down({ db }) {
  await db.collection('users').deleteMany({ email: { $in: DEMO_EMAILS } });
}
```

:::

Scaffolding respects the profile too — this creates the file (and the `seeds/` directory, if
needed) under the profile's `migrationsDir`:

```bash
migronaut create demo-users --config migronaut.seeds.config.js
```

::: tip Make seed bodies idempotent
Prefer upserts and `$setOnInsert` (as above), or a guard filter, over a bare `insertMany`. A seed
that can run twice harmlessly survives a re-run against a database that already contains the data —
a restored dump, a teammate's copy, an `up --force`.
:::

## Per-environment seeds

The clean pattern is one directory per environment, selected by env var. Migration discovery reads
only the top level of `migrationsDir` — subdirectories are ignored — so each directory is a
self-contained set:

```
seeds/
├── dev/        # rich local fixtures
└── staging/    # realistic demo content
```

```bash
MIGRONAUT_MIGRATIONS_DIR=./seeds/$APP_ENV \
MIGRONAUT_COLLECTION=_migronaut_seeds \
MIGRONAUT_LOCK_COLLECTION=_migronaut_seed_locks \
migronaut up
```

Each database only ever receives its own environment's seeds, so the environments can share the
`_migronaut_seeds` collection *name* without their histories ever meeting.

The `environment` option (or `MIGRONAUT_ENVIRONMENT`) is the audit half of this: it does **not**
select which files run — the directory does that — but it is stamped onto the `environment` field
of every changelog record (falling back to `NODE_ENV`, then `'production'`). Set it explicitly per
invocation and `migronaut status` on `_migronaut_seeds` tells you which environment every seed
batch was applied as.

## package.json scripts

```json
{
  "scripts": {
    "migrate": "migronaut up",
    "migrate:undo": "migronaut down",
    "seed": "migronaut up --config migronaut.seeds.config.js",
    "seed:undo": "migronaut down --config migronaut.seeds.config.js",
    "seed:status": "migronaut status --config migronaut.seeds.config.js"
  }
}
```

With per-environment directories, add `--dir` on top — a CLI flag outranks the config file, so it
cleanly narrows the profile:

```json
{
  "scripts": {
    "seed:dev": "migronaut up --config migronaut.seeds.config.js --dir ./seeds/dev",
    "seed:staging": "migronaut up --config migronaut.seeds.config.js --dir ./seeds/staging"
  }
}
```

## Seeding production

::: warning Reference data only
Fixtures and demo content have no business in production, and a seed profile does not change
that — it just makes the boundary explicit. The one legitimate production seed is **reference
data** the app cannot run without: country codes, currency lists, default roles.
:::

For reference data, both homes are defensible. Keep it in a dedicated seed directory applied to
every environment when it is plain data. But when the data is inseparable from a schema change — a
lookup collection a new feature reads at boot — make it a real migration, because then it *is*
part of schema history. A useful rule of thumb: if running `down` would break the live app, it's a
migration; if it merely empties demo content, it's a seed.
