# Changelog

All notable changes to this project will be documented in this file.
Release headings carry the publish date (`## vX.Y.Z — YYYY-MM-DD`).

## v2.2.0 — 2026-10-05

Atlas Search and Vector Search indexes in declared collections. Additive: a definition without
`searchIndexes` behaves exactly as in 2.1 — converge never even asks the server about Search for
it.

### Added

- **Declared search indexes** — a collection definition takes `searchIndexes: [{ name?, type?,
  definition }]`: Atlas Search (`type: 'search'`, the default) and Atlas Vector Search
  (`'vectorSearch'`) indexes, with the definition exactly as Atlas documents it — automated
  embedding (`autoEmbed`) fields included. `converge` keeps them in step with the same lock,
  history, events, re-plan and fixed-point check as regular indexes. Experimental.
  - **Rows**: a new target, `searchIndex`. A missing index is created (one `createSearchIndexes`
    per collection), a changed definition is updated **in place** (`modify` — the old definition
    serves until the new one is built), an undeclared one is kept, or dropped last under
    `prune`. A definition that declares only `searchIndexes` is valid, and its collection is
    created when missing.
  - **Never a rebuild**: a `$search` against a missing index returns nothing rather than fail, so
    converge never drops a search index to build it again. A change no update can make — the
    type, or an `autoEmbed` field's path, model, `numDimensions`, quantization or modality — is a
    `conflict` naming the new-name recipe, and so is a declared index the server is still
    deleting.
  - **Comparison**: definitions compare whole, key order ignored, with the defaults the server
    writes into what it reports filled in on both sides — top-level (`analyzer`,
    `searchAnalyzer`, `dynamic`, `storedSource`, `numPartitions`), per field mapping (`string`,
    `number`, `autocomplete`, `token`, `geo`, `document`, nested fields and `multi` included) and
    per vector field (`quantization`, `indexingMethod`, `hnswOptions`; `autoEmbed`
    `numDimensions` and `quantization`). Vector `fields`, and a field indexed as several types,
    compare as sets. A server that reports no `type` (a self-managed `mongot`) has it inferred
    from the definition, and its `latestVersion` is read as the definition version.
  - **Server-only options**: an option the server reports that the declaration does not set,
    and whose default migronaut does not know (a newer `mongot`'s), is left out of the
    comparison — named on the row (`ignored`) and in one warning — instead of making every
    converge update, and the server rebuild, the index. Only option objects are trimmed: a
    field, a mapping type or a vector field only the server has is still a difference. The
    cost: removing such an option from a declaration goes unnoticed; declare the value wanted.
  - **What differs**: a `modify` row names it down to the option
    (`mappings.fields.title.norms`) — the first five paths and how many more. A search index
    that still differs after an update is `unstable`, with a warning that every update builds it
    again.
  - **Raw commands** (`createSearchIndexes`, `updateSearchIndex`, `dropSearchIndex`,
    `$listSearchIndexes`), so every driver in the peer range works — the driver's helpers start
    at 5.6. A vector index update is retried once with its type when a self-managed `mongot`
    asks for it; where the server refuses that too (an Atlas CLI local deployment on 8.0 and
    8.3), the step fails with the new-name recipe as its hint.
  - **Build state**: rows carry `build` (`{ status, queryable, message?, updating? }`), and the
    result `search` (`{ available, evidence, notReady, wait? }`) — how Search availability was
    told, the declared indexes still building, updating, stale or failed, and how a wait ended.
    A build under way does not count against `inSync`; a FAILED one fails `converge --check`
    (exit 28). A STALE index (queryable, no longer replicating) is reported as such — table,
    closing warning, `audit` — not as still building. A build message is kept to 500 characters.
- **`waitForSearchIndexes`** (config, `MIGRONAUT_WAIT_FOR_SEARCH_INDEXES`, `converge({
  waitForSearchIndexes })`, `converge --wait-search` / `--no-wait-search`) — hold the converge
  until every declared search index serves its declaration; a FAILED build of an index the run
  created or changed, or `searchIndexWaitTimeoutMs` (`MIGRONAUT_SEARCH_INDEX_WAIT_TIMEOUT_MS`,
  default 10 minutes), fails it with `ConvergeFailedError` `phase: 'wait'`. Off by default.
  - **Without the lock**: the wait only reads, so the migration lock is released when it starts
    (`lock:released` with `early: true`) — the next deploy or a queue's next job need not wait
    out a build. The run itself (its id, span, history entry, `converge:end`) ends with the
    wait.
  - **Only what the run started holds it**: an index that failed or went STALE before the run,
    its definition unchanged, is named and warned about instead — converge cannot fix it, and a
    deploy is not held up by it. `--check` still fails on a FAILED build.
  - **Resilient**: a list that fails with a network or failover blip is read again at the next
    poll, up to three in a row (then `reason: 'unreadable'`); a stop cuts the pause between polls
    short.
  - **Observable**: `converge:wait` events (`started`, `progress` every 30 s, then `ready`,
    `failed`, `timeout`, `unreadable` or `aborted`), `result.search.wait`, the history entry, a
    queue job's log lines and `search-wait` progress phase, and — with `telemetry` — the
    histogram `migronaut.converge.search.wait.duration` by `migronaut.converge.search.wait.outcome`.
- **`onSearchUnavailable`** (`MIGRONAUT_ON_SEARCH_UNAVAILABLE`) — declared search indexes on a
  server without Atlas Search: `'fail'` (default) refuses the run before any write, with a hint;
  `'skip'` converges everything else and reports `skip` rows. Detected once per run from the
  server's own answer (checked against MongoDB 5.0, 6.0, 7.0, 8.0 and 8.2).
- **`migronaut audit`** — a `search` check, when the definitions declare search indexes: whether
  the server has Atlas Search, and whether a declared index failed to build.
- **Types** — `SearchIndexDefinition`, `SearchDefinition`, `VectorSearchDefinition`,
  `VectorSearchField`, `SearchIndexType`, `SearchIndexStatus`, `SearchIndexBuild`,
  `SearchIndexNotReady`, `ConvergeSearchSummary`, `ConvergeWaitOutcome`, `ConvergeWaitEvent`;
  `ConvergeTarget` gains `'searchIndex'`, `ConvergeActionKind` `'skip'`, `ConvergeAction`
  `ignored`, `ConvergeHistoryEntry` `search`, `LockEvent` `early`, the event map
  `'converge:wait'`; in `bullmq.d.ts` `ConvergeJobResult.search`, and `MigrationJobProgress`
  gains the `'search-wait'` phase and `searchIndexes`. An exhaustive `switch` over one of these
  unions needs a branch for the new member.
- **Queue** — a converge job's result carries `search`, and its log lines name search indexes.
  Whether a job waits for builds is the worker kit's `waitForSearchIndexes`; the job payload is
  unchanged.

### Changed

- A definition with none of `indexes`, `searchIndexes` and `validator` is refused with "declares
  no indexes, searchIndexes or validator — nothing to manage" (was "declares neither indexes nor
  a validator").
- The converge table's drop/rebuild count includes dropped search indexes, and `converge --yes`
  is required for them in `--json` mode, like an index drop.
- `ConvergeFailedError`'s documentation names every phase: `plan`, `replan` (already thrown by
  2.1, undocumented), `apply` and the new `wait`. A search index list that cannot be read is
  reported in the phase that read it — `plan` only before the first write — and a run that stops
  for any reason settles every row and carries the result so far in `context.converge`.
