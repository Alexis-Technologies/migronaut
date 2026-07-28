# Getting Started

## Installation

Install the package and the MongoDB driver (a peer dependency):

::: code-group

```bash [npm]
npm install @alexify/migronaut mongodb
```

```bash [pnpm]
pnpm add @alexify/migronaut mongodb
```

```bash [yarn]
yarn add @alexify/migronaut mongodb
```

:::

The CLI binary is `migronaut`. Run it with your package manager's runner (`npx migronaut …`) or add scripts to
`package.json`.

::: tip Requirements
Node.js **≥ 22.18**, MongoDB **≥ 5.0**. `mongoose` is an optional peer dependency — only needed if
your migrations use Mongoose models.
:::

## 1. Create a config file

`migronaut init` generates a fully-commented config in your project. The default is `migronaut.config.js`:

```bash
npx migronaut init
```

::: code-group

```bash [JavaScript (default)]
npx migronaut init          # → migronaut.config.js
```

```bash [TypeScript]
npx migronaut init --ts     # → migronaut.config.ts
```

```bash [JSON]
npx migronaut init --format json   # → migronaut.config.json
```

:::

A minimal config looks like this:

```js
// migronaut.config.js
export default {
  uri: process.env.MIGRONAUT_URI ?? 'mongodb://localhost:27017',
  dbName: 'my_app',
  migrationsDir: './migrations',
};
```

::: info No config file? No problem.
A config file is **never required** — every option has an `MIGRONAUT_*` environment variable, so env vars
alone are sufficient. See [Configuration](/guide/configuration).
:::

## 2. Create your first migration

```bash
npx migronaut create add-users-email-index
```

This writes a timestamped file into your migrations directory, e.g.
`migrations/20260605120000-add-users-email-index.js`, with `up` and `down` stubs:

::: code-group

```ts [TypeScript]
import type { MigrationContext } from '@alexify/migronaut';

export const description = 'Add unique index on users.email';

export async function up({ db }: MigrationContext): Promise<void> {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down({ db }: MigrationContext): Promise<void> {
  await db.collection('users').dropIndex('email_1');
}
```

```js [JavaScript]
export async function up({ db }) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down({ db }) {
  await db.collection('users').dropIndex('email_1');
}
```

:::

## 3. Run it

```bash
npx migronaut up
```

```
✔ Applied  20260605120000-add-users-email-index.js   [42ms]
```

## 4. Inspect and roll back

```bash
npx migronaut status          # full status table
npx migronaut dry-run up      # preview what would run, touches nothing
npx migronaut down            # roll back the last batch
```

## Recommended package.json scripts

```json
{
  "scripts": {
    "migrate": "migronaut up",
    "migrate:down": "migronaut down",
    "migrate:status": "migronaut status",
    "migrate:create": "migronaut create"
  }
}
```

## Next steps

- [Configuration](/guide/configuration) — every option, env var, and precedence rules.
- [Writing Migrations](/guide/writing-migrations) — the full file contract.
- [Commands](/commands/up) — the complete CLI reference.
