const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// `mongodb` is required lazily inside connect(): loading the driver costs ~60ms
// and pulls in ~150 modules, which `--help`, `--version`, `init` and `create`
// have no use for.
const {
  BackgroundPendingError,
  ChecksumMismatchError,
  ConfigInvalidError,
  ConnectionFailedError,
  HookFailedError,
  IrreversibleMigrationError,
  LockAlreadyHeldError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationInvalidNameError,
  MigronautError,
  NotAppliedError,
  OutOfOrderMigrationError,
  RunAbortedError,
} = require('../errors/index.js');
const { actorFields, pickActor } = require('../utils/actor.js');
const { computeChecksum } = require('../utils/checksum.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText, errorWithCause } = require('../utils/error.js');
const { createIdGenerator } = require('../utils/id.js');
const { loadMigrationFile } = require('../utils/loader.js');
const { resolveLogger } = require('../utils/logger.js');
const { assertMigrationName } = require('../utils/migration-name.js');
const { ATTRIBUTES, SPANS, createTelemetry } = require('../utils/telemetry.js');
const {
  createConfigFile,
  createMigrationFile,
  maskUriCredentials,
} = require('../utils/template.js');
const { safeUsername } = require('../utils/user.js');
const { runAudit } = require('./audit.js');
const {
  auditFindings,
  control: controlBackground,
  coordinate,
  failedError,
  repin: repinBackgroundState,
  runSlice,
  tryUnblock,
  verify: verifyDrift,
  waitForLanes,
} = require('./background.js');
const { resolveBackgroundSpec } = require('./background-spec.js');
const { previewSample, previewSteps } = require('./background-dry-run.js');
const { matchOf } = require('./background-engine.js');
const { BackgroundStore } = require('./background-store.js');
const { sleep } = require('./background-throttle.js');
const { runBaseline } = require('./baseline.js');
const { Changelog } = require('./changelog.js');
const { ConvergeLog } = require('./converge-log.js');
const { resolveDefinitions } = require('./collections.js');
const { backgroundCollectionNames, loadConfig } = require('./config.js');
const { buildContext } = require('./context.js');
const { runConverge } = require('./converge.js');
const { readServer } = require('./server-info.js');
const { readShardKey } = require('./shard-info.js');
const { runImport } = require('./import-runner.js');
const { MigrationLock, runWithLock, toLockInfo } = require('./lock.js');
const {
  assertConvergeOptions,
  assertDownOptions,
  assertDryRunOptions,
  assertFilename,
  assertHistoryLimit,
  assertImportOptions,
  assertListOptions,
  assertRedoOptions,
  assertUpOptions,
} = require('./options.js');
const { RunRecorder } = require('./run-recorder.js');
const { runMigration } = require('./runner.js');
const {
  blockedError,
  lateArrivals,
  listMigrationFiles,
  newestOf,
  pendingIn,
  revertOrder,
  truncateAtTarget,
} = require('./sequence.js');

/** Simultaneous file reads — keeps a large migrations dir clear of EMFILE */
const FS_CONCURRENCY = 16;

/**
 * The main orchestration class. Every CLI command delegates here. Holds a
 * partial config that is resolved (merged with env/file/defaults) on first use.
 *
 * Also an EventEmitter: subscribe with `kit.on('migration:success', …)` to feed
 * metrics or alerting without parsing log lines. Events complement
 * {@link MigrationHooks} — hooks are configured up front and run user database
 * logic in the migration's flow; listeners attach from outside, may be several,
 * and a listener that throws is contained rather than failing the run.
 */
/**
 * How a lock-wait loop outside the kit (`runMigrations`, the queue processor)
 * reports a finished wait to the kit's telemetry. A symbol, and not exported
 * from the package: the loop is migronaut's own, and so is this channel.
 */
const RECORD_LOCK_WAIT = Symbol('migronaut.recordLockWait');

class MigratorKit extends EventEmitter {
  #partialConfig;
  #configPath;
  #progress;
  #config;
  #client;
  #db;
  #changelog;
  /** Set while a locked run is in flight, so stop() can interrupt it */
  #abort;
  /** A stop requested before the run reached its lock — consumed when it does */
  #stopRequested;
  /** >0 while a run method is setting up or executing — the stop() latch window */
  #runSetupDepth = 0;
  /** Correlation id for the run in flight — ties logs, lock and changelog together */
  #runId;
  /** Mints an id in the configured format (`generateId`, else a UUID); set with the config */
  #newId;
  /** Spans and metrics through the injected `telemetry` (a no-op without one); set with the config */
  #telemetry;
  /** Whether changelog indexes have already been ensured on this instance */
  #indexesEnsured = false;
  /** Memoized resolved logger — resolveLogger allocates on every call otherwise */
  #resolvedLogger;
  /** Used only when the resolved config supplies no `logger` of its own (CLI injection) */
  #fallbackLogger;
  /** False when the client was injected by the caller, who keeps ownership of it */
  #ownsClient = true;
  /** The connect() in flight, so overlapping callers share one client instead of racing */
  #connecting;
  /**
   * The config load in flight, so overlapping first callers share one — a
   * config factory may fetch secrets, and must not run twice.
   */
  #configLoading;
  /**
   * Project root this instance resolves against — config discovery, the .env
   * file and a relative migrationsDir. Defaults to process.cwd(); an explicit
   * value is what lets one process host kits for several projects.
   */
  #cwd;
  /** filepath → {mtimeMs, size, checksum} — spares repeat status()/audit() calls a full re-hash */
  #checksumCache = new Map();
  /** The converge history store, created on first use */
  #convergeLogStore;
  /**
   * Definitions an after-up converge resolved, kept only while `up()` is being
   * refused for a held lock: a caller polling for the lock retries `up()`
   * every few hundred milliseconds, and each retry would otherwise re-import
   * every definition file — under `reloadMigrations`, a module per file per
   * poll that the module cache never frees. Cleared by any other outcome.
   */
  #upDefinitions;
  /** The background migrations' store — made on first use (see #backgroundStore) */
  #backgroundStoreInstance;
  /** Warnings about background migrations said once per kit (a missing index, no lag rights) */
  #backgroundWarned = new Set();
  /** The adaptive throttles of this process, per background migration and group */
  #adaptiveCache = new Map();
  /** Declared collections, for background specs — resolved once unless migrations reload */
  #backgroundDefinitions;
  /** The server's topology, read once — transactional background migrations need it */
  #topology;
  /** Migration modules read ahead of a run (requires, kind), by checksum */
  #moduleCache = new Map();

  constructor(config = {}, options = {}) {
    super();
    this.#partialConfig = config;
    this.#configPath = options.configPath;
    this.#progress = options.progress;
    this.#fallbackLogger = options.fallbackLogger;
    this.#cwd = options.cwd;
  }

  /**
   * Emit a lifecycle event without letting a listener affect the run.
   *
   * A throwing listener is swallowed (observability must never break a
   * migration), and `error` is deliberately not used as an event name: an
   * EventEmitter with no `error` listener throws, which would turn a reported
   * failure into a second, unrelated one.
   */
  #emit(event, payload) {
    try {
      this.emit(event, { ...(this.#runId ? { runId: this.#runId } : {}), ...payload });
    } catch (error) {
      // A listener's failure is its own problem — but an invisible one is
      // undebuggable, so leave a trace at debug level.
      this.#logger.debug(
        `Event listener for '${event}' threw: ${errorText(error)}`,
        this.#fields({ event, error: errorText(error) }),
      );
    }
  }

  /**
   * Stop the run in progress: the migration currently executing is allowed to
   * finish (interrupting it mid-write is what leaves a database half-migrated),
   * the remaining ones are skipped, the lock is released, and the call rejects
   * with a RunAbortedError listing what was applied.
   *
   * A stop that arrives before the run reaches its lock — while config is
   * loading or the connection is opening, the exact window a pod eviction hits
   * — is remembered and applied as soon as it does, instead of being lost.
   * With no run in flight or being set up, this is the documented no-op: a
   * latched stop would otherwise silently abort an unrelated run started
   * minutes later.
   */
  stop(reason = 'Run stopped by request') {
    if (this.#abort) {
      this.#abort(reason);
      return;
    }
    if (this.#runSetupDepth > 0) {
      this.#stopRequested = reason;
    }
  }

  /**
   * Mark the window in which a public run method is setting up (config load,
   * connect) or executing, so stop() can tell "run imminent — latch the stop"
   * from "nothing running — no-op". The latch is cleared on the way out so it
   * can never leak into a later, unrelated run.
   */
  async #runWindow(fn) {
    this.#runSetupDepth += 1;
    try {
      return await fn();
    } finally {
      this.#runSetupDepth -= 1;
      if (this.#runSetupDepth === 0) {
        this.#stopRequested = undefined;
      }
    }
  }

  /** Resolve and cache the full configuration — once, however many callers ask at once */
  async #ensureConfig(requireDb = true, lenient = false) {
    if (this.#config) return this.#config;
    this.#configLoading ??= this.#loadConfig(requireDb, lenient).finally(() => {
      this.#configLoading = undefined;
    });
    return this.#configLoading;
  }

  async #loadConfig(requireDb, lenient) {
    const config = await loadConfig({
      flags: this.#partialConfig,
      requireDb,
      ...(lenient ? { lenient: true } : {}),
      ...(this.#configPath ? { configPath: this.#configPath } : {}),
      ...(this.#cwd ? { cwd: this.#cwd } : {}),
      ...(this.#fallbackLogger !== undefined ? { fallbackLogger: this.#fallbackLogger } : {}),
    });
    this.#newId = createIdGenerator(config.generateId);
    this.#telemetry = createTelemetry(config.telemetry, { dbName: config.dbName });
    this.#config = config;
    return config;
  }

  get #logger() {
    // Memoized once the config is resolved: with no user logger, resolveLogger
    // builds a fresh logger (and two color palettes) on every read — and this
    // is read per log line. Before resolution the choice is provisional (a
    // config file may still supply a logger), so it is not locked in yet.
    if (this.#resolvedLogger) return this.#resolvedLogger;
    const source = this.#config?.logger !== undefined ? this.#config.logger : this.#fallbackLogger;
    const resolved = resolveLogger(source);
    if (this.#config) this.#resolvedLogger = resolved;
    return resolved;
  }

  /**
   * The resolved logger — silent when config sets `logger: null`. Meaningful
   * after `connect()` (before it, the config file's logger is not loaded yet);
   * lets wrappers like `runMigrations` log with the run's own verbosity.
   */
  get logger() {
    return this.#logger;
  }

  /**
   * Environment stamped onto changelog records: an explicit config value wins,
   * then NODE_ENV, then 'production' — the safe assumption when nothing says
   * otherwise (an unset NODE_ENV in a container is far more often production
   * than a developer's laptop).
   *
   * `MIGRONAUT_ENVIRONMENT` is the prefixed override: it feeds `config.environment`
   * through the ENV_KEYS table, so it already outranks NODE_ENV by the time this
   * runs. NODE_ENV stays honored underneath as the ecosystem convention.
   */
  #environment() {
    return this.#config?.environment ?? process.env.NODE_ENV ?? 'production';
  }

  /**
   * Structured fields for a log line. Passed as the logger's second argument
   * (first, for pino-style loggers) so a machine-readable sink gets
   * `{migration, direction, durationMs, …}` instead of having to parse the
   * emoji-prefixed human string.
   */
  #fields(extra) {
    return this.#runId ? { runId: this.#runId, ...extra } : { ...extra };
  }

  /** Record a finished wait for the lock — see {@link RECORD_LOCK_WAIT} */
  [RECORD_LOCK_WAIT](wait) {
    this.#telemetry?.lockWaited(wait);
  }

  /** Connect to MongoDB and ensure changelog indexes exist */
  async connect() {
    const config = await this.#ensureConfig();
    if (this.#client && this.#db) {
      return;
    }
    // A long-lived kit serves overlapping callers (a status probe while a
    // queue job starts). Without this, each would open its own MongoClient
    // and all but the last would leak their pools.
    this.#connecting ??= this.#openConnection(config).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #openConnection(config) {
    const startedAt = Date.now();
    try {
      if (config.client) {
        // A client the caller owns: reuse its pool (and whatever auth, TLS or
        // proxying it was built with) and never close it — see disconnect().
        this.#client = config.client;
        this.#ownsClient = false;
      } else {
        this.#warnOnWeakTls(config.clientOptions);
        const { MongoClient } = require('mongodb');
        // clientOptions is the escape hatch for everything a URI cannot carry:
        // TLS certificates, AWS IAM / X.509 auth, proxies, pool sizing.
        this.#client = new MongoClient(config.uri, config.clientOptions);
        this.#ownsClient = true;
        await this.#client.connect();
      }
      this.#db = this.#client.db(config.dbName);
      this.#changelog = new Changelog(config.migrationsCollection);
      // Once per instance, not once per connect: re-issuing createIndexes on
      // every command is a wasted round trip. `ensureIndexes: false` skips it
      // entirely, for deployments where the app user cannot create indexes.
      if (!this.#indexesEnsured && config.ensureIndexes) {
        await this.#changelog.ensureIndexes(this.#db);
        this.#indexesEnsured = true;
      }
      // "Which database did it actually write to?" is the most common support
      // question — answerable from --verbose output instead of a separate audit.
      this.#logger.debug(
        `Connected to MongoDB (db: ${config.dbName})`,
        this.#fields({
          dbName: config.dbName,
          durationMs: Date.now() - startedAt,
          injectedClient: !this.#ownsClient,
        }),
      );
    } catch (error) {
      // Close and forget the half-built client. Leaving it assigned would leak
      // its connection pool, since a retry of connect() overwrites the field.
      const dangling = this.#ownsClient ? this.#client : undefined;
      this.#client = undefined;
      this.#db = undefined;
      this.#changelog = undefined;
      await dangling?.close().catch(() => undefined);
      throw new ConnectionFailedError(
        'Failed to connect to MongoDB',
        { cause: errorText(error) },
        { cause: error },
      );
    }
  }

  /**
   * Disconnect from MongoDB.
   *
   * An injected `config.client` is left open: the application handed it over to
   * be reused, and closing it here would take down its connection pool for
   * everything else using it.
   */
  async disconnect() {
    if (!this.#client) return;
    const client = this.#client;
    const owned = this.#ownsClient;
    // Restore the full pre-connect invariant: every connection-scoped field is
    // cleared together, so nothing half-connected survives a disconnect.
    this.#client = undefined;
    this.#db = undefined;
    this.#changelog = undefined;
    this.#ownsClient = true;
    if (owned) await client.close();
  }

  /**
   * A committed config file can weaken TLS verification for everyone who runs
   * migrations against it — a legitimate escape hatch, but never a silent one.
   */
  #warnOnWeakTls(clientOptions) {
    if (!clientOptions) return;
    const weakening = [];
    for (const key of ['tlsInsecure', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames']) {
      if (clientOptions[key]) weakening.push(key);
    }
    if (weakening.length > 0) {
      this.#logger.warn(
        `⚠ clientOptions disables TLS verification (${weakening.join(', ')}) — ` +
          'connections are exposed to interception',
        this.#fields({ clientOptions: weakening }),
      );
    }
  }

  /** Build a lock bound to the configured collection (assumes connected) */
  #buildLock() {
    const config = this.#config;
    return new MigrationLock(this.#requireDb(), config.lockCollection, config.lockTTLSeconds);
  }

  /**
   * The resolved logger with #fields merged into every line, for handing to
   * lock.js — which stays kit-agnostic and cannot stamp runId itself.
   */
  #lockLogger() {
    const wrap = (method) => (msg, fields) => this.#logger[method](msg, this.#fields(fields ?? {}));
    return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
  }

  /**
   * Run `fn(signal, lock)` under the migration lock. The single place that
   * pairs a lock with a unit of work, so `redo` can hold one lock across both
   * directions instead of releasing between them. `info` names the run
   * (`{command, direction?}`) for the `run:start`/`run:end` events.
   * `lock.release()` gives the lock up before `fn` returns, for a tail that
   * only reads (see runWithLock) — the run, its id and its span go on.
   */
  async #withLock(options, info, fn) {
    // Not reentrant: a second overlapping run on this instance would clobber
    // the first one's runId/abort state in its `finally`. The DB lock already
    // rejects the overlap — this rejects it before any state is disturbed.
    if (this.#runId) {
      throw new ConfigInvalidError('A run is already in flight on this MigratorKit instance', {
        runId: this.#runId,
      });
    }
    // One id per run, reused as the lock's owner token and stamped on every
    // changelog record and log line, so the three can be correlated after the
    // fact ("which run left this lock?", "what did run X apply?"). Minted
    // before any other run state exists: a `generateId` that throws or returns
    // a non-id rejects here, leaving nothing to unwind and no event emitted.
    this.#runId = this.#newId();
    // A second controller layered over the lock's own signal, so stop() and a
    // lost lock abort through the same path the run loops already watch.
    const stopper = new AbortController();
    this.#abort = (reason) => {
      if (!stopper.signal.aborted) {
        stopper.abort(new RunAbortedError(reason, { reason }));
      }
    };
    // Honor a stop that landed before we got here (config load / connect).
    if (this.#stopRequested !== undefined) {
      const pending = this.#stopRequested;
      this.#stopRequested = undefined;
      this.#abort(pending);
    }
    const recorder = new RunRecorder({
      info,
      runId: this.#runId,
      telemetry: this.#telemetry,
      emit: (event, payload) => this.#emit(event, payload),
      logger: this.#logger,
      fields: (extra) => this.#fields(extra),
    });
    recorder.start();
    let failure;
    let result;
    try {
      result = await runWithLock(
        this.#buildLock(),
        {
          // Wrapped so every lock line carries #fields (runId included) — a
          // JSON-sink operator must be able to join a lock-lost alert to the
          // run's migration lines and changelog records without a log parse.
          logger: this.#lockLogger(),
          onLockLost: this.#config.onLockLost,
          owner: this.#runId,
          onLockAcquired: (extra) => recorder.lockAcquired(extra),
          onLockReleased: (extra) => recorder.lockReleased(extra),
          onLockLostEvent: (reason) => recorder.lockLost(reason),
          ...(options.noLock ? { noLock: true } : {}),
        },
        (lockSignal, lockControl) =>
          // The run's span exists only once the lock is held: a caller polling
          // for a busy lock retries the whole run every few hundred
          // milliseconds, and a span per refusal would bury the one run that
          // did the work. Active around the unit of work only, and ended by the
          // recorder after the release, so the span's outcome is the run's.
          this.#telemetry.open(SPANS.RUN, recorder.spanAttributes(), (span) => {
            recorder.spanOpened(span);
            return fn(AbortSignal.any([lockSignal, stopper.signal]), lockControl);
          }),
      );
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      recorder.finish(result, failure);
      this.#abort = undefined;
      this.#runId = undefined;
    }
  }

  /**
   * Attach partial results to an error's context. Copy-on-write: the error may
   * live on a shared abort signal (see #assertNotAborted) or already carry
   * results from an earlier phase (redo's down half) — mutating its context in
   * place would let a later phase overwrite what an earlier one recorded.
   */
  #attachResults(error, results) {
    if (!(error instanceof MigronautError) || !error.context) return;
    error.context = { ...error.context, results: [...results] };
  }

  /** Throw whatever aborted the run (LockLostError or RunAbortedError) */
  #assertNotAborted(signal, results) {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof MigronautError) {
      if (results) this.#attachResults(reason, results);
      throw reason;
    }
    throw new RunAbortedError('Run aborted', { ...(results ? { results: [...results] } : {}) });
  }

  /**
   * Inspect the current migration lock without modifying it. Returns the holder,
   * or null when no lock is held.
   */
  async lockInfo() {
    await this.#ensureConfig();
    await this.connect();
    return toLockInfo(await this.#buildLock().inspect());
  }

  /**
   * Force-release the migration lock regardless of who holds it — for clearing a
   * lock left behind by a crashed run (`migronaut unlock`). Returns the holder that was
   * removed, or null if no lock was held.
   */
  async forceUnlock() {
    await this.#ensureConfig();
    await this.connect();
    return toLockInfo(await this.#buildLock().forceRelease());
  }

  /**
   * The batch number the next `up` would use — a peek, not a reservation: two
   * callers asking before either applies get the same number. Counts reverted
   * and failed records too, so a rolled-back number is never handed out again.
   * Pair it with `up(name, { batch })` to stamp several single-file runs as one
   * batch.
   */
  async nextBatch() {
    await this.#ensureConfig();
    await this.connect();
    return this.#nextBatch();
  }

  /**
   * A new id in the format this kit is configured with — the `generateId`
   * option, else a random UUID. It is what every run id comes from; exposed so
   * a layer above the kit (the queue adapter's group ids) mints its own ids in
   * the same format without being configured a second time. Does not connect.
   */
  async generateId() {
    await this.#ensureConfig();
    return this.#newId();
  }

  /** Internal accessors that assume a successful connect() */
  #requireDb() {
    if (!this.#db) {
      throw new ConnectionFailedError('Not connected — call connect() first');
    }
    return this.#db;
  }

  #requireChangelog() {
    if (!this.#changelog) {
      throw new ConnectionFailedError('Not connected — call connect() first');
    }
    return this.#changelog;
  }

  #migrationsPath() {
    // No value fallback: DEFAULT_CONFIG always supplies migrationsDir, and a
    // silent './migrations' here would mask a config-resolution regression.
    return path.resolve(this.#cwd ?? process.cwd(), this.#config.migrationsDir);
  }

  /**
   * Resolve a migration name to an absolute path inside the migrations dir.
   *
   * The name must be a bare filename: a name containing a path separator, a
   * NUL byte, or `.`/`..` is rejected with MigrationInvalidNameError.
   * This prevents path traversal — e.g. `migronaut up ../../evil.js` would otherwise
   * resolve (and `loadMigrationFile` execute) a file outside the migrations
   * directory. A final containment check guards against any residual escape.
   */
  #filepath(name) {
    const dir = this.#migrationsPath();
    assertMigrationName(name);
    const resolved = path.join(dir, name);
    const relative = path.relative(dir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new MigrationInvalidNameError('Migration name escapes the migrations directory', {
        name,
      });
    }
    return resolved;
  }

  /** List migration files on disk, sorted ascending */
  async #listMigrationFiles() {
    // No value fallback — DEFAULT_CONFIG always supplies fileExtensions.
    return listMigrationFiles(this.#migrationsPath(), this.#config.fileExtensions);
  }

  /** Compute the next batch number (monotonic across the full history) */
  async #nextBatch() {
    return (await this.#requireChangelog().getMaxBatch(this.#requireDb())) + 1;
  }

  /**
   * `ordered` guard for a single-file `up`: refuse while an earlier file on
   * disk is still pending. Pending means "no applied record" — a `'failed'`
   * trace counts, so a migration that failed stops the line exactly like one
   * that never ran. Checked inside the lock and before `beforeAll`, so a
   * blocked run fires no hooks and consumes no batch number.
   */
  async #assertUpNotBlocked(name, appliedNames, sequence) {
    const files = sequence ?? (await this.#listMigrationFiles());
    const blockedBy = pendingIn(files, appliedNames, name);
    if (blockedBy.length === 0) return;
    throw blockedError(name, 'earlier migration(s) still pending', {
      name,
      direction: 'up',
      blockedBy,
      failed: await this.#failedAmong(blockedBy),
    });
  }

  /**
   * The blockers that failed — a stopped line — as opposed to ones that have
   * simply not run yet: with several queue workers, an earlier job may still be
   * in flight elsewhere, and waiting for it is the right reaction.
   */
  async #failedAmong(names) {
    return this.#requireChangelog().getFailedNames(this.#requireDb(), names);
  }

  /**
   * `ordered` guard for a single-file `down`: refuse while a migration applied
   * *after* this one is still applied. "After" is chronological (`appliedAt`),
   * not alphabetical — the order `down --steps` reverts in, and the only one
   * that undoes effects in reverse of how they were made. Name order would
   * deadlock a batch holding a file merged late from a parallel branch.
   */
  async #assertDownNotBlocked(record) {
    const newer = await this.#requireChangelog().getAppliedNewerThan(this.#requireDb(), record);
    if (newer.length === 0) return;
    const blockedBy = [];
    for (const later of newer) blockedBy.push(later.name);
    throw blockedError(record.name, 'later migration(s) still applied', {
      name: record.name,
      direction: 'down',
      blockedBy,
      // A rollback has no failed trace to tell a stopped line apart.
      failed: [],
    });
  }

  /**
   * Resolve which files an `up` (or its dry-run) targets: a named file (which
   * must exist on disk), or every pending file, optionally truncated at `--to`.
   * The single source of truth for that selection — mirroring
   * {@link #selectDownTargets} — so the preview can never disagree with the
   * real run about what would be applied.
   */
  async #selectUpTargets(filename, options, appliedNames) {
    if (filename) {
      const filepath = this.#filepath(filename);
      try {
        await fs.access(filepath);
      } catch {
        throw new MigrationFileNotFoundError('Migration file not found', { filename });
      }
      return [filename];
    }
    const files = await this.#listMigrationFiles();
    const targets = pendingIn(files, appliedNames);
    return options.to !== undefined ? truncateAtTarget(targets, files, options.to) : targets;
  }

  /**
   * Detect out-of-order arrivals: a pending target that sorts before the
   * newest applied name is a migration merged late from a parallel branch — it
   * will run after migrations authored later, so environments migrated at
   * different times end up with different effective orders, silently.
   * `onOutOfOrder` decides the reaction: 'warn' (default) logs and continues,
   * 'error' refuses the run, 'allow' disables the check. Only a bulk `up`
   * carries the full applied set; a single-file `up` (an explicit, deliberate
   * target) is exempt by construction, since its applied set holds at most
   * that file.
   */
  #assertOrderIntact(targets, appliedNames) {
    const policy = this.#config?.onOutOfOrder ?? 'warn';
    if (policy === 'allow') return;
    const arrivals = lateArrivals(targets, appliedNames);
    if (arrivals === null) return;
    const { late, newestApplied } = arrivals;
    if (policy === 'error') {
      throw new OutOfOrderMigrationError(
        `${late.length} pending migration(s) sort before the newest applied one ` +
          `(${newestApplied}): ${late.join(', ')} — apply deliberately with onOutOfOrder: 'warn' or 'allow'`,
        { names: late, newestApplied },
      );
    }
    this.#logger.warn(
      `⚠ Out-of-order: ${late.length} pending migration(s) sort before the newest applied one ` +
        `(${newestApplied}): ${late.join(', ')}`,
      this.#fields({ event: 'migrations:out-of-order', names: late, newestApplied }),
    );
  }

  /**
   * The shared skeleton of a migration run: beforeAll → per-name loop with an
   * abort check between migrations → afterAll (also on the failure path, which
   * is exactly when a cleanup/notification hook matters most). `execute` does
   * the per-migration work and returns `'done'` when it ran (vs. skipped).
   */
  async #runSequence({ direction, names, context, signal, execute }) {
    const config = this.#config;
    const results = [];
    let doneCount = 0;
    let failure;
    try {
      await this.#runHook(config.hooks?.beforeAll, 'beforeAll', [context]);
      for (const [index, name] of names.entries()) {
        // Between migrations is the only safe place to stop: the one in flight
        // has committed, and the next has not started.
        this.#assertNotAborted(signal, results);
        const outcome = await execute(name, index, results);
        if (outcome === 'done') doneCount += 1;
        // A clean stop: what follows waits for a background migration.
        if (outcome === 'stop') break;
      }
    } catch (error) {
      failure = error;
      // Failures before the migration body — beforeEach, a file that fails to
      // load — bypass #executeMigration's catch, so the partial results must be
      // attached here too or a --json consumer loses the applied-so-far list
      // exactly when it matters. Copy-on-write makes a re-attach harmless.
      this.#attachResults(error, results);
    }
    const succeeded = failure === undefined;
    // afterAll runs on the failure path too — which is exactly when a
    // cleanup/notification hook matters most. Mirrors runWithLock's release
    // discipline: when the body already failed, a throwing afterAll must not
    // replace that error — the migration failure (and its context.results) is
    // the diagnosis the caller needs, not the notification hook's own trouble.
    try {
      await this.#runHook(config.hooks?.afterAll, 'afterAll', [
        context,
        { success: succeeded, applied: doneCount, direction },
      ]);
    } catch (hookError) {
      if (succeeded) throw hookError;
      this.#logger.warn(
        `⚠ afterAll hook failed after a failed run: ${errorText(hookError)}`,
        this.#fields({ hook: 'afterAll', error: errorText(hookError) }),
      );
    }
    if (failure !== undefined) throw failure;
    return results;
  }

  /**
   * Execute one migration under its own span, and time it for the meter.
   *
   * The span is the *active* one for everything the migration does — hooks,
   * the file's own `up`/`down`, the changelog write — which is what lets an
   * instrumented driver hang its command spans under the migration that issued
   * them. A listener on `migration:start` could open a span but never make it
   * active, so this is the one thing telemetry needs from inside the kit.
   */
  async #executeMigration(step) {
    const { name, direction, index, total, batch } = step;
    const telemetry = this.#telemetry;
    const startedAt = Date.now();
    try {
      const duration = await telemetry.wrap(
        SPANS.MIGRATION,
        {
          [ATTRIBUTES.MIGRATION_NAME]: name,
          [ATTRIBUTES.MIGRATION_DIRECTION]: direction,
          [ATTRIBUTES.MIGRATION_BATCH]: batch,
          [ATTRIBUTES.MIGRATION_INDEX]: index,
          [ATTRIBUTES.MIGRATION_TOTAL]: total,
          [ATTRIBUTES.RUN_ID]: this.#runId,
        },
        (span) => this.#executeMigrationSteps(step, span),
      );
      telemetry.migrationEnded({ direction, durationMs: duration });
      return duration;
    } catch (error) {
      // The runner's own measurement when it got as far as the body; the
      // elapsed time here otherwise (a failing beforeEach, a file that does
      // not load) — a failure deserves a data point as much as a success.
      const durationMs =
        error instanceof MigronautError && typeof error.context?.durationMs === 'number'
          ? error.context.durationMs
          : Date.now() - startedAt;
      telemetry.migrationEnded({ direction, durationMs, error });
      throw error;
    }
  }

  /**
   * Execute one migration end to end: beforeEach → load → run (with the
   * changelog write inside the transaction via `onSuccess`) → events, logs,
   * result row, afterEach — and the mirrored error path. Shared verbatim by
   * `up` and `down`, so a fix to one direction cannot silently miss the other.
   */
  async #executeMigrationSteps(
    { name, direction, context, index, total, results, batch, onSuccess, failureFields },
    span,
  ) {
    const config = this.#config;
    const logger = this.#logger;
    const batchField = batch !== undefined ? { batch } : {};

    await this.#runHook(config.hooks?.beforeEach, 'beforeEach', [
      name,
      context,
      { direction, index, total },
    ]);
    const loaded = await loadMigrationFile(this.#filepath(name), {
      reload: config.reloadMigrations,
      allowBackground: true,
    });
    let migration = loaded;
    if (loaded.kind === 'background') {
      // Indexes cannot be created inside a transaction — the registration may run in one.
      await this.#backgroundStore().ensureIndexes();
      migration = await this.#asBackground(name, loaded, direction);
    }
    const useTransaction = migration.useTransaction ?? config.useTransaction;
    span.set({ [ATTRIBUTES.MIGRATION_TRANSACTION]: useTransaction });

    this.#progress?.onStart(name, direction);
    this.#emit('migration:start', { migration: name, direction, ...batchField });
    try {
      // The changelog write happens inside runMigration so that, under
      // useTransaction, it commits atomically with the migration itself.
      const { duration } = await runMigration({
        name,
        migration,
        direction,
        context,
        useTransaction,
        logger,
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        onSuccess: (elapsed, session) => onSuccess(migration, elapsed, session),
        ...(config.hooks ? { hooks: config.hooks } : {}),
      });
      this.#progress?.onStop('success');
      this.#emit('migration:success', {
        migration: name,
        direction,
        ...batchField,
        durationMs: duration,
      });
      const label =
        migration.kind === 'background'
          ? direction === 'up'
            ? '⧗ Registered'
            : '⧗ Reverting'
          : direction === 'up'
            ? '✔ Applied '
            : '↩ Reverted';
      logger.info(
        `${label} ${name}   [${duration}ms]`,
        this.#fields({ migration: name, direction, ...batchField, durationMs: duration }),
      );
      if (migration.registered) {
        this.#emit('background:registered', { migration: name, ...migration.registered });
      }
      results.push({
        file: name,
        status: direction === 'up' ? 'applied' : 'reverted',
        duration,
        ...batchField,
      });
      await this.#runHook(config.hooks?.afterEach, 'afterEach', [
        name,
        duration,
        context,
        { direction, index, total },
      ]);
      return duration;
    } catch (error) {
      this.#progress?.onStop('error');
      // The runner measures how long the failing attempt ran and leaves it on
      // the error's context — thread it through, so failures carry timing data
      // the same way successes do (a slow-then-failing migration is exactly
      // what a metrics subscriber alerts on).
      const durationMs =
        error instanceof MigronautError && typeof error.context?.durationMs === 'number'
          ? error.context.durationMs
          : undefined;
      const durationField = durationMs !== undefined ? { durationMs } : {};
      // errorText, not the raw Error: a driver message can echo the
      // credentialed URI, and event subscribers (Sentry, JSON logs) would
      // ship it — the same redaction the log line below already gets.
      this.#emit('migration:error', {
        migration: name,
        direction,
        ...batchField,
        ...durationField,
        error: errorText(error),
      });
      logger.error(
        `✖ Error    ${name}`,
        this.#fields({
          migration: name,
          direction,
          ...batchField,
          ...durationField,
          error: errorText(error),
        }),
      );
      results.push({
        file: name,
        status: 'error',
        ...(durationMs !== undefined ? { duration: durationMs } : {}),
        error: errorText(error),
      });
      // Best-effort DB-side trace of the failed attempt (up only — marking a
      // failed `down` would demote a record that is still truthfully applied).
      // Swallowed on its own failure: the changelog may be the thing that is
      // down, and this trace must never mask the migration's real error.
      if (direction === 'up') {
        try {
          await this.#requireChangelog().markFailed(this.#requireDb(), {
            name,
            // Which migration failed, and why.
            error: errorWithCause(error),
            environment: this.#environment(),
            executedBy: safeUsername(),
            ...batchField,
            ...(durationMs !== undefined ? { duration: durationMs } : {}),
            ...(this.#runId ? { runId: this.#runId } : {}),
            ...failureFields,
          });
        } catch {
          // Duplicate key when an 'applied' record exists (forced re-run), or
          // the database itself is unreachable — the trace is best-effort.
        }
      }
      // Carry what already succeeded, so `--json` consumers can tell which
      // migrations landed before the failure instead of losing the list.
      this.#attachResults(error, results);
      throw error;
    }
  }

  /** Run all pending migrations, or a specific named file */
  async up(filename, options = {}) {
    assertUpOptions(filename, options);
    return this.#runWindow(async () => {
      const config = await this.#ensureConfig();
      // Converge only after a run that brings the database to the head: the
      // declared end state describes the newest schema, and a unique index
      // may well depend on a dedupe migration a `--to` run stops short of.
      // A single-file run is one step of a sequence (a queue job), never its end.
      const converge = filename === undefined && (options.converge ?? config.convergeAfterUp);
      if (converge && options.to !== undefined) {
        this.#logger.info(
          'Converge after up skipped: --to stops short of the newest migration',
          this.#fields({ command: 'up', to: options.to }),
        );
      }
      // Resolved before the lock: a definition file that does not load fails
      // the run before any migration is applied, not after.
      const definitions =
        converge && options.to === undefined
          ? (this.#upDefinitions ??= await this.#resolveCollections())
          : [];
      return this.#keepDefinitionsWhileRefused(async () => {
        await this.connect();
        return this.#withLock(options, { command: 'up', direction: 'up' }, async (signal, lock) => {
          const results = await this.#runUp(filename, options, signal);
          // Even when nothing was pending: a converge that failed last time is
          // retried by the next `up` instead of waiting for the next migration.
          if (definitions.length > 0) {
            this.#assertNotAborted(signal, results);
            try {
              await runConverge(
                this.#convergeDeps(lock),
                {
                  definitions,
                  trigger: 'up',
                  search: this.#convergeSearchOptions(),
                  ...pickActor(options),
                },
                signal,
              );
            } catch (error) {
              // The migrations are applied and recorded either way — they must
              // survive into what a `--json` consumer sees about the failure.
              this.#attachResults(error, results);
              throw error;
            }
          }
          return results;
        });
      });
    });
  }

  /** Run `fn`, keeping the cached after-up definitions only when it is refused for the lock */
  async #keepDefinitionsWhileRefused(fn) {
    try {
      const result = await fn();
      this.#upDefinitions = undefined;
      return result;
    } catch (error) {
      if (!(error instanceof LockAlreadyHeldError)) this.#upDefinitions = undefined;
      throw error;
    }
  }

  async #runUp(filename, options = {}, signal) {
    const force = options.force ?? false;
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    // An `ordered` single-file run is one step of a sequence someone else is
    // driving (a queue job), so it must uphold what a bulk run would: it reads
    // the full applied set, and with it the strict drift check and the
    // out-of-order policy apply — otherwise splitting a run into jobs would
    // silently drop both.
    const ordered = filename !== undefined && options.ordered === true;
    const fullSet = !filename || ordered;
    // A strict full-set run needs the applied records' checksums anyway, so
    // fetch full records once and derive the name set from them; a plain
    // single-file run needs only that file's record, so one getByName is both
    // the applied-check and the checksum source; otherwise the cheaper covered
    // name query suffices.
    const strictBulk = fullSet && config.strict && !force;
    const appliedRecords = strictBulk ? await changelog.getApplied(db) : undefined;
    const appliedNames = new Set();
    let singleRecord = null;
    if (filename) {
      singleRecord = await changelog.getByName(db, filename);
      if (singleRecord?.status === 'applied') appliedNames.add(filename);
    }
    if (fullSet) {
      if (appliedRecords) {
        for (const record of appliedRecords) appliedNames.add(record.name);
      } else {
        for (const name of await changelog.getAppliedNames(db)) appliedNames.add(name);
      }
    }

    const targets = await this.#selectUpTargets(filename, options, appliedNames);
    // Pending files are the only bulk targets, so the per-target checksum
    // check below can never see an applied one. Verify them up front instead,
    // otherwise `up --strict` over a bulk run would police nothing.
    if (strictBulk) await this.#assertNoChecksumDrift(appliedRecords);
    // An ordered run is a step of the sequence, so its target must be a file
    // of the sequence: an existing dotfile, declaration file or helper module
    // next to the migrations is never one — and importing it would run its
    // top-level code. The name may come from a queue payload; a plain
    // single-file `up` keeps accepting any file it is pointed at.
    const sequence = ordered ? await this.#listMigrationFiles() : undefined;
    if (ordered && !sequence.includes(filename)) {
      throw new MigrationFileNotFoundError(
        'Not a migration of the sequence — a dotfile, a declaration file or an extension ' +
          'outside fileExtensions',
        { filename },
      );
    }
    // An already-applied target is exempt (unless forced): a duplicate job
    // for it must report the usual "skipped", not a failure.
    if (ordered && (force || !appliedNames.has(filename))) {
      await this.#assertUpNotBlocked(filename, appliedNames, sequence);
    }
    // The file the caller planned with (a queue job's checksum) must be the
    // one on this disk: a worker from an older deploy would otherwise apply an
    // older version of an edited pending file, and record its checksum.
    if (options.checksum !== undefined && (force || !appliedNames.has(filename))) {
      const actual = await computeChecksum(this.#filepath(filename));
      if (actual !== options.checksum) {
        throw new ChecksumMismatchError(
          `${filename} is not the file this run was planned with — this process has another ` +
            'version of it (roll workers out before the producers that enqueue)',
          { name: filename, expected: options.checksum, actual, planned: true },
        );
      }
    }
    this.#assertOrderIntact(targets, appliedNames);

    if (targets.length === 0) {
      logger.info('Nothing to migrate', this.#fields({ direction: 'up' }));
      return [];
    }

    const context = buildContext(this.#client, db, config.mongoose, signal);
    // Without --step every file in this run shares one batch. With --step each
    // applied file gets its own sequential batch (base, base+1, …) so a later
    // `down` can revert them individually. Only successful applies advance the
    // counter, so --step never leaves gaps. An explicit `batch` is a label the
    // caller chose — it may equal one already in use, which is how several
    // single-file runs end up as one rollback unit.
    const baseBatch = options.batch ?? (await this.#nextBatch());
    let appliedCount = 0;

    return this.#runSequence({
      direction: 'up',
      names: targets,
      context,
      signal,
      execute: async (name, index, results) => {
        const filepath = this.#filepath(name);
        const checksum = await computeChecksum(filepath);

        if (appliedNames.has(name)) {
          if (!force) {
            const existing = singleRecord ?? (await changelog.getByName(db, name));
            const mismatch = existing !== null && existing.checksum !== checksum;
            if (mismatch && config.strict) {
              throw new ChecksumMismatchError(`Checksum mismatch for ${name}`, {
                name,
                expected: existing?.checksum,
                actual: checksum,
              });
            }
            if (mismatch) {
              logger.warn(
                `⚠ Warning  Checksum mismatch: ${name}`,
                this.#fields({ migration: name, direction: 'up', expected: existing?.checksum }),
              );
            }
            logger.debug(
              `⏭ Skipped  ${name}`,
              this.#fields({ migration: name, direction: 'up', reason: 'already-applied' }),
            );
            this.#emit('migration:skipped', {
              migration: name,
              direction: 'up',
              reason: 'already-applied',
            });
            results.push({ file: name, status: 'skipped', reason: 'Already applied' });
            // No beforeEach fired for a skipped migration, so no afterEach owes
            // one either — the hooks stay paired.
            return 'skipped';
          }
          // force: fall through and re-run, ignoring applied state and checksum
          logger.warn(
            `⚠ Forcing   re-run of already-applied ${name}`,
            this.#fields({ migration: name, direction: 'up', forced: true }),
          );
        }

        // Before beforeEach: a migration that cannot run yet fires no hook and
        // leaves no failed trace.
        const waiting = await this.#requiresGuard(name, signal);
        if (waiting.length > 0) {
          const list = waiting.map((entry) => `${entry.migration} (${entry.status})`).join(', ');
          if ((options.onBackgroundPending ?? 'error') === 'stop') {
            logger.info(
              `⧗ Waiting   ${name} — requires ${list}`,
              this.#fields({ migration: name, direction: 'up', waitsFor: waiting.length }),
            );
            this.#emit('background:waiting', { migration: name, waitsFor: waiting });
            return 'stop';
          }
          throw new BackgroundPendingError(
            `${name} requires background migration(s) that have not completed: ${list}`,
            { migration: name, waitsFor: waiting },
          );
        }

        const batch = options.step ? baseBatch + appliedCount : baseBatch;
        await this.#executeMigration({
          name,
          direction: 'up',
          context,
          index,
          total: targets.length,
          results,
          batch,
          // No appliedAt: the changelog stamps it in server time, so the
          // revert-selection sorts are immune to this host's clock skew.
          onSuccess: (migration, elapsed, session) =>
            changelog.markApplied(
              db,
              {
                name,
                batch,
                status: 'applied',
                checksum,
                environment: this.#environment(),
                executedBy: safeUsername(),
                duration: elapsed,
                ...(this.#runId ? { runId: this.#runId } : {}),
                ...(migration.description ? { description: migration.description } : {}),
                ...(migration.kind === 'background' ? { kind: 'background' } : {}),
                ...actorFields(options),
              },
              session,
            ),
          // What a failed attempt's trace records besides the failure: the
          // version of the file that failed (a breaker compares it), and who
          // asked for the run.
          failureFields: { checksum, ...actorFields(options) },
        });
        appliedCount += 1;
        if (this.#config.backgroundInline && (await this.#peek(name))?.kind === 'background') {
          await this.#runInline(name, signal);
        }
        return 'done';
      },
    });
  }

  /**
   * Verify that every applied migration still matches the file on disk. Used by
   * `up --strict` on a bulk run, where the per-target loop only ever sees
   * pending files and so would never notice drift in the applied ones.
   * Takes the already-fetched applied records — no extra round trips — and
   * hashes with bounded concurrency, since this runs while holding the lock.
   */
  async #assertNoChecksumDrift(records) {
    await mapLimit(records, FS_CONCURRENCY, async (record) => {
      const filepath = this.#filepath(record.name);
      let actual;
      try {
        // Through the instance cache: a long-lived process running strict ups
        // repeatedly must not re-hash the whole applied history every time —
        // the same mtime+size trust status() already applies to this verdict.
        actual = await this.#cachedChecksum(filepath);
      } catch (error) {
        // A deleted file has no checksum to compare; status() reports it as
        // missing, which is a separate concern from drift. Hashing directly
        // and catching ENOENT beats an access() probe: half the syscalls and
        // no TOCTOU window.
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (record.checksum !== actual) {
        throw new ChecksumMismatchError(`Checksum mismatch for ${record.name}`, {
          name: record.name,
          expected: record.checksum,
          actual,
        });
      }
    });
  }

  /**
   * Invoke a user lifecycle hook. A throwing hook becomes a HookFailedError so
   * it can never surface as an untyped Error, and the hook that failed is named.
   */
  async #runHook(hook, hookName, args) {
    if (!hook) return;
    try {
      await hook(...args);
    } catch (error) {
      throw new HookFailedError(
        `The ${hookName} hook failed`,
        { hook: hookName, cause: errorText(error) },
        { cause: error },
      );
    }
  }

  /** Rollback the last batch, a specific batch, a specific file, or the last N steps */
  async down(filename, options = {}) {
    assertDownOptions(filename, options);
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      await this.connect();
      return this.#withLock(options, { command: 'down', direction: 'down' }, (signal) =>
        this.#runDown(filename, options, signal),
      );
    });
  }

  /**
   * Resolve which applied records a `down` (or its dry-run) targets: a named
   * file, the last N steps, everything after `--to`, or a batch. The single
   * source of truth for that selection — `#runDown` executes it and `dryRun`
   * previews it, so the two can never disagree on what would be reverted.
   *
   * Returns `{ records, preserveOrder }`; when `preserveOrder` is true the
   * records are already in revert order (newest applied first) and must not be
   * re-sorted by filename. Throws IrreversibleMigrationError for
   * migrate-mongo-imported records — in previews as much as in real rollbacks.
   */
  async #selectDownTargets(filename, options = {}) {
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();

    let records;
    let preserveOrder = false;
    if (filename) {
      const record = await changelog.getByName(db, filename);
      if (!record || record.status !== 'applied') {
        throw new NotAppliedError('Migration is not applied', { filename });
      }
      records = [record];
    } else if (options.steps !== undefined) {
      // Revert the last N applied migrations, newest first, ignoring batches.
      // Server-side sort+limit on the status_appliedAt_name index — never the
      // whole applied history transferred and re-sorted in JS to slice N.
      records = await changelog.getLastAppliedN(db, options.steps);
      preserveOrder = true;
    } else if (options.to !== undefined) {
      // Roll the database back *to* that point: everything applied after the
      // named migration goes, the named one stays. Exclusive, so `up --to X`
      // followed by `down --to X` is a round trip back to the same state.
      // Validate the target first, then fetch only what follows it — both
      // covered by indexes instead of filtering the full history client-side.
      const targetRecord = await changelog.getByName(db, options.to);
      if (!targetRecord || targetRecord.status !== 'applied') {
        throw new NotAppliedError('Migration is not applied', { to: options.to });
      }
      records = await changelog.getAppliedAfter(db, options.to);
    } else {
      const batch = options.batch ?? (await changelog.getLastBatch(db));
      if (batch === null) {
        records = [];
      } else {
        const byBatch = await changelog.getByBatch(db, batch);
        records = [];
        for (const record of byBatch) {
          if (record.status === 'applied') records.push(record);
        }
      }
    }

    // Preflight, before running or writing anything: migrate-mongo-imported
    // records are forward-only. Refuse the whole rollback up front with a clear
    // reason so the changelog and collection are never left half-reverted.
    if (records.length > 0) this.#assertReversible(records);
    return { records, preserveOrder };
  }

  async #runDown(filename, options = {}, signal) {
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    const { records: toRevert, preserveOrder } = await this.#selectDownTargets(filename, options);

    if (toRevert.length === 0) {
      logger.info('Nothing to rollback', this.#fields({ direction: 'down' }));
      return [];
    }
    if (filename && options.ordered === true) await this.#assertDownNotBlocked(toRevert[0]);

    const names = revertOrder(toRevert, preserveOrder);

    // The signal must reach the rollback context too: a long-running down()
    // under SIGTERM or a lost lock is exactly the case ctx.signal exists for.
    const context = buildContext(this.#client, db, config.mongoose, signal);

    return this.#runSequence({
      direction: 'down',
      names,
      context,
      signal,
      execute: async (name, index, results) => {
        await this.#executeMigration({
          name,
          direction: 'down',
          context,
          index,
          total: names.length,
          results,
          onSuccess: async (_migration, _elapsed, session) => {
            const result = await changelog.markReverted(db, name, session, pickActor(options));
            // Under --no-lock or onLockLost:'warn' a peer may have flipped the
            // record first: the down() body already ran against the data, but
            // the changelog still claims the migration is applied. Silence
            // here would hide exactly that divergence.
            if (result.matchedCount === 0) {
              this.#logger.warn(
                `⚠ Warning  Changelog record for ${name} was not 'applied' — revert not recorded`,
                this.#fields({
                  migration: name,
                  direction: 'down',
                  event: 'changelog:revert-miss',
                }),
              );
            }
          },
        });
        return 'done';
      },
    });
  }

  /**
   * Refuse rollback of any forward-only record — one whose `origin` marks it
   * as adopted rather than executed by migronaut. Imported records use
   * migrate-mongo's positional `up(db, client)` signature, which migronaut
   * cannot invoke safely; baselined records were never executed by migronaut
   * at all, so their `down()` would revert work the tool has no record of
   * performing. Throws before any migration runs or the changelog is touched.
   */
  #assertReversible(records) {
    const names = [];
    for (const record of records) {
      if (record.origin === 'migrate-mongo' || record.origin === 'baseline') {
        names.push(record.name);
      }
    }
    if (names.length === 0) {
      return;
    }
    this.#logger.error(
      `✖ Cannot roll back ${names.length} forward-only migration(s): ${names.join(', ')}`,
    );
    this.#logger.debug(
      'These were adopted via `migronaut import` or `migronaut baseline` (forward-only), not ' +
        'executed by migronaut. Revert them manually, or re-apply and revert them natively.',
    );
    throw new IrreversibleMigrationError(
      `Cannot roll back forward-only migration(s): ${names.join(', ')}`,
      { names },
    );
  }

  /**
   * Rollback then re-apply: the last applied migration, or a specific file.
   *
   * Both directions run under a single lock. Releasing between them would let
   * another process slip in while the migration is reverted — and a crash in
   * that gap would leave the database in the rolled-back state with no lock to
   * show for it.
   */
  async redo(filename, options = {}) {
    assertRedoOptions(filename, options);
    const actor = pickActor(options);
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      await this.connect();
      const changelog = this.#requireChangelog();

      return this.#withLock(options, { command: 'redo' }, async (signal) => {
        // Resolved *inside* the lock: picking the newest applied migration before
        // acquiring it races a peer instance — this redo would then revert and
        // re-apply a migration that is no longer the newest.
        let target = filename;
        if (!target) {
          // A server-side top-1 sort+limit — not the whole applied history sorted
          // in memory just to pick its newest element.
          const newest = await changelog.getNewestApplied(this.#requireDb());
          if (!newest) {
            this.#logger.info('Nothing to redo', this.#fields({ command: 'redo' }));
            return [];
          }
          target = newest.name;
        }

        const downResults = await this.#runDown(target, actor, signal);
        let upResults;
        try {
          upResults = await this.#runUp(target, actor, signal);
        } catch (error) {
          // The revert already happened — after a failed re-apply that is the
          // single most important fact, so the down rows must survive into the
          // error a `--json` consumer sees.
          if (error instanceof MigronautError && error.context) {
            const existing = Array.isArray(error.context.results) ? error.context.results : [];
            this.#attachResults(error, [...downResults, ...existing]);
          }
          throw error;
        }
        return [...downResults, ...upResults];
      });
    });
  }

  /** Preview what would run — never writes to the database */
  async dryRun(direction, filename, options = {}) {
    assertDryRunOptions(filename, options);
    await this.#ensureConfig();
    await this.connect();
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    let names;
    const recordByName = new Map();
    if (direction === 'up') {
      const applied = new Set();
      if (filename) {
        // Only the named file's record can matter for the preview row — an
        // applied one renders as applied instead of pending.
        const record = await changelog.getByName(db, filename);
        if (record?.status === 'applied') {
          recordByName.set(filename, record);
          applied.add(filename);
        }
      } else {
        // Names only: a bulk preview's rows are pending files, which have no
        // record to render — fetching the full applied documents would move
        // the whole history over the wire just to derive this Set.
        for (const name of await changelog.getAppliedNames(db)) applied.add(name);
      }
      // The same selection (and preflight) the real `up` executes, so a
      // preview never invents a pending row for a file that does not exist.
      names = await this.#selectUpTargets(filename, options, applied);
      // …and the same order policy: under onOutOfOrder: 'error' the real run
      // refuses, so the preview must too instead of listing rows it would
      // never apply. A single file is exempt, exactly as in `up`.
      if (!filename) this.#assertOrderIntact(names, applied);
    } else {
      // The same selection the real `down` executes — including the
      // irreversible-import refusal, so a preview can never show a rollback
      // the real run would reject.
      const { records, preserveOrder } = await this.#selectDownTargets(filename, options);
      for (const record of records) {
        recordByName.set(record.name, record);
        // The refusal a real `down` of a one-way background migration meets.
        if (record.kind === 'background') await this.#assertBackgroundRevertible(record.name);
      }
      names = revertOrder(records, preserveOrder);
    }

    const rows = await mapLimit(names, FS_CONCURRENCY, async (name) => {
      const row = await this.#buildStatusRow(name, recordByName.get(name));
      // What an `up` would apply, by content: a caller that applies the rows
      // later (a queue job) can insist on exactly this version of the file.
      if (direction === 'up' && !row.invalid) {
        row.checksum = await this.#cachedChecksum(this.#filepath(name));
        await this.#annotateBackground(row, name);
      }
      return row;
    });
    logger.info(
      `◎ Dry-run  Would ${direction === 'up' ? 'apply' : 'revert'}: ${rows.length}`,
      this.#fields({ direction, count: rows.length, dryRun: true }),
    );
    // A converge plan is only meaningful against the database the migrations
    // leave behind — previewing it now would compare with the wrong state.
    if (
      direction === 'up' &&
      !filename &&
      options.to === undefined &&
      (await this.convergesAfterUp())
    ) {
      logger.info(
        '◎ Dry-run  Converge after up is not previewed — it is planned against the database ' +
          'the migrations leave behind (`converge --dry-run` once they are applied)',
        this.#fields({ direction, dryRun: true }),
      );
    }
    return rows;
  }

  /**
   * A preview row's background facts: a background file, what it requires,
   * and what of that is not done yet — read without writing anything. A file
   * that does not load is left for the real run to report.
   */
  async #annotateBackground(row, name) {
    let loaded;
    try {
      loaded = await this.#peek(name);
    } catch {
      return;
    }
    if (loaded === null) return;
    if (loaded.kind === 'background') {
      row.background = true;
      row.kind = 'background';
    }
    const requires = loaded.requires ?? [];
    if (requires.length === 0) return;
    row.requires = requires;
    const waiting = await this.#unsatisfied(requires, { reopen: false }).catch(() => []);
    if (waiting.length > 0) row.waitsFor = waiting.map((entry) => entry.migration);
  }

  /** Full migration status for all known files and records */
  async status(options = {}) {
    await this.#ensureConfig();
    await this.connect();
    const records = await this.#requireChangelog().getAll(this.#requireDb());
    const recordByName = new Map();
    for (const record of records) recordByName.set(record.name, record);

    const names = new Set(recordByName.keys());
    for (const file of await this.#listMigrationFiles()) names.add(file);
    const sortedNames = [...names].sort();
    // Each row may read and hash a file; unbounded fan-out over thousands of
    // migrations exhausts the descriptor limit.
    const rows = await mapLimit(sortedNames, FS_CONCURRENCY, (name) =>
      this.#buildStatusRow(name, recordByName.get(name), options),
    );
    // Mark late arrivals: a not-yet-applied row sorting before the newest
    // applied name will run after migrations authored later — the same signal
    // #assertOrderIntact acts on, surfaced here as data.
    const applied = [];
    for (const row of rows) {
      if (row.status === 'applied') applied.push(row.file);
    }
    const newestApplied = newestOf(applied);
    if (newestApplied !== '') {
      for (const row of rows) {
        if (row.status !== 'applied' && row.file < newestApplied) row.outOfOrder = true;
      }
    }
    return rows;
  }

  /**
   * Read-only health check of the setup — see {@link runAudit} in audit.js for
   * the checks themselves; this only wires in the kit's capabilities.
   */
  async audit() {
    return runAudit({
      ensureConfig: () => this.#ensureConfig(),
      connect: () => this.connect(),
      getDb: () => this.#requireDb(),
      inspectLock: () => this.#buildLock().inspect(),
      status: () => this.status(),
      definitions: () => this.#resolveCollections(),
      background: async () => {
        const deps = this.#backgroundDeps();
        return auditFindings({
          ...deps,
          checksumOf: (name) => computeChecksum(this.#filepath(name)),
          backgroundRecords: () =>
            this.#requireDb()
              .collection(this.#config.migrationsCollection)
              .find({ kind: 'background', status: 'applied' }, { projection: { name: 1 } })
              .toArray(),
        });
      },
    });
  }

  /**
   * Filtered list of migrations. `checksums: false` skips hashing the applied
   * files (`checksumOk` stays null) — for a caller that only needs names and
   * dates, where a full re-hash of the history would be the whole cost.
   */
  async list(filter = 'all', options = {}) {
    assertListOptions(filter, options);
    if (filter === 'pending') {
      return this.#listPending();
    }
    const rows = await this.status(options.checksums === false ? { checksums: false } : {});
    if (filter === 'all') {
      return rows;
    }
    const filtered = [];
    for (const row of rows) {
      if (row.status === filter) filtered.push(row);
    }
    return filtered;
  }

  /**
   * Pending migrations, without touching the applied ones.
   *
   * Going through `status()` would read and SHA-256 every applied file only to
   * discard those rows — turning `pendingMigrations()`, which exists to be a
   * cheap readiness probe, into a full re-hash of the migration history on
   * every health check. A pending row has no record, so `checksumOk` is always
   * null and there is nothing to hash.
   */
  async #listPending() {
    await this.#ensureConfig();
    await this.connect();
    const applied = new Set(await this.#requireChangelog().getAppliedNames(this.#requireDb()));
    const rows = [];
    for (const file of pendingIn(await this.#listMigrationFiles(), applied)) {
      rows.push({
        file,
        status: 'pending',
        batch: null,
        appliedAt: null,
        duration: null,
        checksumOk: null,
      });
    }
    return rows;
  }

  /**
   * Checksum of `filepath`, reusing the cached digest while `{mtimeMs, size}`
   * are unchanged. status()/audit()/list() re-hash every applied file on every
   * call otherwise — thousands of reads + SHA-256 per health check in a
   * long-lived process. Throws ENOENT for a missing file (callers decide what
   * that means).
   */
  async #cachedChecksum(filepath) {
    const stat = await fs.stat(filepath);
    const cached = this.#checksumCache.get(filepath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.checksum;
    }
    const checksum = await computeChecksum(filepath);
    this.#checksumCache.set(filepath, { mtimeMs: stat.mtimeMs, size: stat.size, checksum });
    return checksum;
  }

  /**
   * The audit-trail fields a StatusRow surfaces from its record. The changelog
   * deliberately preserves these (who ran it, from which run, was it ever
   * reverted) — discarding them here made the questions the append-mostly
   * design exists to answer unanswerable from any read surface.
   */
  #auditFields(record) {
    if (!record) return {};
    return {
      ...(record.executedBy ? { executedBy: record.executedBy } : {}),
      ...(record.environment ? { environment: record.environment } : {}),
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.revertedAt ? { revertedAt: record.revertedAt } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      ...(record.status === 'failed' && record.error ? { error: record.error } : {}),
      ...(record.status === 'failed' && record.failedAt ? { failedAt: record.failedAt } : {}),
      // The version of the file that failed — what tells "failed and unchanged since" apart.
      ...(record.status === 'failed' && record.checksum ? { failedChecksum: record.checksum } : {}),
      ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.revertRequestedBy ? { revertRequestedBy: record.revertRequestedBy } : {}),
      ...(record.revertReason ? { revertReason: record.revertReason } : {}),
    };
  }

  /**
   * A row's rendered status: 'applied', 'failed' (a recorded failed attempt —
   * the file still counts as pending for every run path, but the operator
   * deserves to see the failure), or 'pending' (including reverted history —
   * the `revertedAt` field carries that story).
   */
  static #rowStatus(record) {
    if (record?.status === 'applied') return 'applied';
    if (record?.status === 'failed') return 'failed';
    return 'pending';
  }

  /** Build a StatusRow for a migration, verifying checksum when possible */
  async #buildStatusRow(name, record, { checksums = true } = {}) {
    const isApplied = record?.status === 'applied';
    const status = MigratorKit.#rowStatus(record);
    let filepath;
    try {
      filepath = this.#filepath(name);
    } catch {
      // A legacy or tampered changelog record whose name is not a plain
      // filename must not take down the whole report — mark the one row
      // invalid and keep going.
      return {
        file: String(name),
        status,
        batch: isApplied && record ? record.batch : null,
        appliedAt: isApplied && record ? record.appliedAt : null,
        duration: isApplied && record ? record.duration : null,
        checksumOk: isApplied ? false : null,
        invalid: true,
        ...this.#auditFields(record),
      };
    }
    // Hash (via the cache) and treat ENOENT as "missing" — the old
    // access()-first probe cost an extra syscall per row, for pending rows
    // whose result was never even used.
    let checksumOk = null;
    if (isApplied && record && checksums) {
      try {
        checksumOk = (await this.#cachedChecksum(filepath)) === record.checksum;
      } catch (error) {
        // A missing file has nothing to verify — checksumOk stays null.
        if (error.code !== 'ENOENT') throw error;
      }
    }

    return {
      file: name,
      status,
      batch: isApplied && record ? record.batch : null,
      appliedAt: isApplied && record ? record.appliedAt : null,
      duration: isApplied && record ? record.duration : null,
      checksumOk,
      ...(record?.description ? { description: record.description } : {}),
      ...(record?.kind === 'background' ? { kind: 'background' } : {}),
      ...this.#auditFields(record),
    };
  }

  /**
   * Create a new migration file and return its absolute path.
   *
   * Resolved leniently: writing a file needs no database, so a config whose
   * factory fetches a connection from a secret manager must not make `create`
   * fail (or reach the network at all) when that manager is unreachable.
   */
  async create(name, options = {}) {
    const config = await this.#ensureConfig(false, true);
    const dir = this.#migrationsPath();
    await fs.mkdir(dir, { recursive: true });
    const templatePath = options.template ?? config.templatePath;
    const js = options.js ?? config.createExtension === 'js';
    const filepath = await createMigrationFile({
      dir,
      name,
      sequential: config.sequential,
      js,
      fileExtensions: config.fileExtensions,
      ...(templatePath ? { templatePath } : {}),
      ...(options.background ? { background: true } : {}),
    });
    this.#logger.info(
      `✔ Created  ${path.basename(filepath)}`,
      this.#fields({ command: 'create', file: path.basename(filepath) }),
    );
    return filepath;
  }

  /** Create a migronaut config file in the working directory and return its path */
  async init(options = {}) {
    const values = {};
    if (this.#partialConfig.uri) values.uri = this.#partialConfig.uri;
    if (this.#partialConfig.dbName) values.dbName = this.#partialConfig.dbName;
    if (this.#partialConfig.migrationsDir) values.migrationsDir = this.#partialConfig.migrationsDir;

    if (values.uri && maskUriCredentials(values.uri).hasCredentials) {
      this.#logger.warn(
        '⚠ The URI contains credentials — the password was masked in the generated file. ' +
          'Provide the real value via MIGRONAUT_URI, a gitignored .env, or --secret-provider.',
      );
    }

    const filepath = await createConfigFile({
      dir: this.#cwd ?? process.cwd(),
      format: options.format ?? 'js',
      force: options.force ?? false,
      values,
      ...(options.secretProvider ? { secretProvider: true } : {}),
    });
    this.#logger.info(
      `✔ Created  ${path.basename(filepath)}`,
      this.#fields({ command: 'init', file: path.basename(filepath) }),
    );
    return filepath;
  }

  /**
   * Adopt an existing database with no prior migration tool: mark migration
   * files on disk as applied (checksum from disk, one shared batch,
   * `origin: 'baseline'`) without executing anything — see
   * {@link runBaseline} in baseline.js for the mechanics. Forward-only, like
   * import: `down`/`redo` refuse baselined records. Runs under the migration
   * lock — it writes the changelog, and two concurrent baselines (or a
   * baseline racing an `up`) must serialize like any other mutation.
   */
  async baseline(options = {}) {
    assertFilename(options.to);
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      await this.connect();
      return this.#withLock(options, { command: 'baseline' }, (signal) =>
        runBaseline(
          {
            db: this.#requireDb(),
            changelog: this.#requireChangelog(),
            logger: this.#logger,
            fields: (extra) => this.#fields(extra),
            filepath: (name) => this.#filepath(name),
            listMigrationFiles: () => this.#listMigrationFiles(),
            nextBatch: () => this.#nextBatch(),
            truncateAtTarget,
            environment: () => this.#environment(),
            executedBy: () => safeUsername(),
            runId: () => this.#runId,
            assertNotAborted: (abortSignal) => this.#assertNotAborted(abortSignal),
          },
          options,
          signal,
        ),
      );
    });
  }

  /**
   * Adopt an existing migrate-mongo `changelog` collection by mapping its
   * records into our schema and writing them to `migrationsCollection`. The
   * source collection is never modified. Forward-only: it records applied
   * history so `up` skips it correctly — it does not adapt legacy migration
   * file signatures, so `down`/`redo` on imported files is unsupported.
   */
  async import(options = {}) {
    assertImportOptions(options);
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      await this.connect();
      // See runImport in import-runner.js for the mechanics; this wires in the
      // kit's capabilities, including the abort signal for long imports.
      return this.#withLock(options, { command: 'import' }, (signal) =>
        runImport(
          {
            config: this.#config,
            db: this.#requireDb(),
            changelog: this.#requireChangelog(),
            logger: this.#logger,
            fields: (extra) => this.#fields(extra),
            filepath: (name) => this.#filepath(name),
            assertNotAborted: (abortSignal) => this.#assertNotAborted(abortSignal),
          },
          options,
          signal,
        ),
      );
    });
  }

  /**
   * Bring the declared collections (`collections`, `collectionsDir`) to their
   * declared indexes and validators — see {@link runConverge} in converge.js
   * for the mechanics. Stateless: the live database is read and compared on
   * every call. What a run changed is appended to the converge history
   * (`convergeHistory()`), which no run reads back.
   *
   * `dryRun` plans without writing — no lock, no events. A real run holds the
   * migration lock, like every other mutation. `prune` drops undeclared
   * indexes in collections whose definition does not decide for itself.
   * `ordered` refuses while any migration is still pending — checked under
   * the lock, which is what lets a queue run it as the tail of a deploy.
   * `rebuildUnique` lets a rebuild drop a unique index it builds back; without
   * it such a rebuild is a conflict (the constraint would be gone until the
   * build ends), which is why the after-up hook and a queue job never pass it.
   */
  async converge(options = {}) {
    assertConvergeOptions(options);
    const actor = pickActor(options);
    const empty = (dryRun) => ({ dryRun, changed: 0, inSync: true, collections: [] });
    if (options.dryRun) {
      await this.#ensureConfig();
      const definitions = await this.#resolveCollections();
      if (definitions.length === 0) return empty(true);
      await this.connect();
      return runConverge(
        this.#convergeDeps(),
        {
          definitions,
          prune: options.prune,
          rebuildUnique: options.rebuildUnique,
          dryRun: true,
          search: this.#convergeSearchOptions(),
        },
        undefined,
      );
    }
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      // Before connecting or locking: a broken definition file must not cost
      // a round trip, and must not hold the lock while it is reported.
      const definitions = await this.#resolveCollections();
      if (definitions.length === 0) {
        this.#logger.info(
          'No collections declared — set collections or collectionsDir',
          this.#fields({ command: 'converge' }),
        );
        return empty(false);
      }
      await this.connect();
      return this.#withLock(options, { command: 'converge' }, async (signal, lock) => {
        if (options.ordered) await this.#assertNothingPending();
        return runConverge(
          this.#convergeDeps(lock),
          {
            definitions,
            prune: options.prune,
            rebuildUnique: options.rebuildUnique,
            search: this.#convergeSearchOptions(options),
            ...actor,
          },
          signal,
        );
      });
    });
  }

  /**
   * Whether a bulk `up` on this kit ends by converging: `convergeAfterUp` is
   * on and there is something declared to converge. Resolves the config; does
   * not connect, and does not load definition files. A layer above the kit
   * (the queue adapter) uses it to mirror that behaviour across single-file
   * jobs, where the kit's own after-up hook never fires.
   */
  async convergesAfterUp() {
    const config = await this.#ensureConfig();
    return (
      config.convergeAfterUp === true &&
      ((config.collections?.length ?? 0) > 0 || config.collectionsDir !== undefined)
    );
  }

  /** Every declared collection, normalized — the config key first, then `collectionsDir` */
  async #resolveCollections() {
    const config = this.#config;
    return resolveDefinitions({
      inline: config.collections,
      ...(config.collectionsDir !== undefined
        ? { dir: path.resolve(this.#cwd ?? process.cwd(), config.collectionsDir) }
        : {}),
      extensions: config.fileExtensions,
      reload: config.reloadMigrations,
      reserved: this.#bookkeepingNames(),
    });
  }

  /** Every collection migronaut keeps its own records in — never a declared one */
  #bookkeepingNames() {
    const config = this.#config;
    const names = [
      config.migrationsCollection,
      config.lockCollection,
      config.convergeLogCollection,
    ];
    if (config.backgroundCollection !== undefined) {
      const background = backgroundCollectionNames(config.backgroundCollection);
      names.push(background.state, background.partitions, background.watch);
    }
    return names;
  }

  // ─── Background migrations ──────────────────────────────────────────────────

  /** The store of background migration state, over this kit's database */
  #backgroundStore() {
    this.#backgroundStoreInstance ??= new BackgroundStore(
      this.#requireDb(),
      this.#config.backgroundCollection,
    );
    return this.#backgroundStoreInstance;
  }

  /**
   * A background migration file as the run loop sees a migration: its `up`
   * registers the background migration (the documents are rewritten later,
   * in partitions, without the migration lock); its `down` sets off the way
   * back — or, when it has none, withdraws it while nothing was rewritten yet.
   * Everything around them is the regular path: hooks, span, transaction,
   * changelog (with `kind: 'background'`).
   */
  async #asBackground(name, loaded, direction) {
    // Validated before it runs: an invalid file is reported as itself, not as
    // a failed execution — and nothing is written.
    const { spec } = await this.#backgroundSpec(name, loaded);
    if (direction === 'up') await this.#assertRequiresAreBackground(name, loaded.requires ?? []);
    const migration = {
      kind: 'background',
      ...(loaded.description !== undefined ? { description: loaded.description } : {}),
      up: async (ctx) => {
        migration.registered = await this.#registerBackground(name, loaded, spec, ctx.session);
      },
      down: async (ctx) => {
        migration.registered = await this.#revertBackground(name, spec, ctx.session);
      },
    };
    return migration;
  }

  /**
   * The spec of a background migration file, resolved against the
   * collection's declared versioning (when it has one).
   */
  async #backgroundSpec(name, loaded) {
    const raw = loaded.background;
    let versioning;
    const collection = raw?.collection;
    if (typeof collection === 'string') {
      if (this.#bookkeepingNames().includes(collection)) {
        throw new MigrationInvalidExportError(
          `Background migration ${name} targets "${collection}", one of migronaut's own collections`,
          { name, collection },
        );
      }
      const config = this.#config;
      if (config.collections !== undefined || config.collectionsDir !== undefined) {
        const definitions = config.reloadMigrations
          ? await this.#resolveCollections()
          : (this.#backgroundDefinitions ??= await this.#resolveCollections());
        for (const definition of definitions) {
          if (definition.name === collection) {
            versioning = definition.versioning;
            break;
          }
        }
      }
    }
    return resolveBackgroundSpec(raw, { name, versioning });
  }

  /**
   * What a file's `requires` names must be: background migration files of
   * the sequence. The order is the loader's to check (each sorts before the
   * file); whether they are done is the caller's.
   */
  async #assertRequiresAreBackground(name, requires) {
    if (requires.length === 0) return;
    const sequence = new Set(await this.#listMigrationFiles());
    for (const required of requires) {
      if (!sequence.has(required)) {
        throw new MigrationInvalidExportError(
          `${name} requires ${required}, which is not a migration of the sequence`,
          { name, requires: required },
        );
      }
      const loaded = await loadMigrationFile(this.#filepath(required), {
        reload: this.#config.reloadMigrations,
        allowBackground: true,
      });
      if (loaded.kind !== 'background') {
        throw new MigrationInvalidExportError(
          `${name} requires ${required}, which is not a background migration — requires ` +
            'waits for background migrations only (regular ones already run in order)',
          { name, requires: required },
        );
      }
    }
  }

  /** The required background migrations not completed yet, in order */
  async #waitsFor(requires) {
    const store = this.#backgroundStore();
    const waitsFor = [];
    for (const required of requires) {
      if ((await store.get(required))?.status !== 'completed') waitsFor.push(required);
    }
    return waitsFor;
  }

  /** Register a background migration (again): `blocked` while what it requires is not done */
  async #registerBackground(name, loaded, spec, session) {
    const requires = loaded.requires ?? [];
    const waitsFor = await this.#waitsFor(requires);
    const status = waitsFor.length > 0 ? 'blocked' : 'pending';
    await this.#backgroundStore().register(
      name,
      {
        status,
        mode: spec.mode,
        direction: 'forward',
        spec,
        checksum: await computeChecksum(this.#filepath(name)),
        requires,
        waitsFor,
        ...(spec.collection !== undefined ? { collection: spec.collection } : {}),
        ...(loaded.description !== undefined ? { description: loaded.description } : {}),
      },
      { session },
    );
    return { status, direction: 'forward', ...(waitsFor.length > 0 ? { waitsFor } : {}) };
  }

  /** What a `down` of a background migration would refuse — for a preview to refuse it too */
  async #assertBackgroundRevertible(name) {
    const loaded = await this.#peek(name);
    if (loaded === null || loaded.kind !== 'background') return;
    const { spec } = await this.#backgroundSpec(name, loaded);
    if (spec.reversible) return;
    if ((await this.#backgroundStore().migratedSoFar(name)) > 0) {
      throw new IrreversibleMigrationError(
        `Background migration ${name} has already rewritten documents and declares no revert — ` +
          'write a background migration back instead',
        { names: [name] },
      );
    }
  }

  /**
   * `down` of a background migration: with a `revert`, the forward one is
   * replaced by the way back (registered to run like any other); without one,
   * it is withdrawn — but only while no document has been rewritten, since
   * nothing could put them back.
   */
  async #revertBackground(name, spec, session) {
    const store = this.#backgroundStore();
    if (spec.reversible) {
      await store.register(
        name,
        {
          status: 'pending',
          mode: spec.mode,
          direction: 'revert',
          spec,
          checksum: await computeChecksum(this.#filepath(name)),
          requires: [],
          waitsFor: [],
          ...(spec.collection !== undefined ? { collection: spec.collection } : {}),
        },
        { session },
      );
      return { status: 'pending', direction: 'revert' };
    }
    await this.#assertBackgroundRevertible(name);
    await store.remove(name, { session });
    return { status: 'withdrawn', direction: 'forward' };
  }
  /** What background.js runs with — `owner` names a lane: its lease's owner, its events' runId */
  #backgroundDeps(owner) {
    const config = this.#config;
    const db = this.#requireDb();
    const stamp = owner ? { runId: owner } : {};
    return {
      db,
      client: this.#client,
      store: this.#backgroundStore(),
      logger: this.#logger,
      fields: (extra) => ({ ...stamp, ...extra }),
      emit: (event, payload) => this.#emit(event, { ...stamp, ...payload }),
      lockFor: (name) =>
        new MigrationLock(db, config.lockCollection, config.lockTTLSeconds, {
          id: `background:${name}`,
          label: 'background coordinator lock',
        }),
      load: (name) => this.#loadBackground(name),
      ttlMs: config.lockTTLSeconds * 1000,
      owner: () => owner,
      warned: this.#backgroundWarned,
      adaptiveCache: this.#adaptiveCache,
      telemetry: this.#telemetry,
      // The third wrap site: a span per lease held (slice) and per coordinator
      // step — each opened only once the lease or the lock is held.
      span: (kind, name, fn) =>
        this.#telemetry.wrap(
          kind === 'slice' ? SPANS.BACKGROUND_SLICE : SPANS.BACKGROUND_COORDINATE,
          { [ATTRIBUTES.BACKGROUND_NAME]: name },
          async (span) => {
            const result = await fn();
            span.set({ [ATTRIBUTES.BACKGROUND_OUTCOME]: result?.outcome ?? result?.next });
            return result;
          },
        ),
      onCompleted: (name) => this.#unblockDependents(name),
      topology: () => (this.#topology ??= readServer(db).then((server) => server.topology)),
      versioningOf: (collection) => this.#versioningOf(collection),
    };
  }

  /** A declared collection's versioning, or `undefined` — for the drift watch */
  async #versioningOf(collection) {
    const config = this.#config;
    if (config.collections === undefined && config.collectionsDir === undefined) return undefined;
    try {
      const definitions = config.reloadMigrations
        ? await this.#resolveCollections()
        : (this.#backgroundDefinitions ??= await this.#resolveCollections());
      for (const definition of definitions) {
        if (definition.name === collection) return definition.versioning;
      }
    } catch {
      // Definitions that do not load are converge's to report.
    }
    return undefined;
  }

  /**
   * The drift watch, once: old-shape documents that appeared after a
   * background migration completed are found with one indexed probe each,
   * and reopen it (`onDrift: 'reopen'`, the `backgroundOnDrift` default) or
   * are only reported (`'report'`). `collections` narrows it.
   * @experimental
   */
  async verifyBackground(options = {}) {
    await this.#backgroundReady();
    const onDrift = options.onDrift ?? this.#config.backgroundOnDrift;
    if (onDrift !== 'reopen' && onDrift !== 'report') {
      throw new ConfigInvalidError("onDrift must be 'reopen' or 'report'", { onDrift });
    }
    return verifyDrift(this.#backgroundDeps(), {
      onDrift,
      ...(options.collections !== undefined ? { collections: options.collections } : {}),
    });
  }

  /** A background migration file, loaded and resolved: `{ spec, fns, checksum }` */
  async #loadBackground(name) {
    assertMigrationName(name);
    const filepath = this.#filepath(name);
    const loaded = await loadMigrationFile(filepath, {
      reload: this.#config.reloadMigrations,
      allowBackground: true,
    });
    if (loaded.kind !== 'background') {
      throw new MigrationInvalidExportError(`${name} is not a background migration`, { name });
    }
    const { spec, fns } = await this.#backgroundSpec(name, loaded);
    return { spec, fns, checksum: await computeChecksum(filepath) };
  }

  /** After one completes: the blocked ones that required it, unblocked if nothing else holds them */
  async #unblockDependents(name) {
    const store = this.#backgroundStore();
    const deps = this.#backgroundDeps();
    for (const state of await store.list({ requires: name, status: 'blocked' })) {
      await tryUnblock(deps, state);
    }
  }

  /**
   * A migration module read ahead of its run — for its `requires` and its
   * kind — cached by checksum, so a long-lived kit imports an edited file
   * again and an unchanged one never twice. `null` when it cannot be read.
   */
  async #peek(name) {
    let checksum;
    try {
      checksum = await this.#cachedChecksum(this.#filepath(name));
    } catch {
      return null;
    }
    const cached = this.#moduleCache.get(name);
    if (cached?.checksum === checksum) return cached.loaded;
    const loaded = await loadMigrationFile(this.#filepath(name), {
      reload: this.#config.reloadMigrations,
      allowBackground: true,
    });
    this.#moduleCache.set(name, { checksum, loaded });
    return loaded;
  }

  /**
   * Whether a completed background migration's collection is still clean:
   * one indexed `findOne` for a document in the old shape. A step migration
   * cannot be probed — its state is all there is.
   */
  async #stillDirty(state) {
    const spec = state.spec;
    if (!spec || spec.mode !== 'declarative' || state.direction === 'revert') return false;
    const badIds = state.badIds ?? [];
    const match = matchOf(spec, 'forward');
    const found = await this.#requireDb()
      .collection(spec.collection)
      .findOne(badIds.length > 0 ? { $and: [match, { _id: { $nin: badIds } }] } : match, {
        projection: { _id: 1 },
        readPreference: 'primary',
      });
    return found !== null;
  }

  /**
   * The background migrations of `requires` not done yet:
   * `[{ migration, status }]`. A `baseline` or imported record counts as
   * done (that history predates migronaut). A completed one is checked
   * against its data — and, unless this is only a preview, reopened when old
   * shapes reappeared.
   */
  async #unsatisfied(requires, { reopen = true } = {}) {
    const store = this.#backgroundStore();
    const changelog = this.#requireChangelog();
    const db = this.#requireDb();
    const waiting = [];
    for (const required of requires) {
      const record = await changelog.getByName(db, required);
      if (
        record?.status === 'applied' &&
        (record.origin === 'baseline' || record.origin === 'migrate-mongo')
      ) {
        continue;
      }
      const state = await store.get(required);
      if (state === null) {
        waiting.push({ migration: required, status: 'unregistered' });
      } else if (state.direction === 'revert') {
        waiting.push({ migration: required, status: 'reverted' });
      } else if (state.status !== 'completed') {
        waiting.push({ migration: required, status: state.status });
      } else if (await this.#stillDirty(state)) {
        if (reopen) {
          await controlBackground(this.#backgroundDeps(), required, 'retry', {
            reason: 'old-shape documents reappeared',
          });
          this.#emit('background:drift', {
            migration: required,
            source: 'requires',
            action: 'reopened',
          });
        }
        waiting.push({ migration: required, status: reopen ? 'running' : 'completed' });
      }
    }
    return waiting;
  }

  /**
   * The background migrations a pending regular migration waits for — run
   * first, under this run's lock, in inline mode. Empty when it may run.
   */
  async #requiresGuard(name, signal) {
    const loaded = await this.#peek(name);
    if (loaded === null || loaded.kind === 'background') return [];
    const requires = loaded.requires ?? [];
    if (requires.length === 0) return [];
    await this.#assertRequiresAreBackground(name, requires);
    await this.#backgroundStore().ensureIndexes();
    let waiting = await this.#unsatisfied(requires);
    if (waiting.length > 0 && this.#config.backgroundInline) {
      for (const entry of waiting) {
        if (entry.status !== 'unregistered') await this.#runInline(entry.migration, signal);
      }
      waiting = await this.#unsatisfied(requires);
    }
    return waiting;
  }

  /**
   * Inline mode: drive a background migration to the end right here, under
   * the run's lock — what it requires first.
   *
   * @throws {BackgroundFailedError} when it fails; RunAbortedError on stop()
   */
  async #runInline(name, signal) {
    const state = await this.#backgroundStore().get(name);
    if (state === null) return;
    for (const required of state.status === 'blocked' ? (state.waitsFor ?? []) : []) {
      await this.#runInline(required, signal);
    }
    this.#logger.info(
      `⧗ Running   ${name} inline`,
      this.#fields({ background: name, inline: true }),
    );
    const status = await this.runBackground(name, {
      signal,
      concurrency: state.spec?.maxParallel ?? 1,
    });
    if (status.status === 'blocked') {
      throw new BackgroundPendingError(
        `Background migration ${name} cannot run inline: it waits for ${status.waitsFor.join(', ')}`,
        { migration: name, waitsFor: status.waitsFor.map((migration) => ({ migration })) },
      );
    }
  }

  /** Config and connection for a background method — no run, no migration lock */
  async #backgroundReady(name) {
    if (name !== undefined) assertMigrationName(name);
    await this.#ensureConfig();
    await this.connect();
    await this.#backgroundStore().ensureIndexes();
  }

  /** The state, or NotAppliedError — a control action needs a registered background migration */
  async #registered(name) {
    const state = await this.#backgroundStore().get(name);
    if (state === null) {
      throw new NotAppliedError(`Background migration ${name} is not registered — run up first`, {
        migration: name,
      });
    }
    return state;
  }

  /**
   * One coordinator step for a background migration — see background.js.
   * Reentrant: no run, no migration lock; serialized by its own lock.
   * @experimental
   */
  async coordinateBackground(name, { signal, driver } = {}) {
    await this.#backgroundReady(name);
    return coordinate(this.#backgroundDeps(this.#newId()), name, {
      signal,
      ...(driver ? { driver } : {}),
    });
  }

  /**
   * One slice of one lane of a background migration: claim a partition and a
   * slot, work it until `sliceMs` (the spec's by default) runs out, release.
   * @experimental
   */
  async runBackgroundSlice(name, { signal, sliceMs } = {}) {
    await this.#backgroundReady(name);
    const owner = this.#newId();
    return runSlice(this.#backgroundDeps(owner), name, { signal, sliceMs, owner });
  }

  /**
   * Drive a background migration from this process — the coordinator and up
   * to `concurrency` lanes (at most its `maxParallel`) — until it is done
   * (`untilDone`, the default) or for one round. Resolves to its status; a
   * failed one throws BackgroundFailedError, a stop RunAbortedError (the
   * background migration itself goes on from where it was).
   * @experimental
   */
  async runBackground(name, { signal, sliceMs, untilDone = true, concurrency = 1 } = {}) {
    await this.#backgroundReady(name);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new ConfigInvalidError('concurrency must be a positive integer', { concurrency });
    }
    const deps = this.#backgroundDeps(this.#newId());
    const stopped = () =>
      new RunAbortedError(`Stopped driving background migration ${name} — it goes on from here`, {
        migration: name,
      });
    for (;;) {
      if (signal?.aborted) throw stopped();
      const answer = await coordinate(deps, name, { signal });
      if (answer.next === 'done' || answer.next === 'superseded') break;
      if (answer.next === 'process') {
        const state = await this.#registered(name);
        const lanes = Math.max(1, Math.min(concurrency, state.spec?.maxParallel ?? 1));
        await Promise.all(
          Array.from({ length: lanes }, () => this.#lane(name, { signal, sliceMs, untilDone })),
        );
      } else {
        if (!untilDone) break;
        try {
          await sleep(answer.retryAfterMs ?? 1000, signal);
        } catch {
          throw stopped();
        }
      }
      if (!untilDone) break;
    }
    if (signal?.aborted) throw stopped();
    const state = await this.#registered(name);
    if (state.status === 'failed') throw failedError(state);
    return this.backgroundStatus(name);
  }

  /** One lane of runBackground: slices until nothing is left to claim (or one, without untilDone) */
  async #lane(name, { signal, sliceMs, untilDone }) {
    let failures = 0;
    for (;;) {
      if (signal?.aborted) return;
      const owner = this.#newId();
      let slice;
      try {
        slice = await runSlice(this.#backgroundDeps(owner), name, { signal, sliceMs, owner });
        failures = 0;
      } catch (error) {
        failures += 1;
        this.#logger.warn(
          `⚠ Background migration ${name}: a slice failed (${errorText(error)}) — retrying`,
          { background: name, runId: owner, error: errorText(error) },
        );
        try {
          await sleep(Math.min(30_000, 250 * 2 ** failures), signal);
        } catch {
          return;
        }
        continue;
      }
      if (!untilDone) return;
      if (slice.outcome === 'yielded') continue;
      if (slice.outcome === 'busy') {
        try {
          await sleep(slice.retryAfterMs ?? 1000, signal);
        } catch {
          return;
        }
        continue;
      }
      return;
    }
  }

  /** The public view of a state document, with its current plan's partition counts */
  async #backgroundView(state) {
    const store = this.#backgroundStore();
    const spec = state.spec ?? {};
    const counts =
      state.plan !== undefined
        ? await store.partitionCounts(state._id, {
            generation: state.generation,
            plan: state.plan.token,
          })
        : undefined;
    const leases = await store.leases(state._id);
    return {
      migration: state._id,
      status: state.status,
      phase: state.phase,
      direction: state.direction ?? 'forward',
      registration: state.registration,
      mode: state.mode ?? spec.mode,
      ...(state.collection !== undefined ? { collection: state.collection } : {}),
      ...(spec.from !== undefined ? { from: spec.from, to: spec.to } : {}),
      generation: state.generation ?? 0,
      pass: state.pass ?? 0,
      maxParallel: spec.maxParallel ?? 1,
      transaction: Boolean(spec.transaction),
      totals: { ...state.totals },
      failedDocuments: (state.badIds ?? []).length,
      requires: state.requires ?? [],
      waitsFor: state.waitsFor ?? [],
      ...(counts ? { partitions: counts } : {}),
      liveLeases: leases.live,
      ...(state.coordinator
        ? {
            coordinator: {
              kind: state.coordinator.kind,
              ...(state.coordinator.round !== undefined ? { round: state.coordinator.round } : {}),
              at: state.coordinator.at,
            },
          }
        : {}),
      ...(state.plan
        ? {
            plan: {
              method: state.plan.method,
              estimate: state.plan.estimate,
              partitions: state.plan.partitions,
              ...(state.plan.degraded ? { degraded: state.plan.degraded } : {}),
            },
          }
        : {}),
      registeredAt: state.registeredAt,
      ...(state.startedAt ? { startedAt: state.startedAt } : {}),
      ...(state.completedAt ? { completedAt: state.completedAt } : {}),
      ...(state.lastProgressAt ? { lastProgressAt: state.lastProgressAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.description ? { description: state.description } : {}),
    };
  }

  /**
   * The status of one background migration (`null` when not registered), or
   * of every one when no name is given.
   * @experimental
   */
  async backgroundStatus(name) {
    await this.#backgroundReady(name);
    const store = this.#backgroundStore();
    if (name !== undefined) {
      const state = await store.get(name);
      return state === null ? null : this.#backgroundView(state);
    }
    const views = [];
    for (const state of await store.list()) views.push(await this.#backgroundView(state));
    return views;
  }

  /**
   * The partitions of a background migration's latest generation — scope,
   * cursor, counters and lease holder (never its token).
   * @experimental
   */
  async backgroundPartitions(name) {
    await this.#backgroundReady(name);
    const state = await this.#registered(name);
    const partitions = await this.#backgroundStore().partitions(name, {
      generation: state.generation,
    });
    return partitions.map((partition) => ({
      id: String(partition._id),
      generation: partition.generation,
      seq: partition.seq,
      status: partition.status,
      scope: partition.scope,
      estimate: partition.estimate,
      counters: { ...partition.counters },
      ...(partition.group !== undefined ? { group: partition.group } : {}),
      ...(partition.lease
        ? {
            lease: {
              slot: partition.lease.slot,
              owner: partition.lease.owner,
              host: partition.lease.host,
              pid: partition.lease.pid,
              renewedAt: partition.lease.renewedAt,
            },
          }
        : {}),
      ...(partition.throttle ? { throttle: partition.throttle } : {}),
      claims: partition.claims ?? 0,
      reclaims: partition.reclaims ?? 0,
      failures: partition.failures ?? 0,
      ...(partition.lastError ? { lastError: partition.lastError } : {}),
    }));
  }

  /**
   * The background migrations with work to do — blocked ones whose requires
   * are met are unblocked on the way. `[{ migration, status }]`, oldest first.
   * @experimental
   */
  async runnableBackground() {
    await this.#backgroundReady();
    const store = this.#backgroundStore();
    const deps = this.#backgroundDeps();
    const runnable = [];
    for (const state of await store.list({ status: { $in: ['blocked', 'pending', 'running'] } })) {
      let current = state;
      if (state.status === 'blocked') current = (await tryUnblock(deps, state)) ?? state;
      if (current.status !== 'blocked') {
        runnable.push({
          migration: current._id,
          status: current.status,
          maxParallel: current.spec?.maxParallel ?? 1,
        });
      }
    }
    return runnable;
  }

  /** A control action, after the checks every one shares */
  async #controlBackground(name, action, options = {}) {
    await this.#backgroundReady(name);
    await this.#registered(name);
    const deps = this.#backgroundDeps();
    const result = await controlBackground(deps, name, action, options);
    if (options.wait === true && (action === 'pause' || action === 'cancel')) {
      result.stopped = await waitForLanes(deps, name, { signal: options.signal });
    }
    return result;
  }

  /** Pause a background migration; its lanes stop at the next batch. `wait` until they have. @experimental */
  pauseBackground(name, options = {}) {
    return this.#controlBackground(name, 'pause', options);
  }

  /** Resume a paused background migration. @experimental */
  resumeBackground(name, options = {}) {
    return this.#controlBackground(name, 'resume', options);
  }

  /** Cancel a background migration; `wait` until its lanes have stopped. @experimental */
  cancelBackground(name, options = {}) {
    return this.#controlBackground(name, 'cancel', options);
  }

  /**
   * Retry a failed or cancelled background migration — the same generation,
   * or `fromStart`; `repin` pins the file on disk first. A completed one is
   * reopened over whatever is left.
   * @experimental
   */
  async retryBackground(name, options = {}) {
    if (options.repin === true) await this.repinBackground(name, options);
    return this.#controlBackground(name, 'retry', options);
  }

  /**
   * Pin the file on disk as the background migration's version — its
   * checksum (in the changelog too, so a strict drift check agrees) and its
   * spec. A change to what it matches or how it splits means a new plan.
   * @experimental
   */
  async repinBackground(name, options = {}) {
    await this.#backgroundReady(name);
    await this.#registered(name);
    const result = await repinBackgroundState(this.#backgroundDeps(), name, options);
    await this.#requireChangelog().setChecksum(this.#requireDb(), name, result.checksum);
    return result;
  }

  /**
   * Dry-run a background migration — registered or not — with nothing
   * written: on a sample (`sample` random documents, or the `first` n), its
   * transformation alone; with `validate`, the real write path in a
   * transaction that is always aborted. A step migration runs `steps` steps
   * in that transaction instead.
   * @experimental
   */
  async dryRunBackground(name, options = {}) {
    await this.#ensureConfig();
    await this.connect();
    const loaded = await this.#loadBackground(name);
    const db = this.#requireDb();
    const deps = {
      db,
      client: this.#client,
      logger: this.#logger,
      forbidden: this.#bookkeepingNames(),
      topology: () => (this.#topology ??= readServer(db).then((server) => server.topology)),
    };
    if (loaded.spec.mode === 'step' || options.steps !== undefined) {
      if (loaded.spec.mode !== 'step') {
        throw new ConfigInvalidError(
          `${name} is declarative — dry-run it on a sample (sample, first), not by steps`,
          { migration: name },
        );
      }
      // From where the background migration is, unless asked to start over.
      let checkpoint = null;
      const state = await this.#backgroundStore().get(name);
      if (state !== null && !options.fromStart) {
        const [partition] = await this.#backgroundStore().partitions(name, {
          generation: state.generation,
        });
        checkpoint = partition?.cursor?.checkpoint ?? null;
      }
      return previewSteps(deps, name, loaded, { ...options, checkpoint });
    }
    return previewSample(deps, name, loaded, options);
  }

  /**
   * Clear a background migration's coordinator lock and every partition
   * lease — for a stuck one; live lanes are fenced off at their next write.
   * @experimental
   */
  async unlockBackground(name) {
    await this.#backgroundReady(name);
    const deps = this.#backgroundDeps();
    const lock = await deps.lockFor(name).forceRelease();
    const leases = await deps.store.unlockAll(name);
    return { lock: lock !== null, leases };
  }

  /** How converge treats search indexes: the config, and a call's own `waitForSearchIndexes` */
  #convergeSearchOptions(options = {}) {
    const config = this.#config;
    return {
      onUnavailable: config.onSearchUnavailable,
      wait: options.waitForSearchIndexes ?? config.waitForSearchIndexes,
      waitTimeoutMs: config.searchIndexWaitTimeoutMs,
    };
  }

  /** What runConverge works with; `lock` (a run's) lets it give the lock up before waiting */
  #convergeDeps(lock) {
    const db = this.#requireDb();
    return {
      db,
      ...(lock ? { releaseLock: () => lock.release() } : {}),
      recordSearchWait: (waitedMs, outcome) => this.#telemetry.searchWaited({ waitedMs, outcome }),
      logger: this.#logger,
      fields: (extra) => this.#fields(extra),
      emit: (event, payload) => this.#emit(event, payload),
      assertNotAborted: (abortSignal) => this.#assertNotAborted(abortSignal),
      // The history entry's who-and-where, like a changelog record's.
      audit: () => ({
        ...(this.#runId ? { runId: this.#runId } : {}),
        executedBy: safeUsername(),
        host: os.hostname(),
        environment: this.#environment(),
      }),
      record: (entry) => this.#convergeLog().append(db, entry),
      // Behind a mongos only: the shard key — so prune never drops its index,
      // and the version index takes it as a prefix. An 8.0 `unsplittable`
      // collection is not sharded; `undefined` when config may not be read.
      shardKeyOf: async (name) => {
        const sharding = await readShardKey(this.#client, db.databaseName, name);
        return sharding === undefined ? undefined : (sharding?.key ?? null);
      },
    };
  }

  #convergeLog() {
    this.#convergeLogStore ??= new ConvergeLog(this.#config.convergeLogCollection);
    return this.#convergeLogStore;
  }

  /**
   * The converge history, newest first: one entry per converge that changed
   * something or failed — when, triggered how, by whom and why, and every
   * index or validator it touched, with its before and after. Read-only.
   */
  async convergeHistory(options = {}) {
    const { limit = 20 } = options;
    assertHistoryLimit(limit);
    await this.#ensureConfig();
    await this.connect();
    return this.#convergeLog().list(this.#requireDb(), limit);
  }

  /**
   * `converge({ ordered })`: refuse while a migration on disk has no applied
   * record — a failed one included, exactly as for an ordered `up` job.
   */
  async #assertNothingPending() {
    const applied = new Set(await this.#requireChangelog().getAppliedNames(this.#requireDb()));
    const blockedBy = pendingIn(await this.#listMigrationFiles(), applied);
    if (blockedBy.length === 0) return;
    throw blockedError('converge', 'migration(s) still pending', {
      command: 'converge',
      blockedBy,
      failed: await this.#failedAmong(blockedBy),
    });
  }
}

module.exports = { MigratorKit, RECORD_LOCK_WAIT };
