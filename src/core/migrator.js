const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
// `mongodb` is required lazily inside connect(): loading the driver costs ~60ms
// and pulls in ~150 modules, which `--help`, `--version`, `init` and `create`
// have no use for.
const {
  ChecksumMismatchError,
  ConfigInvalidError,
  ConnectionFailedError,
  HookFailedError,
  IrreversibleMigrationError,
  MigrationFileNotFoundError,
  MigrationInvalidNameError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
} = require('../errors/index.js');
const { computeChecksum } = require('../utils/checksum.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { loadMigrationFile } = require('../utils/loader.js');
const { resolveLogger } = require('../utils/logger.js');
const {
  createConfigFile,
  createMigrationFile,
  maskUriCredentials,
} = require('../utils/template.js');
const { safeUsername } = require('../utils/user.js');
const { runAudit } = require('./audit.js');
const { Changelog } = require('./changelog.js');
const { isCollectionName, loadConfig } = require('./config.js');
const { buildContext } = require('./context.js');
const { runImport } = require('./import-runner.js');
const { MigrationLock, runWithLock, toLockInfo } = require('./lock.js');
const { runMigration } = require('./runner.js');

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
  /** Whether changelog indexes have already been ensured on this instance */
  #indexesEnsured = false;
  /** Memoized resolved logger — resolveLogger allocates on every call otherwise */
  #resolvedLogger;
  /** Used only when the resolved config supplies no `logger` of its own (CLI injection) */
  #fallbackLogger;
  /** False when the client was injected by the caller, who keeps ownership of it */
  #ownsClient = true;
  /** filepath → {mtimeMs, size, checksum} — spares repeat status()/audit() calls a full re-hash */
  #checksumCache = new Map();

  constructor(config = {}, options = {}) {
    super();
    this.#partialConfig = config;
    this.#configPath = options.configPath;
    this.#progress = options.progress;
    this.#fallbackLogger = options.fallbackLogger;
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

  /** Resolve and cache the full configuration */
  async #ensureConfig(requireDb = true, lenient = false) {
    if (!this.#config) {
      this.#config = await loadConfig({
        flags: this.#partialConfig,
        requireDb,
        ...(lenient ? { lenient: true } : {}),
        ...(this.#configPath ? { configPath: this.#configPath } : {}),
        ...(this.#fallbackLogger !== undefined ? { fallbackLogger: this.#fallbackLogger } : {}),
      });
    }
    return this.#config;
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

  /** Connect to MongoDB and ensure changelog indexes exist */
  async connect() {
    const config = await this.#ensureConfig();
    if (this.#client && this.#db) {
      return;
    }
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
      if (!this.#indexesEnsured && (config.ensureIndexes ?? true)) {
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
   * Run `fn` under the migration lock. The single place that pairs a lock with
   * a unit of work, so `redo` can hold one lock across both directions instead
   * of releasing between them. `info` names the run (`{command, direction?}`)
   * for the `run:start`/`run:end` events.
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
    // fact ("which run left this lock?", "what did run X apply?").
    this.#runId = randomUUID();
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
    const startedAt = Date.now();
    this.#emit('run:start', { ...info });
    let failure;
    let result;
    try {
      result = await runWithLock(
        this.#buildLock(),
        {
          logger: this.#logger,
          onLockLost: this.#config?.onLockLost ?? 'abort',
          owner: this.#runId,
          onLockAcquired: (extra) => this.#emit('lock:acquired', { owner: this.#runId, ...extra }),
          onLockReleased: (extra) => this.#emit('lock:released', { owner: this.#runId, ...extra }),
          onLockLostEvent: (reason) => this.#emit('lock:lost', { owner: this.#runId, reason }),
          ...(options.noLock ? { noLock: true } : {}),
        },
        (lockSignal) => fn(AbortSignal.any([lockSignal, stopper.signal])),
      );
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // Result counts, so a metrics subscriber gets "3 applied in 812ms"
      // without reconstructing it from per-migration events. On the failure
      // path the partial rows live on the error's context — exactly the case
      // where "how far did it get?" is the question, so they count too. One
      // pass fills both counters.
      const rows = Array.isArray(result)
        ? result
        : failure instanceof MigronautError && Array.isArray(failure.context?.results)
          ? failure.context.results
          : null;
      let summary = {};
      if (rows) {
        let applied = 0;
        let reverted = 0;
        for (const row of rows) {
          if (row.status === 'applied') applied += 1;
          else if (row.status === 'reverted') reverted += 1;
        }
        summary = { applied, reverted, total: rows.length };
      }
      this.#emit('run:end', {
        ...info,
        success: failure === undefined,
        durationMs: Date.now() - startedAt,
        ...summary,
        // A raw Error here would hand subscribers an unredacted driver message
        // (which can echo the credentialed URI) — errorText is the same
        // chokepoint every log line and result row already goes through.
        ...(failure ? { error: errorText(failure) } : {}),
      });
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
    return path.resolve(this.#config?.migrationsDir ?? './migrations');
  }

  /**
   * Reject non-string filenames before they reach a changelog query or a path
   * join. A programmatic caller passing e.g. `{ $ne: null }` would otherwise
   * become a query-operator injection in `findOne({ name })`.
   */
  #assertFilename(filename) {
    if (filename !== undefined && typeof filename !== 'string') {
      throw new MigrationInvalidNameError('Migration name must be a string', {
        name: filename,
      });
    }
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
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0')
    ) {
      throw new MigrationInvalidNameError(
        'Invalid migration name — must be a bare filename with no path segments',
        { name },
      );
    }
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
    const dir = this.#migrationsPath();
    const extensions = this.#config?.fileExtensions ?? ['.ts', '.js'];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const matches = [];
    for (const entry of entries) {
      // A directory named `foo.js`, a dotfile, or a `types.d.ts` sitting next
      // to the migrations is not a migration — including it would hard-fail
      // the whole run with MigrationInvalidExportError.
      if (!entry.isFile()) continue;
      const file = entry.name;
      if (file.startsWith('.')) continue;
      if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) continue;
      for (const ext of extensions) {
        if (file.endsWith(ext)) {
          matches.push(file);
          break;
        }
      }
    }
    return matches.sort();
  }

  /** Compute the next batch number (monotonic across the full history) */
  async #nextBatch() {
    return (await this.#requireChangelog().getMaxBatch(this.#requireDb())) + 1;
  }

  /**
   * Validate the `--steps` option for `down`/`dry-run down`: a positive integer,
   * mutually exclusive with a filename and `--batch`. No-op when steps is unset.
   */
  #assertStepsValid(steps, filename, batch) {
    if (steps === undefined) {
      return;
    }
    if (filename) {
      throw new ConfigInvalidError('Cannot combine a filename with --steps', { filename });
    }
    if (batch !== undefined) {
      throw new ConfigInvalidError('Cannot combine --batch with --steps', { batch, steps });
    }
    if (!Number.isInteger(steps) || steps < 1) {
      throw new ConfigInvalidError('--steps must be a positive integer', { steps });
    }
  }

  /**
   * Keep only the pending migrations up to and including `to`.
   *
   * `to` must name a migration that exists; it may already be applied (then
   * nothing before it is pending either, and the result is empty), which is
   * what makes `up --to X` idempotent — running it twice is a no-op rather
   * than an error.
   */
  #truncateAtTarget(pending, allFiles, to) {
    if (!allFiles.includes(to)) {
      throw new MigrationFileNotFoundError('Migration file not found', { to });
    }
    const kept = [];
    for (const file of pending) {
      if (file > to) break;
      kept.push(file);
    }
    return kept;
  }

  /**
   * `--to` names a point in the sequence, so it cannot be combined with the
   * other ways of choosing targets.
   */
  #assertToValid(to, filename, options = {}) {
    if (to === undefined) return;
    this.#assertFilename(to);
    if (filename) {
      throw new ConfigInvalidError('Cannot combine a filename with --to', { filename, to });
    }
    if (options.steps !== undefined) {
      throw new ConfigInvalidError('Cannot combine --steps with --to', {
        steps: options.steps,
        to,
      });
    }
    if (options.batch !== undefined) {
      throw new ConfigInvalidError('Cannot combine --batch with --to', {
        batch: options.batch,
        to,
      });
    }
  }

  /**
   * Validate `--batch`. Without this a typo (`--batch abc` → NaN) matches no
   * records, so the run prints "Nothing to rollback" and exits 0 — the worst
   * possible answer to a mistyped rollback.
   */
  #assertBatchValid(batch) {
    if (batch === undefined) return;
    if (!Number.isInteger(batch) || batch < 1) {
      throw new ConfigInvalidError('--batch must be a positive integer', { batch });
    }
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
      }
    } catch (error) {
      failure = error;
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
   * Execute one migration end to end: beforeEach → load → run (with the
   * changelog write inside the transaction via `onSuccess`) → events, logs,
   * result row, afterEach — and the mirrored error path. Shared verbatim by
   * `up` and `down`, so a fix to one direction cannot silently miss the other.
   */
  async #executeMigration({ name, direction, context, index, total, results, batch, onSuccess }) {
    const config = this.#config;
    const logger = this.#logger;
    const batchField = batch !== undefined ? { batch } : {};

    await this.#runHook(config.hooks?.beforeEach, 'beforeEach', [
      name,
      context,
      { direction, index, total },
    ]);
    const migration = await loadMigrationFile(this.#filepath(name), {
      reload: config.reloadMigrations ?? false,
    });
    const useTransaction = migration.useTransaction ?? config.useTransaction;

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
      const label = direction === 'up' ? '✔ Applied ' : '↩ Reverted';
      logger.info(
        `${label} ${name}   [${duration}ms]`,
        this.#fields({ migration: name, direction, ...batchField, durationMs: duration }),
      );
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
      // errorText, not the raw Error: a driver message can echo the
      // credentialed URI, and event subscribers (Sentry, JSON logs) would
      // ship it — the same redaction the log line below already gets.
      this.#emit('migration:error', { migration: name, direction, error: errorText(error) });
      logger.error(
        `✖ Error    ${name}`,
        this.#fields({ migration: name, direction, error: errorText(error) }),
      );
      results.push({ file: name, status: 'error', error: errorText(error) });
      // Carry what already succeeded, so `--json` consumers can tell which
      // migrations landed before the failure instead of losing the list.
      this.#attachResults(error, results);
      throw error;
    }
  }

  /** Run all pending migrations, or a specific named file */
  async up(filename, options = {}) {
    this.#assertFilename(filename);
    this.#assertToValid(options.to, filename, options);
    return this.#runWindow(async () => {
      await this.#ensureConfig();
      await this.connect();
      return this.#withLock(options, { command: 'up', direction: 'up' }, (signal) =>
        this.#runUp(filename, options, signal),
      );
    });
  }

  async #runUp(filename, options = {}, signal) {
    const force = options.force ?? false;
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    // A strict bulk run needs the applied records' checksums anyway, so fetch
    // full records once and derive the name set from them; a single-file run
    // needs only that file's record, so one getByName is both the
    // applied-check and the checksum source; otherwise the cheaper covered
    // name query suffices.
    const strictBulk = !filename && config.strict && !force;
    const appliedRecords = strictBulk ? await changelog.getApplied(db) : undefined;
    const appliedNames = new Set();
    let singleRecord = null;
    if (filename) {
      singleRecord = await changelog.getByName(db, filename);
      if (singleRecord?.status === 'applied') appliedNames.add(filename);
    } else if (appliedRecords) {
      for (const record of appliedRecords) appliedNames.add(record.name);
    } else {
      for (const name of await changelog.getAppliedNames(db)) appliedNames.add(name);
    }

    let targets;
    if (filename) {
      const filepath = this.#filepath(filename);
      try {
        await fs.access(filepath);
      } catch {
        throw new MigrationFileNotFoundError('Migration file not found', { filename });
      }
      targets = [filename];
    } else {
      const files = await this.#listMigrationFiles();
      targets = [];
      for (const file of files) {
        if (!appliedNames.has(file)) targets.push(file);
      }
      if (options.to !== undefined) {
        targets = this.#truncateAtTarget(targets, files, options.to);
      }
      // Pending files are the only targets here, so the per-target checksum
      // check below can never see an applied one. Verify them up front instead,
      // otherwise `up --strict` over a bulk run would police nothing.
      if (strictBulk) await this.#assertNoChecksumDrift(appliedRecords);
    }

    if (targets.length === 0) {
      logger.info('Nothing to migrate', this.#fields({ direction: 'up' }));
      return [];
    }

    const context = buildContext(this.#client, db, config.mongoose, signal);
    // Without --step every file in this run shares one batch. With --step each
    // applied file gets its own sequential batch (base, base+1, …) so a later
    // `down` can revert them individually. Only successful applies advance the
    // counter, so --step never leaves gaps.
    const baseBatch = await this.#nextBatch();
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

        const batch = options.step ? baseBatch + appliedCount : baseBatch;
        await this.#executeMigration({
          name,
          direction: 'up',
          context,
          index,
          total: targets.length,
          results,
          batch,
          onSuccess: (migration, elapsed, session) =>
            changelog.markApplied(
              db,
              {
                name,
                batch,
                status: 'applied',
                appliedAt: new Date(),
                checksum,
                environment: this.#environment(),
                executedBy: safeUsername(),
                duration: elapsed,
                ...(this.#runId ? { runId: this.#runId } : {}),
                ...(migration.description ? { description: migration.description } : {}),
              },
              session,
            ),
        });
        appliedCount += 1;
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
        actual = await computeChecksum(filepath);
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
    this.#assertFilename(filename);
    this.#assertStepsValid(options.steps, filename, options.batch);
    this.#assertBatchValid(options.batch);
    this.#assertToValid(options.to, filename, options);
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

  /** Order the selected records for execution (newest first unless pre-ordered) */
  #downNames(records, preserveOrder) {
    const names = [];
    for (const record of records) names.push(record.name);
    if (!preserveOrder) {
      names.sort();
      names.reverse();
    }
    return names;
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

    const names = this.#downNames(toRevert, preserveOrder);

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
            const result = await changelog.markReverted(db, name, session);
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
   * Refuse rollback of any migrate-mongo-imported record. These are forward-only:
   * their files use migrate-mongo's positional `up(db, client)`/`down(db, client)`
   * signature, which migronaut cannot invoke safely, so reverting them could corrupt the
   * collection. Throws before any migration runs or the changelog is touched.
   */
  #assertReversible(records) {
    const names = [];
    for (const record of records) {
      if (record.origin === 'migrate-mongo') names.push(record.name);
    }
    if (names.length === 0) {
      return;
    }
    this.#logger.error(
      `✖ Cannot roll back ${names.length} migrate-mongo-imported migration(s): ${names.join(', ')}`,
    );
    this.#logger.debug(
      'These were adopted via `migronaut import` (forward-only). Their files use the positional ' +
        'migrate-mongo signature, which migronaut cannot run. Revert them manually or re-author ' +
        'them in migronaut format.',
    );
    throw new IrreversibleMigrationError(
      `Cannot roll back migrate-mongo-imported migration(s): ${names.join(', ')}`,
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
    this.#assertFilename(filename);
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

        const downResults = await this.#runDown(target, {}, signal);
        let upResults;
        try {
          upResults = await this.#runUp(target, {}, signal);
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
    this.#assertFilename(filename);
    // `batch`/`to` must be passed too, or a conflict that `down` rejects would
    // be silently allowed in its own preview.
    this.#assertStepsValid(options.steps, filename, options.batch);
    this.#assertBatchValid(options.batch);
    this.#assertToValid(options.to, filename, options);
    await this.#ensureConfig();
    await this.connect();
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    let names;
    const recordByName = new Map();
    if (direction === 'up') {
      // A preview only ever reports pending files or applied records, so the
      // reverted history is dead weight here.
      const records = await changelog.getApplied(db);
      for (const record of records) {
        recordByName.set(record.name, record);
      }
      const applied = new Set(recordByName.keys());
      if (filename) {
        // Same preflight as a real `up`, so a preview never invents a pending
        // row for a file that does not exist.
        const filepath = this.#filepath(filename);
        const exists = await fs
          .access(filepath)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          throw new MigrationFileNotFoundError('Migration file not found', { filename });
        }
        names = [filename];
      } else {
        const files = await this.#listMigrationFiles();
        names = [];
        for (const file of files) {
          if (!applied.has(file)) names.push(file);
        }
        // `up --to` gets the same preview surface as the real run.
        if (options.to !== undefined) {
          names = this.#truncateAtTarget(names, files, options.to);
        }
      }
    } else {
      // The same selection the real `down` executes — including the
      // irreversible-import refusal, so a preview can never show a rollback
      // the real run would reject.
      const { records, preserveOrder } = await this.#selectDownTargets(filename, options);
      for (const record of records) {
        recordByName.set(record.name, record);
      }
      names = this.#downNames(records, preserveOrder);
    }

    const rows = await mapLimit(names, FS_CONCURRENCY, (name) =>
      this.#buildStatusRow(name, recordByName.get(name)),
    );
    logger.info(
      `◎ Dry-run  Would ${direction === 'up' ? 'apply' : 'revert'}: ${rows.length}`,
      this.#fields({ direction, count: rows.length, dryRun: true }),
    );
    return rows;
  }

  /** Full migration status for all known files and records */
  async status() {
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
    return mapLimit(sortedNames, FS_CONCURRENCY, (name) =>
      this.#buildStatusRow(name, recordByName.get(name)),
    );
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
    });
  }

  /** Filtered list of migrations */
  async list(filter = 'all') {
    // An unknown filter silently returning [] reads as "nothing to report" —
    // the worst possible answer to a typo.
    if (filter !== 'all' && filter !== 'pending' && filter !== 'applied') {
      throw new ConfigInvalidError("list filter must be 'all', 'pending' or 'applied'", { filter });
    }
    if (filter === 'pending') {
      return this.#listPending();
    }
    const rows = await this.status();
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
    for (const file of await this.#listMigrationFiles()) {
      if (applied.has(file)) continue;
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

  /** Build a StatusRow for a migration, verifying checksum when possible */
  async #buildStatusRow(name, record) {
    const isApplied = record?.status === 'applied';
    let filepath;
    try {
      filepath = this.#filepath(name);
    } catch {
      // A legacy or tampered changelog record whose name is not a plain
      // filename must not take down the whole report — mark the one row
      // invalid and keep going.
      return {
        file: String(name),
        status: isApplied ? 'applied' : 'pending',
        batch: isApplied && record ? record.batch : null,
        appliedAt: isApplied && record ? record.appliedAt : null,
        duration: isApplied && record ? record.duration : null,
        checksumOk: isApplied ? false : null,
        invalid: true,
      };
    }
    // Hash (via the cache) and treat ENOENT as "missing" — the old
    // access()-first probe cost an extra syscall per row, for pending rows
    // whose result was never even used.
    let checksumOk = null;
    if (isApplied && record) {
      try {
        checksumOk = (await this.#cachedChecksum(filepath)) === record.checksum;
      } catch (error) {
        // A missing file has nothing to verify — checksumOk stays null.
        if (error.code !== 'ENOENT') throw error;
      }
    }

    return {
      file: name,
      status: isApplied ? 'applied' : 'pending',
      batch: isApplied && record ? record.batch : null,
      appliedAt: isApplied && record ? record.appliedAt : null,
      duration: isApplied && record ? record.duration : null,
      checksumOk,
      ...(record?.description ? { description: record.description } : {}),
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
      dir: process.cwd(),
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
   * Adopt an existing migrate-mongo `changelog` collection by mapping its
   * records into our schema and writing them to `migrationsCollection`. The
   * source collection is never modified. Forward-only: it records applied
   * history so `up` skips it correctly — it does not adapt legacy migration
   * file signatures, so `down`/`redo` on imported files is unsupported.
   */
  async import(options = {}) {
    // Validate before connecting: a bad --from/--to must not cost a round trip
    // or take the lock. Defaults come from the already-validated config.
    if (options.from !== undefined && !isCollectionName(options.from)) {
      throw new ConfigInvalidError('Invalid source collection name', { from: options.from });
    }
    if (options.to !== undefined && !isCollectionName(options.to)) {
      throw new ConfigInvalidError('Invalid target collection name', { to: options.to });
    }
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
}

module.exports = { MigratorKit };
