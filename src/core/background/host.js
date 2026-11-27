// `mongodb` is required lazily inside connect(): loading the driver costs ~60ms
// and pulls in ~150 modules, which `--help`, `--version`, `init` and `create`
// have no use for.
const {
  BackgroundPendingError,
  ConfigInvalidError,
  MigrationInvalidExportError,
  NotAppliedError,
} = require('../../errors/index.js');
const { computeChecksum } = require('../../utils/checksum.js');
const { errorText } = require('../../utils/error.js');
const { jobFields } = require('../../utils/job-ref.js');
const { loadMigrationFile } = require('../../utils/loader.js');
const { assertMigrationName } = require('../../utils/migration-name.js');
const { ATTRIBUTES, SPANS } = require('../../utils/telemetry.js');
const {
  control: controlBackground,
  repin: repinBackgroundState,
  waitForLanes,
} = require('./controls.js');
const { coordinate, tryUnblock, waitingFor } = require('./coordinator.js');
const { runSlice } = require('./lane.js');
const {
  STREAMING_FRESH_MS,
  drive,
  hasRewritten,
  irreversibleBackground,
  partitionView,
  runnable,
  stateView,
  unsatisfied,
  watchRow,
  withdraw,
} = require('./kit.js');
const { verify: verifyDrift } = require('./drift.js');
const { assertSliceMs, resolveBackgroundSpec } = require('./spec.js');
const { previewSample, previewSteps } = require('./dry-run.js');
const { BackgroundStore } = require('./store.js');
const { startWatch, watchOptions } = require('./watch.js');
const { BackgroundWatchStore } = require('./watch-store.js');
const { readServer } = require('../server-info.js');
const { readChunks, readShardKey } = require('../shard-info.js');

const { MigrationLock } = require('../lock.js');
const { backgroundLogs } = require('../migration-logger.js');
const { assertActorValid, assertJobValid } = require('../options.js');

/**
 * The background migrations of one MigratorKit: their store and watch store,
 * what a lane and a coordinator run with (`deps`), the run loop's side of a
 * background file (register, revert, `requires`), and the public methods the
 * kit delegates to. Its state — the caches of index and shard keys, the
 * adaptive throttles, the warnings said once — lives here, and `reset()`
 * clears what a connection read.
 *
 * It reaches the kit through `kit`, an adapter the kit builds: its config,
 * client, logger and telemetry, its run's id and log, and the few kit
 * methods it needs (`requireDb`, `emit`, `fields`, `peek`, …).
 */
class BackgroundHost {
  #kit;
  /** The background migrations' store — made on first use (see #backgroundStore) */
  #backgroundStoreInstance = null;
  #watchStoreInstance = null;
  /** Warnings about background migrations said once per kit (a missing index, no lag rights) */
  #backgroundWarned = new Set();
  /** The adaptive throttles of this process, per background migration and group */
  #adaptiveCache = new Map();
  /** Index keys per collection, read at most every few seconds — every slice asks */
  #indexCache = new Map();
  /** Shard keys per collection, reused the same way — a read of `config` through the mongos */
  #shardKeyCache = new Map();
  /** Waits for a lagging secondary in progress, per background migration — said once per process */
  #lagWaits = new Map();
  /** Declared collections, for background specs — resolved once unless migrations reload */
  #backgroundDefinitions = null;
  /** The server's topology, read once — transactional background migrations need it */
  #topology = undefined;

  constructor(kit) {
    this.#kit = kit;
  }

  /**
   * Forget what the last connection read: the stores bind its Db, the
   * topology and the definitions were read through it, and the next
   * connection may be another deployment.
   */
  reset() {
    this.#backgroundStoreInstance = null;
    this.#watchStoreInstance = null;
    this.#topology = undefined;
    this.#backgroundDefinitions = null;
    this.#adaptiveCache.clear();
    this.#indexCache.clear();
    this.#shardKeyCache.clear();
    this.#lagWaits.clear();
  }