- `runWithLock` (internal) hands the work a `control` whose `release()` gives the lock up early;
  `lock:released` may now come before `run:end`, with `early: true`.

### Tooling

- `tests/integration/search-atlas.test.js` — an opt-in, manual suite against
  `mongodb/mongodb-atlas-local` (`MIGRONAUT_TEST_ATLAS_URI`): every scenario ends at a fixed
  point. Passes against `mongodb/mongodb-atlas-local` 8.0 (8.0.32) and `latest` (8.3.11). CI does
  not run it; the coverage gate comes from the unit tier's fake, which answers the search
  commands with lag, normalization and build progress on demand. The suite stays strict about
  server-only options (production tolerates them): one there is a default the tables in
  `search-index-spec.js` lack. 9/9 on 8.0.32 and 8.3.11, the lock released during the wait
  included.
- `src/core/converge.js` is split: `converge-search-run.js` (the search half of a run) and
  `server-info.js` (read options, read pace, server version, not-found codes).

## v2.1.0 — 2026-10-04

Migrations as a queue, ids in your own format, OpenTelemetry, and declared collections. Additive:
nothing changes for anyone who uses none of them, with the narrow exceptions listed under
**Changed**.

### Added

- **`@alexify/migronaut/bullmq`** — a new entry point that runs migrations as
  [BullMQ](https://docs.bullmq.io/) jobs, **one migration per job**, so migronaut can be a
  migration service: enqueue from an HTTP handler, a schedule or a deploy hook, and let a worker
  apply them in order.
  - `createMigrationQueue(options)` — the facade: `enqueueUp` / `enqueueDown` (returning a group
    handle with `wait()`), `startWorker`, `status` / `pending` / `audit` / `lockInfo`, `getJob`,
    `pause` / `resume`, `schedule` / `unschedule`, `close`.
  - `createMigrationProcessor(options)` — the processor on its own, for a Worker you construct
    (NestJS, BullMQ Pro), plus `enqueueUp` / `enqueueDown` / `planUpJobs` / `planDownJobs` /
    `waitForGroup` for a Queue you own.
  - **BullMQ is injected, never depended on** — `bullmq: { Queue, Worker, QueueEvents }` from
    your own install. The package still has no `dependencies` and gains no peer; `src/` never
    imports `bullmq` (a test enforces it).
  - **Order comes from MongoDB, not from Redis.** Every job is a single-file run under the usual
    lock; it refuses while an earlier migration is still pending, so a failed migration stops the
    line (`MIGRATION_BLOCKED` for the jobs behind it). Jobs get one attempt on purpose — a BullMQ
    retry re-queues behind the waiting jobs — and a held lock is waited out inside the job.
  - **One batch per enqueue**, so `down` still rolls back a whole deploy; duplicate enqueues are
    deduplicated, and a job whose migration is already applied completes as `skipped`.
  - Job payloads are validated as untrusted input; messages, stacks and job logs are redacted. A
    queue job's target must be a file of the migration sequence — a payload can never make the
    worker import a dotfile, a declaration file or a helper module next to the migrations.
  - **Shutdown puts unstarted work back.** A job that a closing worker stops before its migration
    starts (waiting for the lock, or fetched during shutdown) is moved back to the head of the
    queue instead of failing — so a rolling deploy no longer fails the rest of the enqueue it
    interrupts as `MIGRATION_BLOCKED`. A migration already running always finishes.
  - **A versioned, strict job contract.** A worker accepts every job data version from
    `MIN_JOB_DATA_VERSION` (exported) up to its own and refuses newer ones and unknown fields
    rather than ignoring what they mean — roll workers out before producers. Jobs always state
    `ordered`, and may carry the plan-time `checksum` of their file.
  - **Scheduler ticks are bounded**: they carry the queue's `jobOptions`, and keep the last 100
    completed / 500 failed jobs when those set no retention.
  - **Correlation**: a job's `runId` is on its progress (`completed` and `failed`), its failure log
    row and its error's `context` (with `jobId` and `groupId`) — a failed job has no return value;
    the worker's failure log line names the group, migration and run.
  - An injected `Queue` (or `QueueEvents`) on another name or prefix than the facade's is rejected,
    and the facade takes an injected queue's prefix by default; `startWorker()` can be retried
    after a failed start; a closed queue refuses every further call.
  - **A worker decides what a job may ask for** — the `allow` option (`{ down: true, force:
    false, unordered: false }` by default) on `createMigrationProcessor` and
    `createMigrationQueue`: a payload asking to re-run an applied migration or to skip the order
    guard is refused (`QUEUE_JOB_INVALID`, `context.permission`) unless allowed. The facade's
    `enqueue*` calls follow the same policy.
  - **A job runs only the file it was planned with**: an `up` job carries the plan-time checksum,
    and a worker with another version of the file fails it (`CHECKSUM_MISMATCH`,
    `context.planned`) instead of applying it.
  - **Several workers without global concurrency**: a job blocked only by earlier migrations that
    have not failed (one may be in flight on another worker) waits for them within its lock-wait
    budget instead of failing its group; `MigrationBlockedError` carries `context.failed`.
  - `wait()` holds every await to its one `timeoutMs` budget, decides a timeout by the clock, and
    its `QueueJobFailedError` carries the job's own typed `code`; an empty group can be waited for
    without QueueEvents. A long lock wait reports progress every few seconds, not every poll.
  - What the queue stores about a failure — `failedReason`, stack, job logs — masks the values a
    duplicate-key error quotes, on top of credentials. `schedule({ every })` needs at least 1000 ms.
  - Dedup ids encode file names reversibly (two names can no longer share one and absorb each
    other's job), and a forced re-run has a dedup id of its own.
  - **A schedule holds a failed migration**: a `sync` tick whose next migration failed, with its
    file unchanged since, enqueues nothing (`returnvalue.held`, and a warning) instead of re-running
    it every tick; a changed file or an explicit `enqueueUp(name)` resumes it.
  - Jobs carry `requestedBy` / `reason` (`enqueueUp` / `enqueueDown` / `enqueueConverge` options).
- **`bullmq.d.ts`** — hand-written types for the entry point, with structural `BullMQ*Like`
  interfaces instead of an import of `bullmq`, generic over the classes you inject.
- **`up(file, { batch })`** — stamp an explicit batch number instead of the next free one, and
  **`MigratorKit.nextBatch()`** to peek at it: together they let several single-file runs form one
  batch.
- **`up(file, { ordered: true })` / `down(file, { ordered: true })`** — refuse a single-file run
  that would go out of sequence (`MigrationBlockedError`); an ordered `up` also applies the
  `strict` drift check and the `onOutOfOrder` policy a bulk run would, and only targets a file of
  the migration sequence.
- **`up(file, { checksum })`** — refuse (`CHECKSUM_MISMATCH`, `context.planned`) to apply any other
  version of the file than the one with this SHA-256; `dryRun('up')` rows carry each file's
  `checksum` for it.
- **`list(filter, { checksums: false })`** / **`status({ checksums: false })`** — skip hashing the
  applied files, for a caller that needs names and dates only.
- **Who asked, and why** — `up`, `down`, `redo` and `converge` take `requestedBy` (≤ 128
  characters) and `reason` (≤ 512), and `migronaut up` / `down` / `redo` / `converge` take
  `--reason`. They are stamped on the changelog (`requestedBy` / `reason` on an apply,
  `revertRequestedBy` / `revertReason` on a revert; a later apply that says nothing clears the old
  ones) and on the converge history; `status()` rows show them. `executedBy` stays the OS user —
  on a queue worker, the container's — which is why the requester has fields of its own. A failed
  attempt's trace now also records the checksum of the file version that failed
  (`StatusRow.failedChecksum`).
- **`runMigrations(config, { signal })`** — an `AbortSignal` (wired to SIGTERM) stops a wait for
  the lock between polls, and a run that holds it between migrations.
- **`LockInfo.runId` and `LockInfo.ttlMs`** — which run holds the lock (also on `migronaut lock`),
  and the holder's TTL, which the lock document now records.
- **Three error codes**: `MIGRATION_BLOCKED` (exit 24), `QUEUE_JOB_INVALID` (25),
  `QUEUE_JOB_FAILED` (26), with `MigrationBlockedError`, `QueueJobInvalidError` and
  `QueueJobFailedError` exported from the package root.
- **Runnable example** — `examples/migration-service`: a queue, a worker and a plain `node:http`
  API (not published to npm).
- **`generateId` config option** — your own identifier format (ULID, CUID, nanoid, UUIDv7, …)
  everywhere migronaut used to call `crypto.randomUUID()`: the `runId` of every run — on changelog
  records, events, log lines and the lock's owner token — and the `groupId` of every queue
  enqueue. One option covers the kit, the CLI (through `migronaut.config.js`/`.ts`),
  `runMigrations` and the queue adapter.
  - **Injected, like the logger** — migronaut ships no generator but the default. It is called
    with no arguments, so third-party functions pass straight through: `generateId: ulid`.
  - **Checked on every call** — it must synchronously return a non-empty string of at most 128
    characters. A throw, a promise or anything else fails the run with `CONFIG_INVALID` before a
    migration starts (and an enqueue before a job is added).
  - Code-only: no environment variable and no place in a JSON config, like `logger` and `hooks`.
- **`MigratorKit.generateId()`** — a new id in the kit's configured format, for code that wants its
  own ids to match (it is how the queue adapter mints group ids). Resolves the config; does not
  connect.
- **`IdGenerator` type** — `() => string`, exported from the package root.
- **`telemetry` config option** — OpenTelemetry traces and metrics through a tracer and/or a meter
  from your own `@opentelemetry/api`: `telemetry: { tracer, meter }`. One option covers the kit,
  the CLI (through `migronaut.config.js`/`.ts`), `runMigrations` and the queue adapter.
  - **Spans**: `migronaut.run` for every run that acquired the lock, and a child
    `migronaut.migration` for every migration executed. The migration's span is the *active* one
    while its hooks, its `up`/`down` and its changelog write run — so an instrumented MongoDB
    driver nests its command spans under the migration that issued them. That is what lifecycle
    events cannot do, and why this lives in the kit: at application startup there is no ambient
    span, and the driver instrumentation records nothing without a parent.
  - **Metrics**: `migronaut.run.duration`, `migronaut.migration.duration`,
    `migronaut.lock.acquire.duration` and `migronaut.lock.wait.duration` (one point per wait for a
    held lock, by `migronaut.lock.wait.outcome`: `acquired`, `timeout`, `aborted`) — histograms,
    in seconds, with boundaries from 10ms to an hour — and the counters `migronaut.lock.refused`
    and `migronaut.lock.lost`.
  - **Dimensions**: every span and metric point carries `db.namespace` (the database name), plus
    the caller's own static attributes from `telemetry.attributes` (at most 20 scalars).
  - **Failures** set the span's status to `ERROR` with a redacted message (credentials and the
    values a duplicate-key error quotes masked, at most 1 KB), and `error.type` — on
    the span and on the metric point — to the typed error code. No exception event is recorded: it
    would carry the unredacted message and stack.
  - **A run that never got the lock emits no span.** A caller polling for a busy lock retries the
    whole run every few hundred milliseconds; the refusals are counted
    (`migronaut.lock.refused`) instead.
  - **Injected, like the logger** — `@opentelemetry/api` is neither a dependency nor a peer, and
    `src/` never imports it (a test enforces it). The types are structural: `MigronautTracer`,
    `MigronautSpan`, `MigronautMeter`, `MigronautHistogram`, `MigronautCounter`,
    `MigronautMetricOptions`, `MigronautAttributes` and `MigronautTelemetry`, exported from the
    package root.
  - **It can never fail a run.** Every call into the tracer, a span, the meter and an instrument
    is guarded — a promise one of them returns included, so a rejecting SDK cannot surface as an
    unhandled rejection — and a tracer that throws before or after running the work, or runs it
    twice, still gets each migration executed exactly once.
  - Code-only, like `logger` and `generateId`. The span, attribute and metric names are new and
    should be treated as experimental.
- **`bullmq.telemetry`** — `createMigrationQueue({ bullmq: { Queue, Worker, telemetry } })` hands
  BullMQ's own telemetry object (`new BullMQOtel({ tracerName })` from `bullmq-otel`) to the Queue
  and the Worker it constructs. Together with the kit's `telemetry` it gives one trace from the
  request that enqueued, across Redis, to the MongoDB commands in the worker. Until now the facade
  built its Queue without it, so the enqueuing side of that trace could not be joined.
  `workerOptions.telemetry` and `startWorker({ telemetry })` override it for the worker alone.
- **OpenTelemetry in the example** — `examples/migration-service` gains `tracing.js` and a Jaeger
  in its `docker-compose.yml`: set `OTEL_EXPORTER_OTLP_ENDPOINT` and every enqueue is one trace.
- **Declared collections** — indexes and validators declared as an end state, and applied by
  `migronaut converge`, with no migration file per change. For what only ever has a current value
  (which indexes a collection has, which validator guards it); migrations stay the tool for
  changes with an order and a history.
  - **`collections` config option** — an array of definitions, `{ name, indexes?, validator?,
    validationLevel?, validationAction?, prune? }`, each index in the driver's own flat
    `createIndexes` shape. Works in `migronaut.config.{ts,js,json}` (and the JSON Schema) and in
    `new MigratorKit({ collections })`.
  - **`collectionsDir` config option** (`MIGRONAUT_COLLECTIONS_DIR`) — one definition file per
    collection (`.ts`/`.js` default export, or `.json`; the name defaults to the file name).
    Opt-in, combined with `collections`, and loaded only when a converge runs — a broken file never
    blocks `status` or an emergency `down`. A collection declared twice is `CONFIG_INVALID`.
  - **Validated strictly**: an unknown definition key or index option is an error with its path
    (`collections[2].indexes[0].uniqe`) — the driver silently drops an option it does not know, so
    a typo would otherwise build the wrong index and then look in sync forever.
  - **`MigratorKit.converge({ dryRun?, prune?, noLock?, ordered? })`** and **`migronaut converge`**
    (`--dry-run`, `--check`, `--prune`, `--yes`). Stateless: every run reads `listCollections` and
    `listIndexes`, plans, and carries the plan out one step at a time under the migration lock —
    create the collection, set the validator, create indexes, `collMod` a TTL or `hidden` in place,
    rebuild what changed otherwise, drop last. Nothing is recorded.
  - **Safe by default.** An index you did not declare is kept and reported (`keep`), and dropped
    only with `prune` (per definition, or for the definitions that do not decide). An identical
    index under another name is accepted as is rather than rebuilt; a different one covering the
    same key is a conflict that refuses the run before the first write. A rebuild whose new index
    fails to build puts the old one back — and says so, with the reason, when it cannot.
  - **A unique index is never rebuilt unasked.** Dropping it opens a window with no constraint,
    and a duplicate written in that window leaves neither index buildable. Such a rebuild is a
    `conflict` unless `converge({ rebuildUnique: true })` / `--rebuild-unique`; a converge after
    `up` and a queue job never pass it.
  - **Comparisons follow what the server stores** — text indexes in their `_fts` form, collations
    field by field against the expanded spec (`strength`, `caseLevel` and `numericOrdering` at
    their universal defaults when left out), the collection's default collation,
    `{ locale: 'simple' }`, a flag stored as `1`. A compound `Map` key may hold an integer-like
    field only first — the driver reads keys back as plain objects.
    Anything applied that still compares as changed is reported under `unstable` instead of being
    rebuilt on every run.
  - **The CLI plans first** and asks before any drop or rebuild, and before changing the validator
    of a collection that holds data; `--json` refuses such a plan without `--yes` (and applies a
    purely additive one); a plan with a conflict is refused without asking. `--check` exits `28` on
    drift — a CI gate; `--ordered` refuses while a migration is pending.
  - **Results say what changed**: every row that changes, drops or keeps something carries
    `from` and `to` — the live and the declared index or validator, as plain JSON.
  - **History** — every converge that changes something or fails appends an entry to
    `_migronaut_converge` (`convergeLogCollection`, `MIGRONAUT_CONVERGE_LOG_COLLECTION`): when,
    the trigger, the run id, who ran it and where, who asked and why, and every row it touched
    with its `from` / `to`. Read it with `MigratorKit.convergeHistory({ limit })` or
    `migronaut converge --history [--limit n] [--json]`. Best-effort, and a database that never
    converges never gets the collection.
  - **In place where the server can**: making an index unique (MongoDB 7.0+, `collMod`
    `prepareUnique` then `unique` — duplicates leave the index as it was) and adding a TTL to a
    single-field index (5.1+) are `modify`, not a rebuild. (6.0 accepts the unique conversion but
    did not enforce it in our tests, so it rebuilds.)
  - **Sharded clusters**: behind a `mongos`, prune never drops the index backing a shard key (read
    from `config.collections`, or kept with a warning when the server refuses the drop).
  - **Re-planned before each collection**: every collection after the first is read and planned
    again right before its turn; one that changed meanwhile into a conflict or a new drop/rebuild
    stops the run (`ConvergeFailedError`, `phase: 'replan'`) before it is touched.
  - **Regular expressions** in a validator or partial filter must use flags the driver stores as
    written (`i`, `m`; a `BSONRegExp` for server options) — `g` would become dotAll and `s`, `u`,
    `y` vanish — and compare in their stored form. A `__proto__` key in a JSON definition stays a
    key.
  - **At scale**: all declared collections are read with one `listCollections` and a bounded
    fan-out of `listIndexes`; the new indexes of a collection are built by one `createIndexes`
    (one pass over the data); a connection that fails mid-rebuild is reported, never "repaired"
    by restoring the old index next to a build the server may still be running.
  - **`convergeAfterUp` config option** (`MIGRONAUT_CONVERGE_AFTER_UP`) — a bulk `up` (no file, no
    `to`; also `runMigrations`) ends by converging under the same lock, even when nothing was
    pending, so a failed converge is retried by the next deploy. `up(undefined, { converge })` and
    `migronaut up --converge` / `--no-converge` decide per run. `up` still returns its migration
    rows; `runMigrations` adds `summary.converge`.
  - **`MigratorKit.convergesAfterUp()`** — whether a bulk `up` on the kit ends by converging.
  - **Events**: `converge:start`, `converge:action` (per step: `'started'` before it runs — an index
    build can take hours — then `'applied'` or `'failed'`) and `converge:end` (with the full
    result), for real runs. An index build also logs which index it is starting on. The run itself is an ordinary `run:start`/`run:end` with
    `command: 'converge'`, and an ordinary `migronaut.run` span.
  - **Types**: `CollectionDefinition`, `CollectionDefinitionFile`, `IndexDefinition`,
    `IndexKeyDirection`, `IndexCollation`, `ValidationLevel`, `ValidationAction`, `ConvergeOptions`,
    `ConvergeResult`, `CollectionConvergeResult`, `ConvergeAction`, `ConvergeActionKind`,
    `ConvergeActionStatus`, `ConvergeTarget`, `ConvergeUnstable`, `ConvergeTrigger` and the three
    event payloads, exported from the package root.
  - The definition shape, the result shape and the queue contract below are new and should be
    treated as experimental.
- **Converge jobs in the queue adapter** — `JOB_NAMES.CONVERGE` (`'converge'`), `enqueueConverge()`
  and `MigrationQueue.enqueueConverge()`, and `schedule({ job: 'converge' })` with its own default
  id, `DEFAULT_CONVERGE_SCHEDULER_ID` (`'migronaut-converge'`). With `convergeAfterUp`,
  `enqueueUp` ends a group that reaches the newest migration with a converge job (or adds a
  converge-only job when nothing is pending but a dry run finds drift), and an idle `sync` tick does
  the same. A converge job refuses as `MIGRATION_BLOCKED` while a migration is pending, is keyed for
  deduplication on the migration it follows, and carries no `prune` — what may be dropped comes
  from the worker's own definitions. New types: `ConvergeJobData`, `ConvergeJobResult`,
  `ConvergeJobSpec`, `ConvergeHandle`, `EnqueueConvergeOptions`.
- **Two exit codes**: `CONVERGE_FAILED` (27, with `ConvergeFailedError` exported from the package
  root) and the CLI-only `COLLECTIONS_DRIFT` (28, from `converge --check`).

### Changed

- **`MigronautErrorCode` gained four members** (above). TypeScript consumers with an exhaustive
  `switch` over the code union need a `default` branch or the new cases.
- **`collections`, `collectionsDir` and `convergeAfterUp` config keys are now validated**
  (`CONFIG_INVALID`). They were previously unknown and ignored, like any stray key.
- **The CLI arg parser makes a `--x` / `--no-x` pair tri-state**, as commander does: when a command
  declares both, neither given leaves the option unset instead of defaulting to `true`. Only
  `up --converge` / `--no-converge` uses this.
- **`dryRun('up')` now applies the out-of-order policy** of the run it previews: under
  `onOutOfOrder: 'error'` a bulk preview refuses with `MIGRATION_OUT_OF_ORDER` instead of listing
  rows the run would reject; under `'warn'` it logs the warning. A single-file preview is exempt,
  as the single-file run is.
- **`connect()` is safe to call concurrently** — overlapping first calls on one `MigratorKit`
  share a single connection instead of each opening (and all but one leaking) a client. Matters
  for a long-lived kit serving several callers.
- The lock-wait loop of `runMigrations` moved to `src/core/lock-wait.js`, shared with the queue
  processor. Two changes to how it waits: **polls back off**, doubling from `lockPollIntervalMs`
  up to 5 s (and at most a quarter of the budget), so a fleet waiting out a long deploy no longer
  hammers the lock document; and **the default `lockWaitTimeoutMs` follows the holder's TTL** —
  `max(90 s, 1.5 × lockTTLSeconds)` — so a holder with a long TTL, whose heartbeat moves the lock
  only every TTL/2, is no longer mistaken for a stalled one. An explicit `lockWaitTimeoutMs` is
  used as given (with a warning when it is shorter than the holder's heartbeat). `waitedMs` is
  now measured by the clock from the first refusal, and a wait that times out rethrows the
  refusal with `context.timedOut`, `attempts` and `waitedMs`.
- **`runMigrations` validates `onLockHeld`** (`CONFIG_INVALID`): a value other than `'throw'` or
  `'wait'` — `'Wait'`, say — used to behave as `'throw'` without a word. A poll interval above the
  largest timer (2³¹−1 ms, which Node fires after 1 ms) is refused too.
- **The lock document gained a `nonce` field**, minted by migronaut on every acquire and matched
  alongside `owner` when the lock is confirmed, renewed and released. The owner token is the run
  id, whose format `generateId` now decides; the nonce keeps mutual exclusion independent of it,
  so a generator that repeats an id can blur correlation but never let two runs hold the lock.
  Older releases ignore the field and can share a database with this one. The nonce is never
  exposed; the owner — the holder's run id — now is, as `LockInfo.runId` (`lock`, `lockInfo()`,
  `LockAlreadyHeldError` context), next to the holder's `ttlMs`, also written since this release:
  "which run holds the lock?" is the first question about a stuck one, and the nonce, not the
  owner, is what proves ownership.
- **A `generateId` config key that is not a function is now rejected** (`CONFIG_INVALID`). The key
  was previously unknown and ignored, like any stray key.
- **A `telemetry` config key that is not usable is now rejected** (`CONFIG_INVALID`): it must be an
  object whose `tracer` has `startActiveSpan` and whose `meter` has `createHistogram` and
  `createCounter`. Absent, `null` and `{}` all mean "off". The key was previously unknown and
  ignored.
- **A scheduled `sync` job no longer joins the trace that registered its schedule.** Its template
  now carries `telemetry: { omitContext: true }`: BullMQ builds each scheduler iteration from the
  previous job's options, so with telemetry on, every tick would otherwise have been appended to
  one ever-growing trace. Each tick is a trace of its own; no effect on a queue without telemetry.

### Fixed

- `docs/reference/cli.md` lists exit code `23` (`MIGRATION_OUT_OF_ORDER`), missing since v2.0.0.
- The events table in `docs/guide/hooks.md` had fallen behind the payloads: it now lists
  `migration:skipped`, the `command` / `durationMs` / count fields of `run:start` and `run:end`,
  and `ttlMs` / `acquireMs` on `lock:acquired`.

### Tooling

- A unit test pins `src/utils/id.js` as the only module that mints an identifier, so no id can
  bypass `generateId`.
- A unit test pins that nothing under `src/` or `bin/`, and neither declaration file, imports an
  `@opentelemetry/*` package or `bullmq-otel`; they are devDependencies only. The structural types
  are checked part by part against the real `@opentelemetry/api`, and one integration test runs the
  real `@opentelemetry/instrumentation-mongodb` to prove the driver's spans nest under a migration.
- Declared collections are pinned by a table-driven planner test, a fixed-point integration matrix
  (every kind of index converges, then plans as unchanged on a real server), and the shared queue
  scenarios on both the fake and the real BullMQ.
- An in-tree fake BullMQ carries the adapter's unit and integration tests; the same scenarios run
  against the real `bullmq` package when `MIGRONAUT_TEST_REDIS_URL` is set, which CI now does
  (a Redis service on the `test` job). `bullmq` and `ioredis` are devDependencies for that only.

## v2.0.0 — 2026-08-30

A major bump for three narrow contract changes (below); everything else is
additive. Upgrading is a no-op for the most commonly scripted surface:
`pendingMigrations()` / `list('pending')` still report a file as `pending`
even when a failed attempt was recorded for it.

### Breaking changes

- **`unlock --json` now requires `--yes`.** Previously `--json` alone
  force-released the lock; it now refuses with `CONFIG_INVALID` (exit 6), because
  a non-interactive mode must never assume consent to a destructive action —
  force-releasing a live run's lock enables exactly the concurrent migration the
  lock exists to prevent. **Migration:** add `--yes` to any scripted
  `migronaut unlock --json`.
- **`StatusRow.status` and `MigrationStatus` gained `'failed'`.** A recorded
  failed attempt now renders as `failed` in `status()` / `list('all')` instead of
  `pending`. **Migration:** TypeScript consumers with an exhaustive `switch` over
  the status must handle the new member; treat `'failed'` as outstanding work.
- **`MigronautErrorCode` gained `'MIGRATION_OUT_OF_ORDER'`** (and `EXIT_CODES`
  the matching key, exit 23). **Migration:** exhaustive `switch` statements over
  the code union must handle it.

### Added

- **`migronaut baseline`** — adopt an existing database with no prior migration tool: mark
  migration files on disk as applied (checksum from disk, one shared batch, `origin: 'baseline'`)
  without executing them. Forward-only, idempotent, confirmation-gated.
- **Out-of-order detection** — a bulk `up` flags pending migrations that sort before the newest
  applied one (a file merged late from a parallel branch). New scalar config `onOutOfOrder:
  'warn' | 'error' | 'allow'` (default `'warn'`, env `MIGRONAUT_ON_OUT_OF_ORDER`), a new
  `MIGRATION_OUT_OF_ORDER` error code (exit 23), `outOfOrder` on `StatusRow`, and an `ordering`
  check in `audit`.
- **Failed-attempt traces** — a failing `up` now leaves a best-effort `status: 'failed'` record
  (error text, `failedAt`, `runId`) in the changelog; `status` renders it as `failed` while every
  run path still retries the file; a successful apply clears the trace. A forced re-run's failure
  never demotes an `applied` record.
- **Audit-trail read surface** — `StatusRow` now carries `executedBy`, `environment`, `runId`,
  `revertedAt` and `origin` from the changelog record, so `status --json` can answer "who ran
  migration X, from which run, and was it ever reverted?".
- **`onKit` option on `runMigrations`** — receive the internally-constructed `MigratorKit` before
  connect and subscribe to its lifecycle events (metrics without log parsing).
- **`createLogger` export** — the default console logger (with level control) for programmatic
  callers.
- **`cwd` option on `MigratorKit`** — scope config discovery, `.env` loading and a relative
  `migrationsDir` to a project root, for processes hosting kits for several projects.
- **ESM-interop integration test** pinning the "ESM consumers still work" promise.

### Changed

- **Server-time changelog stamps** — `appliedAt`/`revertedAt`/`failedAt` are stamped with the
  server clock (`$currentDate`, matching the lock's `$$NOW` discipline) unless the record carries
  an explicit `appliedAt` (import), so `redo`/`down --steps` ordering is immune to host clock skew.
- **Non-transactional changelog-write failures are reported distinctly** — when a migration's own
  writes committed but recording them failed, the error now says exactly that (context
  `phase: 'changelog-write'`, `bodySucceeded: true`) instead of the generic "migration failed"
  that invited re-running committed writes.
- **A timed-out migration is told to stop** — `timeoutMs` now aborts `ctx.signal` (with the
  `MigrationTimeoutError` as reason), so cooperative bodies stop writing instead of racing the
  next lock holder.
- **`lockWaitTimeoutMs` bounds stall, not total wait** — while a waiting `runMigrations` observes
  the holder's heartbeat advancing, the deadline re-arms; only a stalled holder times peers out.
- **`baseline` requires `--yes` in `--json` mode** — the same non-interactive
  confirmation policy `up --force --json` and `unlock --json` follow.
- **Failure telemetry carries timing** — `migration:error` events, error result rows and error
  contexts now include `durationMs`/`batch`; the run ends with a `✔ Done N applied in Xms`
  summary line.
- Signals during the CLI's pre-connect now abort the run (exit 11) instead of being silently
  dropped; partial-results lists survive hook/load failures and lock-release failures; lock
  warn lines carry `runId`; import interruptions report progress and that a `--force` re-run
  resumes idempotently.

### Fixed / hardened

- URI redaction now masks query-string secrets (`tlsCertificateKeyFilePassword`, `proxyPassword`,
  `sslKeyPassword`, secret `authMechanismProperties` values) and empty-username passwords —
  in logs, errors, `--json`, events, and `init`-generated config files (which now warn about
  query-string secrets too).
- Terminal sanitization strips the whole C1 control block (DCS/OSC/PM/APC, not just CSI), and
  `bin/migronaut.js`'s last-resort handlers sanitize their output.
- `MigrationLock.release()` without a held owner token is a no-op instead of an unscoped delete;
  an uncontended `acquire()` takes one round trip instead of two.
- Import checksum resolution is concurrency-bounded (no EMFILE on thousands-record changelogs);
  the strict drift check reuses the instance checksum cache; `dry-run up` fetches applied names
  instead of full records; a warn/error-only injected logger keeps its output instead of being
  silenced entirely.

## v1.0.0 — 2026-07-28

Initial release. Requires **Node.js ≥ 22.18**.

### Core

- `MigratorKit` orchestration: `up`, `down`, `redo`, `dryRun`, `status`, `list`, `audit`,
  `create`, `init`, `import`, `lockInfo`, `forceUnlock`
- `migronaut` CLI with `init`, `up`, `down`, `redo`, `status`, `list`, `dry-run`, `audit`,
  `create`, `import`, `lock`, and `unlock` commands
- Config loader with priority: CLI flags → `MIGRONAUT_*` env vars → config file → defaults,
  checked by a built-in zero-dependency validator (`ConfigInvalidError` with per-issue
  `{ path, message }`)
- **Every scalar option is settable from the environment** — a table-driven `MIGRONAUT_*` layer
  pinned against the config-key spec by a test, so a config file is genuinely optional rather than
  merely discouraged. Values fail closed: `MIGRONAUT_STRICT=on`, `MIGRONAUT_LOCK_TTL=abc` and
  `MIGRONAUT_CREATE_EXTENSION=tsx` are rejected with an error naming the variable, never coerced
- `MIGRONAUT_NO_COLOR` / `MIGRONAUT_FORCE_COLOR` pin migronaut's own color output above the
  ecosystem-wide `NO_COLOR`/`FORCE_COLOR`, which stay honored underneath; `MIGRONAUT_USER`
  overrides the OS user recorded in `executedBy`, for CI where that user is a meaningless `runner`
- Function / async config files — `export default` a (sync or async) factory returning the config,
  for loading the connection from a secret manager at runtime with no bundled cloud SDKs
- **Client injection** (`config.client`) — reuse an already-connected `MongoClient` (its pool,
  auth, TLS); ownership stays with the caller and `disconnect()` never closes it
- **Lifecycle events** — `MigratorKit` is an EventEmitter: `run:start`/`run:end` (with duration
  and result counts), `migration:start`/`success`/`skipped`/`error`,
  `lock:acquired`/`released`/`lost` — feed metrics or alerting without parsing log lines
- First-class `.ts` and `.js` (ESM + CJS) migration loading
- MongoDB-native concurrency lock with TTL-based stale reclaim and heartbeat renewal for long
  migrations
- SHA-256 checksum tamper detection, surfaced in `status`
- Opt-in transactions (per-file or global) with automatic commit/abort
- Lifecycle hooks: `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onError`
- Append-only audit trail in `_migronaut_migrations` — reverts are never deleted

### Step controls & automation

- **`migronaut up --step`** — apply each pending file as its own sequential batch, so a later
  `down` can peel migrations off one at a time
- **`migronaut down --steps <n>`** — revert the last N applied migrations, newest first, regardless
  of batch
- **`migronaut up --to <file>` / `migronaut down --to <file>`** — migrate to a named point in the
  sequence: `up --to` applies pending files up to and including it, `down --to` reverts everything
  applied after it (exclusive), so the pair is a round trip
- **`migronaut dry-run`** previews the same selections — `--steps`, `--batch`, and `--to` — without
  touching the database
- **`migronaut audit`** — read-only health check (config, connectivity, transaction support,
  indexes, lock state, checksum drift, runtime) with pass/warn/fail per check
- **`migronaut lock`** — inspect the current migration lock holder without modifying it
- **`--json` machine-readable output** as a global flag (`migronaut --json status` and
  `migronaut status --json` both work) on every command — `up`, `down`, `redo`, `status`, `list`,
  `dry-run`, `import`, `create`, `audit`, `lock`, `unlock` — a single JSON document on stdout;
  human logs and the spinner go to stderr, so stdout stays pipe-safe. The one exception is
  `init`, whose deliverable is the config file itself: `init --format <js|ts|json>` selects the
  file format, and a stray `init --json` is rejected with a pointer to `--format`
- **`migronaut status --check`** — exits with code 2 (`PENDING_MIGRATIONS`) when any migration is
  pending, for CI deploy gates; `--pending` and `--limit <n>` filter the table
- **Typed exit codes for every error** — each `MigronautError` code maps to a dedicated exit code
  (idempotency cases included: `CONFIG_FILE_EXISTS` = 16, `IMPORT_TARGET_NOT_EMPTY` = 17), audit
  failures exit 22, and the full map is exported from the package root as `EXIT_CODES`
- **`migronaut unlock`** — force-release a stuck lock left behind by a crashed run, with holder
  info (pid / host / user / since) and a confirmation prompt (`--yes` to skip)
- **`migronaut up <file> --force --yes`** — confirm a forced re-run non-interactively

### Zero dependencies

- **No runtime dependencies at all** — `package.json` has no `dependencies` key; only `mongodb`
  (required) and `mongoose` (optional) as peers
- `.env` loading via native `util.parseEnv` (quotes, `export ` prefix, comments, multiline
  values) — real env vars always win over `.env`
- Hand-rolled ANSI colors (detection: `MIGRONAUT_FORCE_COLOR` > `MIGRONAUT_NO_COLOR` >
  `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > TTY), a TTY-only
  spinner (complete no-op when piped), box-drawing tables with ANSI-aware column widths, and a
  commander-compatible argument parser (combined short flags like `-fy` are not supported)
- `MigronautLogger` is pino-compatible (`{ debug, info, warn, error, child? }`) — pass a pino
  instance directly as `logger`; a `component: 'migronaut'` child binding is applied once and a
  throwing logger can never break a migration run

### Import from `migrate-mongo`

- **`migronaut import`** — read an existing `migrate-mongo` `changelog` and record that history in
  the migronaut changelog, so `migronaut up` runs only what is new. One-time and forward-only; the
  source collection is never modified
  - `--from <collection>` / `--to <collection>`, `--dry-run`, `--trust-hash`, `--force`, `--no-lock`
- **Forward-only safety** — imported records are tagged `origin: 'migrate-mongo'`; `migronaut
  down`/`redo` refuse them up front with a clear reason, so the changelog is never corrupted

### Hardening

- **Path-traversal protection** — migration names are validated as bare filenames confined to the
  migrations directory, so a crafted name can't load or read a file outside it
  (`MigrationInvalidNameError`)
- **Lock safety for long migrations** — heartbeat renewal at half the TTL, owner-scoped
  acquire/release/renew, server-time (`$$NOW`) staleness judgments immune to host clock skew, and
  a hard renewal deadline that stops the run strictly before a peer could reclaim the lock
- **Credential redaction** — connection-string passwords are masked (`user:****@`) in every error
  message, `--json` payload, and `--verbose` stack the CLI emits
- **Terminal-injection safety** — control characters in DB-sourced values (descriptions,
  filenames, lock-holder fields) are stripped in the default logger's write path, the spinner and
  table rendering; migronaut's own SGR colors survive, cursor movement and screen clearing do not.
  Raw `Error` objects never reach event subscribers either — `migration:error` and `run:end`
  carry a pre-redacted message string
- **Unbounded-wait protection** — `runMigrations` validates `lockWaitTimeoutMs` /
  `lockPollIntervalMs` up front (`ConfigInvalidError`), so a `NaN` can no longer turn the
  lock-wait loop into an infinite retry storm; the summary reports `waitedMs` and `attempts`
- **Preview parity** — `dry-run down` uses the exact selection the real `down` executes,
  including the refusal of forward-only migrate-mongo imports, and lists rows in revert order
- **`redo` correctness** — the target is resolved *inside* the lock (no race with a peer), and a
  failed re-apply carries the already-reverted rows in `error.context.results`
- **CLI logger fallback** — a `logger` from the config file (pino, or `null` for silence) is
  respected by the CLI instead of being clobbered by its console logger
- **Clear `.ts` runtime errors** — actionable messages when type stripping is disabled or a
  migration uses non-erasable TypeScript syntax (`enum`, `namespace`)
- **`TransactionsUnsupportedError`** — `useTransaction` on a standalone server names the topology
  as the problem instead of blaming the migration
- `prepublishOnly` runs `lint` + `format:check` + coverage-gated tests + `tsd` type tests +
  a strict `tsc` pass over `index.d.ts` (`check:dts`), so a broken release can't be published

### Documentation

- Full documentation site at <https://migronaut.vercel.app/> — guides, a full command reference, a
  programmatic API overview, an FAQ, and a migrate-mongo migration guide
- Requires **Node.js ≥ 22.18** — `.ts` migrations run natively (built-in type stripping) with no
  loader or build step; `.js` migrations likewise
