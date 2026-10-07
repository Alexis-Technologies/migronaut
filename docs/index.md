---
layout: home

title: migronaut
titleTemplate: Elegant MongoDB migrations for Node.js

hero:
  name: migronaut
  text: Elegant MongoDB migrations for Node.js
  tagline: Precise, safe migrations for MongoDB, with zero runtime dependencies. Run a single file, roll back anything, and preview every change before it touches your database.
  image:
    src: /logo-mark.svg
    alt: migronaut
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why migronaut?
      link: /guide/why
    - theme: alt
      text: View on GitHub
      link: https://github.com/Alexis-Technologies/migronaut

features:
  - icon: 📭
    title: Zero dependencies
    details: "No runtime dependencies — only the mongodb driver as a peer. Your logger, BullMQ and OpenTelemetry are injected by you, never installed by migronaut."
    link: /guide/vs-mongo-migrate-kit
    linkText: How it got there
  - icon: 🎯
    title: Precise runs, real rollbacks
    details: "Apply one file, migrate --to a point, or everything pending. Roll back a batch, the last N, one file, or redo — history is never deleted."
    link: /commands/down
    linkText: migronaut down
  - icon: 🔒
    title: Safe by default
    details: "An atomic MongoDB lock with a heartbeat stops two deploys racing; checksums catch edited migrations, and a file merged late is flagged."
    link: /guide/how-it-works#the-lock
    linkText: How the lock works
  - icon: 👀
    title: Preview everything
    details: "dry-run shows what up or down would run, converge --dry-run what would change, and a background dry run rewrites a sample in an aborted transaction."
    link: /commands/dry-run
    linkText: migronaut dry-run
  - icon: 🧭
    title: Declared collections
    details: "Declare indexes and validators as an end state. converge applies the difference, refuses a conflict before any write, and never drops what you did not declare."
    link: /guide/collections
    linkText: Declared collections
  - icon: 🔎
    title: Atlas Search & Vector Search
    details: "Atlas Search and Vector Search indexes in the same declarations — updated in place, never dropped and rebuilt, and waited for without holding the lock."
    link: /guide/collections#search-indexes
    linkText: Search indexes
  - icon: 🧬
    title: Document versioning
    details: "A shape version and an optimistic-concurrency revision on every document — enforced by a validator, typed per version, written by your repository's helpers."
    link: /guide/versioning
    linkText: Document versioning
  - icon: 🌊
    title: Background migrations
    details: "Rewrite huge collections beside the deploy: parallel lanes in any process, a checkpoint per batch, throttling, pause and resume, and a drift watch."
    link: /guide/background-migrations
    linkText: Background migrations
  - icon: 📬
    title: Migrations as a queue
    details: "Optional BullMQ adapter — one migration per job, in an order MongoDB enforces, with schedules, enqueue-and-wait, and a queue for background migrations."
    link: /guide/bullmq
    linkText: Migrations as a queue
  - icon: 🔭
    title: OpenTelemetry
    details: "Hand it your tracer and meter: a span per run and per migration, the driver's spans nested inside, and metrics for durations, locks and background work."
    link: /guide/opentelemetry
    linkText: OpenTelemetry
  - icon: 📝
    title: Migration logs
    details: "ctx.logger binds the run, migration, attempt and queue job to every line — and lines marked userland become events your app can store and show its users."
    link: /guide/migration-logs
    linkText: Migration logs
  - icon: 📦
    title: Bring your history
    details: "migronaut import adopts a migrate-mongo changelog as-is; baseline marks an existing database's migrations applied — no re-running, no rewriting files."
    link: /guide/migrate-mongo
    linkText: Migrate from migrate-mongo
---

<div class="home-section">

## How it fits together

One engine runs everything — from a terminal, inside your application at startup, or as a queue
worker — and keeps all of its state in MongoDB, next to your data. It changes a database in three
ways, each with its own guarantees.

```mermaid
flowchart TB
  accTitle: How migronaut fits together
  subgraph RUN ["Run it from"]
    direction TB
    CLI(["the migronaut CLI"]):::ext
    API(["your app at startup<br/>runMigrations()"]):::ext
    Q(["a BullMQ worker<br/>a migration service"]):::ext
  end
  KIT["MigratorKit — one engine<br/>events · logs · OpenTelemetry"]:::core
  subgraph WAYS ["Three ways to change a database"]
    direction TB
    M["migrations<br/>ordered · locked · reversible"]
    C["declared collections<br/>indexes · search · validators"]
    B["background migrations<br/>huge rewrites, beside the line"]
  end
  DB[("MongoDB<br/>your data + all of the state")]:::store
  APP(["your repository layer<br/>@alexify/migronaut/versioning"]):::ext
  RUN --> KIT --> WAYS --> DB
  DB ~~~ APP
  APP -- "__v · __rev" --> DB
```

[How it works, step by step →](/guide/how-it-works)
{.home-section-link}

## Also in the box

- [Opt-in transactions](/guide/transactions) — a migration and its changelog record commit together
- [Lifecycle hooks & events](/guide/hooks) — `beforeAll` … `onError`, and `kit.on(…)` for metrics
- [TypeScript, ESM & CommonJS](/guide/writing-migrations) — `.ts` natively on Node 22.18+
- [Mongoose](/guide/mongoose) — inject your instance, use your models in migrations
- [Seeding](/guide/seeding) — seeds with a history of their own, per environment
- [CI gates & JSON output](/guide/ci-cd) — `status --check`, `converge --check`, `--json`
- [`migronaut audit`](/commands/audit) — a read-only health check of the whole setup
- [Your own id format](/guide/configuration#custom-id-format) — ULID, CUID, UUIDv7 for every id it mints
- [Secrets at runtime](/guide/configuration#async-factory-config-secret-managers) — an async config factory

</div>