  /** The store of background migration state, over this kit's database */
  #backgroundStore() {
    this.#backgroundStoreInstance ??= new BackgroundStore(
      this.#kit.requireDb(),
      this.#kit.config.backgroundCollection,
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
  async asBackground(name, loaded, direction) {
    // Validated before it runs: an invalid file is reported as itself, not as
    // a failed execution — and nothing is written. A down goes by the spec it
    // was registered with: a definition file broken since must not block it.
    const { spec } =
      direction === 'down'
        ? await this.#registeredSpec(name, loaded)
        : await this.#backgroundSpec(name, loaded);
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
   * The spec a registered background migration runs by — the one stored at
   * its registration — with the file's functions. Not registered: the file's.
   */
  async #registeredSpec(name, loaded) {
    const state = await this.#backgroundStore().get(name);
    if (state?.spec === undefined) return this.#backgroundSpec(name, loaded);
    const { fns } = await this.#backgroundSpec(name, loaded, { tolerant: true });
    return { spec: state.spec, fns };
  }

  /**
   * The spec of a background migration file, resolved against the
   * collection's declared versioning (when it has one). `tolerant`: for a
   * registered one, whose stored spec stands — a definition file that does
   * not load is warned about and passed over (only its functions are used).
   */
  async #backgroundSpec(name, loaded, { tolerant = false } = {}) {
    const raw = loaded.background;
    let versioning = null;
    const collection = raw?.collection;
    if (typeof collection === 'string') {
      if (this.#kit.bookkeepingNames().includes(collection)) {
        throw new MigrationInvalidExportError(
          `Background migration ${name} targets "${collection}", one of migronaut's own collections`,
          { context: { name, collection } },
        );
      }
      const config = this.#kit.config;
      if (config.collections !== undefined || config.collectionsDir !== undefined) {
        try {
          versioning = await this.#versioningOf(collection, { strict: true });
        } catch (error) {
          if (!tolerant) throw error;
          this.#warnOnce(
            `definitions:${collection}`,
            `⚠ The collection definitions do not load (${errorText(error)}) — ${name} goes by ` +
              'the spec it was registered with',
            { background: name },
          );
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
    const sequence = await this.#kit.sequenceFiles();
    for (const required of requires) {
      if (!sequence.has(required)) {
        throw new MigrationInvalidExportError(
          `${name} requires ${required}, which is not a migration of the sequence`,
          { context: { name, requires: required } },
        );
      }
      // Through the module cache: this runs for every file that requires one.
      const loaded =
        (await this.#kit.peek(required)) ??
        (await loadMigrationFile(this.#kit.filepath(required), {
          reload: this.#kit.config.reloadMigrations,
        }));
      if (loaded.kind !== 'background') {
        throw new MigrationInvalidExportError(
          `${name} requires ${required}, which is not a background migration — requires ` +
            'waits for background migrations only (regular ones already run in order)',
          { context: { name, requires: required } },
        );
      }
    }
  }

  /** The required background migrations not done yet, in order */
  #waitsFor(requires) {
    return waitingFor(this.deps(), requires);
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
        checksum: await computeChecksum(this.#kit.filepath(name)),
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
  async assertRevertible(name) {
    const loaded = await this.#kit.peek(name);
    if (loaded === null || loaded.kind !== 'background') return;
    const { spec } = await this.#registeredSpec(name, loaded);
    if (spec.reversible) return;
    if (await hasRewritten(this.#backgroundStore(), name, spec)) {
      throw irreversibleBackground(name);
    }
  }

  /**
   * `down` of a background migration: with a `revert`, the forward one is
   * replaced by the way back (registered to run like any other); without one,
   * it is withdrawn while nothing has been rewritten (background/kit.js).
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
          checksum: await computeChecksum(this.#kit.filepath(name)),
          requires: [],
          waitsFor: [],
          ...(spec.collection !== undefined ? { collection: spec.collection } : {}),
        },
        { session },
      );
      return { status: 'pending', direction: 'revert' };
    }
    return withdraw(this.#backgroundHost(), name, spec, session);
  }

  /** What background/kit.js runs with */
  #backgroundHost() {
    return {
      store: this.#backgroundStore(),
      deps: (owner, options) => this.deps(owner, options),
      newId: () => this.#kit.newId(),
      logger: this.#kit.logger,
      emit: (event, payload) => this.#kit.emit(event, payload),
      registered: (name) => this.#registered(name),
      status: (name) => this.backgroundStatus(name),
    };
  }

  /**
   * What a lane and a coordinator run with — `owner` names a lane: its lease's owner, its
   * events' runId. `job` is the queue job working the lane, when there is one
   * (`{ id }` for a background queue's lane, `{ id, groupId? }` for a run that
   * drives it inline): it goes on the lane's log lines and `migration:log`
   * events.
   */
  deps(owner, { job, outsideRun = false } = {}) {
    const config = this.#kit.config;
    const db = this.#kit.requireDb();
    const stamp = owner ? { runId: owner } : {};
    // Work of no run — a verify tick, a control action — must not carry the
    // id of whatever run this kit has in flight: in the queue one kit serves
    // the migration worker and the background worker side by side.
    const send = outsideRun
      ? (event, payload) => this.#kit.deliver(event, payload)
      : (event, payload) => this.#kit.emit(event, payload);
    const lineStamp = job ? { ...stamp, ...jobFields(job) } : stamp;
    return {
      db,
      client: this.#kit.client,
      store: this.#backgroundStore(),
      logger: this.#kit.logger,
      // The lane's (or watcher's) run id, for ctx.background — `ownerOf()`
      // reads it here; the watcher's deps carry it as the string `owner`.
      ...(owner ? { runId: owner } : {}),
      // One counter per lane slice (or watcher): orders its migration:log events.
      logs: backgroundLogs({ sink: this.#kit.logger, emitter: this.#kit.logEmitter() }),
      ...(job ? { job } : {}),
      fields: (extra) => ({ ...lineStamp, ...extra }),
      emit: (event, payload) => send(event, { ...stamp, ...payload }),
      lockFor: (name) => {
        return new MigrationLock(db, config.lockCollection, config.lockTTLSeconds, {
          id: `background:${name}`,
          label: 'background coordinator lock',
        });
      },
      load: (name, options) => this.#loadBackground(name, options),
      ttlMs: config.lockTTLSeconds * 1000,
      ownerOf: () => owner,
      warned: this.#backgroundWarned,
      adaptiveCache: this.#adaptiveCache,
      indexCache: this.#indexCache,
      shardKeyCache: this.#shardKeyCache,
      lagWaits: this.#lagWaits,
      telemetry: this.#kit.telemetry,
      // The third wrap site: a span per lease held (slice) and per coordinator
      // step — each opened only once the lease or the lock is held.
      span: (kind, name, fn) => {
        return this.#kit.telemetry.wrap(
          kind === 'slice' ? SPANS.BACKGROUND_SLICE : SPANS.BACKGROUND_COORDINATE,
          { [ATTRIBUTES.BACKGROUND_NAME]: name },
          async (span) => {
            const result = await fn();
            span.set({ [ATTRIBUTES.BACKGROUND_OUTCOME]: result?.outcome ?? result?.next });
            return result;
          },
        );
      },
      onCompleted: (name) => this.#unblockDependents(name),
      adoptedOf: (names) => this.#kit.requireChangelog().getAdoptedNames(db, names),
      topology: () => this.#serverTopology(db),
      shardAware: config.backgroundShardAware,
      shardKeyOf: (collection) => readShardKey(this.#kit.client, db.databaseName, collection),
      chunksOf: (collection, sharding) => {
        return readChunks(this.#kit.client, db.databaseName, collection, sharding);
      },
      versioningOf: (collection) => this.#versioningOf(collection),
    };
  }

  /**
   * The server's topology, read once it is known. A `hello` that failed (an
   * election, a blip) is not remembered as "not sharded": it is asked again.
   */
  async #serverTopology(db) {
    if (this.#topology !== undefined) return this.#topology;
    const { topology } = await readServer(db);
    if (topology !== undefined) this.#topology = topology;
    return topology;
  }

  /**
   * A declared collection's versioning, or `undefined`. Definitions that do
   * not load are converge's to report — `undefined` too, unless `strict`.
   */
  async #versioningOf(collection, { strict = false } = {}) {
    const config = this.#kit.config;
    if (config.collections === undefined && config.collectionsDir === undefined) return undefined;
    let definitions = null;
    try {
      definitions = config.reloadMigrations
        ? await this.#kit.resolveCollections()
        : (this.#backgroundDefinitions ??= await this.#kit.resolveCollections());
    } catch (error) {
      if (strict) throw error;
      // Best-effort: no declared versioning to read, and the reason said at debug.
      this.#kit.logger.debug(
        `Could not load the collection definitions: ${errorText(error)}`,
        this.#kit.fields({ collection, error: errorText(error) }),
      );
      return undefined;
    }
    for (const definition of definitions) {
      if (definition.name === collection) return definition.versioning;
    }
    return undefined;
  }

  /** Say something about background migrations once per kit */
  #warnOnce(id, message, fields) {
    if (this.#backgroundWarned.has(id)) return;
    this.#backgroundWarned.add(id);
    this.#kit.logger.warn(message, this.#kit.fields(fields));
  }

  /**
   * The live drift watcher: a change stream per collection with a completed
   * background migration, one leader per collection across every process,
   * upgrading each old-shape write moments after it lands. Resolves to
   * `{ running, status(), stop() }` once it has started; on a standalone
   * server (no change streams) it rejects with ConfigInvalidError.
   * @experimental
   */
  async watchBackground(options = {}) {
    // Checked before anything connects: a typo should not wait for a server.
    watchOptions(options);
    await this.#backgroundReady();
    const db = this.#kit.requireDb();
    if ((await readServer(db)).topology === 'standalone') {
      throw new ConfigInvalidError(
        'The live drift watcher needs change streams — a replica set or a sharded cluster; ' +
          "keep backgroundDrift: 'poll' on a standalone server",
        { context: { key: 'backgroundDrift' } },
      );
    }
    const config = this.#kit.config;
    const owner = this.#kit.newId();
    return startWatch(
      {
        ...this.deps(owner),
        watchStore: this.watchStore(),
        watchLockFor: (collection) => {
          return new MigrationLock(db, config.lockCollection, config.lockTTLSeconds, {
            id: `watch:${collection}`,
            label: 'drift watcher lock',
          });
        },
        owner,
        onDrift: config.backgroundOnDrift,
      },
      options,
    );
  }

  /**
   * What the live drift watchers recorded — one row per watched collection
   * (or the one asked for, `null` when it has none): state, leader, counters,
   * last event. Never the resume token.
   * @experimental
   */
  async backgroundWatchStatus(collection) {
    await this.#backgroundReady();
    const rows = await this.watchStore().status(collection);
    if (collection !== undefined) return rows === null ? null : watchRow(rows);
    const views = [];
    for (const row of rows) views.push(watchRow(row));
    return views;
  }

  watchStore() {
    this.#watchStoreInstance ??= new BackgroundWatchStore(
      this.#kit.requireDb(),
      this.#kit.config.backgroundCollection,
    );
    return this.#watchStoreInstance;
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
    const onDrift = options.onDrift ?? this.#kit.config.backgroundOnDrift;
    if (onDrift !== 'reopen' && onDrift !== 'report') {
      throw new ConfigInvalidError("onDrift must be 'reopen' or 'report'", {
        context: { onDrift },
      });
    }
    // With `backgroundDrift: 'stream'` the poll is the safety net: it leaves
    // alone a collection whose watcher is streaming and alive.
    const streaming =
      this.#kit.config.backgroundDrift === 'stream'
        ? await this.#streamingCollections()
        : undefined;
    return verifyDrift(this.deps(undefined, { outsideRun: true }), {
      onDrift,
      ...(options.collections !== undefined ? { collections: options.collections } : {}),
      ...(streaming !== undefined ? { streaming } : {}),
    });
  }

  /** Collections a live watcher leads right now — streaming, its record fresh */
  async #streamingCollections() {
    const fresh = Date.now() - STREAMING_FRESH_MS;
    const names = [];
    for (const row of await this.watchStore().status()) {
      if (row.state === 'streaming' && row.updatedAt?.getTime() > fresh) names.push(row._id);
    }
    return names;
  }

  /**
   * How drift is watched (`backgroundDrift`): `'poll'`, `'stream'` or
   * `'both'` — what a runner or a queue worker hosting this kit follows.
   * Resolves the config; does not connect.
   */
  async driftMode() {
    return (await this.#kit.ensureConfig()).backgroundDrift;
  }

  /** A background migration file, loaded and resolved: `{ spec, fns, checksum }` */
  async #loadBackground(name, { tolerant = false } = {}) {
    assertMigrationName(name);
    const filepath = this.#kit.filepath(name);
    // Once per version of the file: lanes ask on every slice, and a re-import
    // per slice (under reloadMigrations) is a module the cache never frees.
    // A file that cannot be read is loaded for its error.
    const loaded =
      (await this.#kit.peek(name)) ??
      (await loadMigrationFile(filepath, {
        reload: this.#kit.config.reloadMigrations,
      }));
    if (loaded.kind !== 'background') {
      throw new MigrationInvalidExportError(`${name} is not a background migration`, {
        context: { name },
      });
    }
    const { spec, fns } = await this.#backgroundSpec(name, loaded, { tolerant });
    return { spec, fns, checksum: await this.#kit.cachedChecksum(filepath) };
  }

  /** After one completes: the blocked ones that required it, unblocked if nothing else holds them */
  async #unblockDependents(name) {
    const store = this.#backgroundStore();
    const deps = this.deps();
    for (const state of await store.list({ requires: name, status: 'blocked' })) {
      await tryUnblock(deps, state);
    }
  }

  /**
   * The background migrations of `requires` not done yet:
   * `[{ migration, status }]` — background/kit.js.
   */
  pendingRequires(requires, options) {
    return unsatisfied(this.#backgroundHost(), requires, options);
  }

  /**
   * The background migrations a pending regular migration waits for — run
   * first, under this run's lock, in inline mode. Empty when it may run.
   */
  async requiresGuard(name, signal) {
    let loaded = null;
    try {
      loaded = await this.#kit.peek(name);
    } catch {
      // A file that does not load requires nothing that can be told. Its
      // failure is #executeMigration's to report — inside the migration's
      // span, after beforeEach, with a duration point — not this guard's,
      // which runs before all of them.
      return [];
    }
    if (loaded === null || loaded.kind === 'background') return [];
    const requires = loaded.requires ?? [];
    if (requires.length === 0) return [];
    await this.#assertRequiresAreBackground(name, requires);
    await this.prepareIndexes();
    let waiting = await this.pendingRequires(requires);
    if (waiting.length > 0 && this.#kit.config.backgroundInline) {
      for (const entry of waiting) {
        if (entry.status !== 'unregistered') await this.runInline(entry.migration, signal);
      }
      waiting = await this.pendingRequires(requires);
    }
    return waiting;
  }

  /**
   * Inline mode: drive a background migration to the end right here, under
   * the run's lock — what it requires first.
   *
   * @throws {BackgroundFailedError} when it fails; RunAbortedError on stop()
   */
  async runInline(name, signal) {
    const state = await this.#backgroundStore().get(name);
    if (state === null) return;
    for (const required of state.status === 'blocked' ? (state.waitsFor ?? []) : []) {
      await this.runInline(required, signal);
    }
    this.#kit.logger.info(
      `⧗ Running   ${name} inline`,
      this.#kit.fields({ background: name, inline: true }),
    );
    await this.#backgroundReady(name, { lanes: true });
    // The lanes work for the run's queue job: their lines and events name it,
    // with its group — which a background queue's own lanes never have.
    const job = this.#kit.runLog?.job;
    const status = await drive(this.#backgroundHost(), name, {
      signal,
      concurrency: state.spec?.maxParallel ?? 1,
      inline: true,
      ...(job ? { job } : {}),
    });
    if (status.status === 'blocked') {
      const waitsFor = [];
      for (let i = 0; i < status.waitsFor.length; i++) {
        waitsFor.push({ migration: status.waitsFor[i] });
      }
      throw new BackgroundPendingError(
        `Background migration ${name} cannot run inline: it waits for ${status.waitsFor.join(', ')}`,
        { context: { migration: name, waitsFor } },
      );
    }
  }

  /**
   * Config and connection for a background method — no run, no migration
   * lock. `lanes`: it claims partitions, and needs the slot indexes.
   */
  async #backgroundReady(name, { lanes = false } = {}) {
    if (name !== undefined) assertMigrationName(name);
    await this.#kit.ensureConfig();
    await this.#kit.connect();
    await this.prepareIndexes({ lanes });
  }

  /**
   * The background collections' indexes, created on first use — unless
   * `ensureIndexes: false` (a user who cannot create indexes): then they are
   * expected to exist, and only what claims partitions checks they do.
   */
  async prepareIndexes({ lanes = false } = {}) {
    const store = this.#backgroundStore();
    if (this.#kit.config.ensureIndexes) await store.ensureIndexes();
    else if (lanes) await store.assertIndexes();
  }

  /** The state, or NotAppliedError — a control action needs a registered background migration */
  async #registered(name) {
    const state = await this.#backgroundStore().get(name);
    if (state === null) {
      throw new NotAppliedError(`Background migration ${name} is not registered — run up first`, {
        context: { migration: name },
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
    return coordinate(this.deps(this.#kit.newId()), name, {
      signal,
      ...(driver ? { driver } : {}),
    });
  }

  /**
   * One slice of one lane of a background migration: claim a partition and a
   * slot, work it until `sliceMs` (the spec's by default) runs out, release.
   * `job: { id }` names the queue job working the lane, for its log lines.
   * @experimental
   */
  async runBackgroundSlice(name, { signal, sliceMs, job } = {}) {
    if (sliceMs !== undefined) assertSliceMs(sliceMs);
    // A lane's job has no group: `{ id }` only.
    assertJobValid(job, { groupId: false });
    await this.#backgroundReady(name, { lanes: true });
    const owner = this.#kit.newId();
    return runSlice(this.deps(owner, job ? { job } : {}), name, {
      signal,
      sliceMs,
      owner,
    });
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
    await this.#backgroundReady(name, { lanes: true });
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new ConfigInvalidError('concurrency must be a positive integer', {
        context: { concurrency },
      });
    }
    if (sliceMs !== undefined) assertSliceMs(sliceMs);
    return drive(this.#backgroundHost(), name, { signal, sliceMs, untilDone, concurrency });
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
      return state === null ? null : stateView(store, state);
    }
    const views = [];
    for (const state of await store.list()) views.push(await stateView(store, state));
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
    const views = [];
    for (const partition of partitions) views.push(partitionView(partition));
    return views;
  }

  /**
   * The background migrations with work to do — blocked ones whose requires
   * are met are unblocked on the way. `[{ migration, status }]`, oldest first.
   * @experimental
   */
  async runnableBackground() {
    await this.#backgroundReady();
    return runnable(this.#backgroundHost());
  }

  /** A control action, after the checks every one shares */
  async #controlBackground(name, action, options = {}) {
    // Who and why go into the state's history: held to the changelog's limits.
    assertActorValid(options);
    await this.#backgroundReady(name);
    await this.#registered(name);
    const deps = this.deps(undefined, { outsideRun: true });
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
    assertActorValid(options);
    await this.#backgroundReady(name);
    await this.#registered(name);
    const result = await repinBackgroundState(this.deps(), name, options);
    await this.#kit.requireChangelog().setChecksum(this.#kit.requireDb(), name, result.checksum);
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
    await this.#kit.ensureConfig();
    await this.#kit.connect();
    const loaded = await this.#loadBackground(name);
    const db = this.#kit.requireDb();
    const deps = {
      db,
      client: this.#kit.client,
      logger: this.#kit.logger,
      forbidden: this.#kit.bookkeepingNames(),
      topology: () => this.#serverTopology(db),
      // The sandbox refuses a sharded collection's distinct (a mongos cannot run it in a transaction).
      shardKeyOf: (collection) => readShardKey(this.#kit.client, db.databaseName, collection),
    };
    if (loaded.spec.mode === 'step' || options.steps !== undefined) {
      if (loaded.spec.mode !== 'step') {
        throw new ConfigInvalidError(
          `${name} is declarative — dry-run it on a sample (sample, first), not by steps`,
          { context: { migration: name } },
        );
      }
      // From where the background migration is, unless asked to start over.
      let checkpoint = null;
      const state = await this.#backgroundStore().get(name);
      if (state !== null && !options.fromStart) {
        const partitions = await this.#backgroundStore().partitions(name, {
          generation: state.generation,
        });
        checkpoint = partitions[0]?.cursor?.checkpoint ?? null;
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
    const deps = this.deps();
    const lock = (await deps.lockFor(name).forceRelease()) !== null;
    const leases = await deps.store.unlockAll(name);
    // It fences every live lane: an operator's act, recorded like any control.
    await deps.store.note(name, { action: 'unlock', lock, leases });
    this.#kit.emit('background:control', { migration: name, action: 'unlock', lock, leases });
    this.#kit.logger.warn(
      `⚠ ${name}: unlocked — coordinator lock ${lock ? 'cleared' : 'not held'}, ${leases} ` +
        'lease(s) dropped (their lanes stop at their next write)',
      this.#kit.fields({ background: name, lock, leases }),
    );
    return { lock, leases };
  }
}

module.exports = { BackgroundHost };
