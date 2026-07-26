const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const {
  ChecksumMismatchError,
  ConfigInvalidError,
  ConnectionFailedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  MigrationFileNotFoundError,
  MigrationInvalidNameError,
  NotAppliedError,
} = require('../errors/index.js');
const { computeChecksum } = require('../utils/checksum.js');
const { loadMigrationFile } = require('../utils/loader.js');
const { resolveLogger } = require('../utils/logger.js');
const {
  createConfigFile,
  createMigrationFile,
  maskUriCredentials,
} = require('../utils/template.js');
const { Changelog } = require('./changelog.js');
const { isCollectionName, loadConfig } = require('./config.js');
const { buildContext } = require('./context.js');
const { isMigrateMongoDoc, mapMigrateMongoDocs } = require('./import.js');
const { MigrationLock, runWithLock, toLockInfo } = require('./lock.js');
const { runMigration } = require('./runner.js');

/** Default source collection name used by migrate-mongo */
const MIGRATE_MONGO_COLLECTION = 'changelog';

/**
 * The main orchestration class. Every CLI command delegates here. Holds a
 * partial config that is resolved (merged with env/file/defaults) on first use.
 */
class MigratorKit {
  #partialConfig;
  #configPath;
  #progress;
  #config;
  #client;
  #db;
  #changelog;

  constructor(config = {}, options = {}) {
    this.#partialConfig = config;
    this.#configPath = options.configPath;
    this.#progress = options.progress;
  }

  /** Resolve and cache the full configuration */
  async #ensureConfig(requireDb = true) {
    if (!this.#config) {
      this.#config = await loadConfig({
        flags: this.#partialConfig,
        requireDb,
        ...(this.#configPath ? { configPath: this.#configPath } : {}),
      });
    }
    return this.#config;
  }

  get #logger() {
    return resolveLogger(this.#config?.logger);
  }

  /** Connect to MongoDB and ensure changelog indexes exist */
  async connect() {
    const config = await this.#ensureConfig();
    if (this.#client && this.#db) {
      return;
    }
    try {
      this.#client = new MongoClient(config.uri);
      await this.#client.connect();
      this.#db = this.#client.db(config.dbName);
      this.#changelog = new Changelog(config.migrationsCollection);
      await this.#changelog.ensureIndexes(this.#db);
    } catch (error) {
      throw new ConnectionFailedError('Failed to connect to MongoDB', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Disconnect from MongoDB */
  async disconnect() {
    if (this.#client) {
      await this.#client.close();
      this.#client = undefined;
      this.#db = undefined;
    }
  }

  /** Build a lock bound to the configured collection (assumes connected) */
  #buildLock() {
    const config = this.#config;
    return new MigrationLock(this.#requireDb(), config.lockCollection, config.lockTTLSeconds);
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
   * Resolve a migration name to an absolute path inside the migrations dir.
   *
   * The name must be a bare filename: a name containing a path separator, a
   * NUL byte, or `.`/`..` is rejected with MigrationInvalidNameError.
   * This prevents path traversal — e.g. `migronaut up ../../evil.js` would otherwise
   * resolve (and `loadMigrationFile` execute) a file outside the migrations
   * directory. A final containment check guards against any residual escape.
   */
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
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const matches = [];
    for (const file of files) {
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
    const records = await this.#requireChangelog().getAll(this.#requireDb());
    let maxBatch = 0;
    for (const record of records) {
      if (record.batch > maxBatch) maxBatch = record.batch;
    }
    return maxBatch + 1;
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
   * Select the last N applied migrations, newest first (by `appliedAt`, tie-broken
   * by name desc), ignoring batch grouping. Shared by `down --steps` and its dry-run.
   */
  #selectLastApplied(records, steps) {
    const applied = [];
    for (const record of records) {
      if (record.status === 'applied') applied.push(record);
    }
    return applied
      .sort((a, b) => {
        const byTime = b.appliedAt.getTime() - a.appliedAt.getTime();
        return byTime !== 0 ? byTime : b.name.localeCompare(a.name);
      })
      .slice(0, steps);
  }

  /** Run all pending migrations, or a specific named file */
  async up(filename, options = {}) {
    this.#assertFilename(filename);
    const config = await this.#ensureConfig();
    await this.connect();
    const lock = new MigrationLock(this.#requireDb(), config.lockCollection, config.lockTTLSeconds);
    return runWithLock(
      lock,
      { logger: this.#logger, ...(options.noLock ? { noLock: true } : {}) },
      () => this.#runUp(filename, options),
    );
  }

  async #runUp(filename, options = {}) {
    const force = options.force ?? false;
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    const appliedNames = new Set(await changelog.getAppliedNames(db));

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
    }

    if (targets.length === 0) {
      logger.info('Nothing to migrate');
      return [];
    }

    const context = buildContext(this.#client, db, config.mongoose);
    const results = [];
    // Without --step every file in this run shares one batch. With --step each
    // applied file gets its own sequential batch (base, base+1, …) so a later
    // `down` can revert them individually. Only successful applies advance the
    // counter, so --step never leaves gaps.
    const baseBatch = await this.#nextBatch();
    let appliedCount = 0;

    await config.hooks?.beforeAll?.(context);

    for (const name of targets) {
      await config.hooks?.beforeEach?.(name, context);
      const filepath = this.#filepath(name);
      const checksum = await computeChecksum(filepath);

      if (appliedNames.has(name)) {
        if (!force) {
          const existing = await changelog.getByName(db, name);
          const mismatch = existing !== null && existing.checksum !== checksum;
          if (mismatch && config.strict) {
            throw new ChecksumMismatchError(`Checksum mismatch for ${name}`, {
              name,
              expected: existing?.checksum,
              actual: checksum,
            });
          }
          if (mismatch) {
            logger.warn(`⚠ Warning  Checksum mismatch: ${name}`);
          }
          logger.debug(`⏭ Skipped  ${name}`);
          results.push({ file: name, status: 'skipped', reason: 'Already applied' });
          continue;
        }
        // force: fall through and re-run, ignoring applied state and checksum
        logger.warn(`⚠ Forcing   re-run of already-applied ${name}`);
      }

      const migration = await loadMigrationFile(filepath);
      const useTransaction = migration.useTransaction ?? config.useTransaction;

      this.#progress?.onStart(name, 'up');
      try {
        const { duration } = await runMigration({
          name,
          migration,
          direction: 'up',
          context,
          useTransaction,
          ...(config.hooks ? { hooks: config.hooks } : {}),
        });
        this.#progress?.onStop();

        const batch = options.step ? baseBatch + appliedCount : baseBatch;
        const record = {
          name,
          batch,
          status: 'applied',
          appliedAt: new Date(),
          duration,
          checksum,
          environment: process.env.NODE_ENV ?? 'development',
          executedBy: os.userInfo().username,
          ...(migration.description ? { description: migration.description } : {}),
        };
        await changelog.markApplied(db, record);
        appliedCount += 1;

        logger.info(`✔ Applied  ${name}   [${duration}ms]`);
        results.push({ file: name, status: 'applied', duration, batch });
        await config.hooks?.afterEach?.(name, duration, context);
      } catch (error) {
        this.#progress?.onStop();
        logger.error(`✖ Error    ${name}`);
        results.push({
          file: name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    await config.hooks?.afterAll?.(context);
    return results;
  }

  /** Rollback the last batch, a specific batch, a specific file, or the last N steps */
  async down(filename, options = {}) {
    this.#assertFilename(filename);
    this.#assertStepsValid(options.steps, filename, options.batch);
    const config = await this.#ensureConfig();
    await this.connect();
    const lock = new MigrationLock(this.#requireDb(), config.lockCollection, config.lockTTLSeconds);
    return runWithLock(
      lock,
      { logger: this.#logger, ...(options.noLock ? { noLock: true } : {}) },
      () => this.#runDown(filename, options),
    );
  }

  async #runDown(filename, options = {}) {
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    let toRevert;
    // When true, `toRevert` is already in revert order (newest applied first) and
    // must not be re-sorted by filename below.
    let preserveOrder = false;
    if (filename) {
      const record = await changelog.getByName(db, filename);
      if (!record || record.status !== 'applied') {
        throw new NotAppliedError('Migration is not applied', { filename });
      }
      toRevert = [record];
    } else if (options.steps !== undefined) {
      // Revert the last N applied migrations, newest first, ignoring batches.
      toRevert = this.#selectLastApplied(await changelog.getAll(db), options.steps);
      preserveOrder = true;
    } else {
      const batch = options.batch ?? (await changelog.getLastBatch(db));
      if (batch === null) {
        logger.info('Nothing to rollback');
        return [];
      }
      const records = await changelog.getByBatch(db, batch);
      toRevert = [];
      for (const record of records) {
        if (record.status === 'applied') toRevert.push(record);
      }
    }

    if (toRevert.length === 0) {
      logger.info('Nothing to rollback');
      return [];
    }

    // Preflight, before running or writing anything: migrate-mongo-imported
    // records are forward-only. Refuse the whole rollback up front with a clear
    // reason so the changelog and collection are never left half-reverted.
    this.#assertReversible(toRevert);

    const names = [];
    for (const record of toRevert) names.push(record.name);
    if (!preserveOrder) {
      names.sort();
      names.reverse();
    }

    const context = buildContext(this.#client, db, config.mongoose);
    const results = [];

    await config.hooks?.beforeAll?.(context);

    for (const name of names) {
      await config.hooks?.beforeEach?.(name, context);
      const migration = await loadMigrationFile(this.#filepath(name));
      const useTransaction = migration.useTransaction ?? config.useTransaction;

      this.#progress?.onStart(name, 'down');
      try {
        const { duration } = await runMigration({
          name,
          migration,
          direction: 'down',
          context,
          useTransaction,
          ...(config.hooks ? { hooks: config.hooks } : {}),
        });
        this.#progress?.onStop();
        await changelog.markReverted(db, name);
        logger.info(`↩ Reverted ${name}   [${duration}ms]`);
        results.push({ file: name, status: 'reverted', duration });
        await config.hooks?.afterEach?.(name, duration, context);
      } catch (error) {
        this.#progress?.onStop();
        logger.error(`✖ Error    ${name}`);
        results.push({
          file: name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    await config.hooks?.afterAll?.(context);
    return results;
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

  /** Rollback then re-apply: the last applied migration, or a specific file */
  async redo(filename) {
    this.#assertFilename(filename);
    await this.#ensureConfig();
    await this.connect();
    const changelog = this.#requireChangelog();

    let target = filename;
    if (!target) {
      const records = await changelog.getAll(this.#requireDb());
      const applied = [];
      for (const record of records) {
        if (record.status === 'applied') applied.push(record);
      }
      if (applied.length === 0) {
        this.#logger.info('Nothing to redo');
        return [];
      }
      applied.sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime());
      target = applied[applied.length - 1]?.name;
    }

    if (!target) {
      return [];
    }

    const downResults = await this.down(target);
    const upResults = await this.up(target);
    return [...downResults, ...upResults];
  }

  /** Preview what would run — never writes to the database */
  async dryRun(direction, filename, options = {}) {
    this.#assertFilename(filename);
    this.#assertStepsValid(options.steps, filename);
    await this.#ensureConfig();
    await this.connect();
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    const records = await changelog.getAll(db);
    const recordByName = new Map();
    for (const record of records) {
      recordByName.set(record.name, record);
    }

    let names;
    if (direction === 'up') {
      const applied = new Set();
      for (const record of records) {
        if (record.status === 'applied') applied.add(record.name);
      }
      if (filename) {
        names = [filename];
      } else {
        const files = await this.#listMigrationFiles();
        names = [];
        for (const file of files) {
          if (!applied.has(file)) names.push(file);
        }
      }
    } else if (options.steps !== undefined) {
      // Mirror `down --steps`: the last N applied migrations, newest first.
      names = [];
      for (const record of this.#selectLastApplied(records, options.steps)) {
        names.push(record.name);
      }
    } else {
      const lastBatch = await changelog.getLastBatch(db);
      if (filename) {
        names = [filename];
      } else if (lastBatch === null) {
        names = [];
      } else {
        names = [];
        for (const record of await changelog.getByBatch(db, lastBatch)) {
          if (record.status === 'applied') names.push(record.name);
        }
      }
    }

    const rowPromises = [];
    for (const name of names) {
      rowPromises.push(this.#buildStatusRow(name, recordByName.get(name)));
    }
    const rows = await Promise.all(rowPromises);
    logger.info(`◎ Dry-run  Would ${direction === 'up' ? 'apply' : 'revert'}: ${rows.length}`);
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
    const rowPromises = [];
    for (const name of sortedNames) {
      rowPromises.push(this.#buildStatusRow(name, recordByName.get(name)));
    }
    return Promise.all(rowPromises);
  }

  /** Filtered list of migrations */
  async list(filter) {
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

  /** Build a StatusRow for a migration, verifying checksum when possible */
  async #buildStatusRow(name, record) {
    const filepath = this.#filepath(name);
    const fileExists = await fs
      .access(filepath)
      .then(() => true)
      .catch(() => false);
    const isApplied = record?.status === 'applied';

    let checksumOk = null;
    if (isApplied && record && fileExists) {
      checksumOk = (await computeChecksum(filepath)) === record.checksum;
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

  /** Create a new migration file and return its absolute path */
  async create(name, options = {}) {
    const config = await this.#ensureConfig(false);
    const dir = this.#migrationsPath();
    await fs.mkdir(dir, { recursive: true });
    const templatePath = options.template ?? config.templatePath;
    const js = options.js ?? config.createExtension === 'js';
    const filepath = await createMigrationFile({
      dir,
      name,
      sequential: config.sequential,
      js,
      ...(templatePath ? { templatePath } : {}),
    });
    this.#logger.info(`✔ Created  ${path.basename(filepath)}`);
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
    this.#logger.info(`✔ Created  ${path.basename(filepath)}`);
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
    const config = await this.#ensureConfig();
    await this.connect();
    const lock = new MigrationLock(this.#requireDb(), config.lockCollection, config.lockTTLSeconds);
    return runWithLock(
      lock,
      { logger: this.#logger, ...(options.noLock ? { noLock: true } : {}) },
      () => this.#runImport(options),
    );
  }

  async #runImport(options) {
    const config = this.#config;
    const db = this.#requireDb();
    const changelog = this.#requireChangelog();
    const logger = this.#logger;

    const source = options.from ?? MIGRATE_MONGO_COLLECTION;
    const target = options.to ?? config.migrationsCollection;
    const dryRun = options.dryRun ?? false;

    // Records are written to `target`; reuse the connected changelog when it
    // already points there, otherwise bind a fresh one (and ensure its index).
    const targetChangelog =
      target === config.migrationsCollection ? changelog : new Changelog(target);
    // ensureIndexes (target) and getForeignDocs (source) touch unrelated
    // collections — independent, safe to run concurrently.
    const ensureIndexesPromise =
      targetChangelog !== changelog && !dryRun
        ? targetChangelog.ensureIndexes(db)
        : Promise.resolve();
    const [, rawDocs] = await Promise.all([
      ensureIndexesPromise,
      changelog.getForeignDocs(db, source),
    ]);
    if (rawDocs.length === 0) {
      logger.info(`Nothing to import from "${source}"`);
      return { source, target, imported: 0, skipped: 0, dryRun, rows: [] };
    }

    const valid = [];
    let skipped = 0;
    for (const doc of rawDocs) {
      if (isMigrateMongoDoc(doc)) {
        valid.push(doc);
      } else {
        skipped += 1;
        logger.warn('⚠ Skipping source doc without a usable fileName');
      }
    }

    const existing = await targetChangelog.getAll(db);
    if (!options.force && !dryRun && existing.length > 0) {
      throw new ImportTargetNotEmptyError(
        `Target collection "${target}" already has ${existing.length} record(s) — re-run with force to proceed`,
        { target, existing: existing.length },
      );
    }

    // Continue batch numbering after the batches already in the target so imported
    // records never collide with existing ones. Records this import will overwrite
    // (same name) are excluded, keeping a forced re-import's batch numbers stable.
    const incomingNames = new Set();
    for (const doc of valid) incomingNames.add(doc.fileName);
    let batchOffset = 0;
    for (const record of existing) {
      if (!incomingNames.has(record.name) && record.batch > batchOffset) {
        batchOffset = record.batch;
      }
    }

    const rowSources = new Map();
    const records = await mapMigrateMongoDocs(valid, {
      environment: 'imported',
      executedBy: 'migronaut-import',
      batchOffset,
      resolveChecksum: async (fileName, fileHash) => {
        const resolved = await this.#resolveImportChecksum(
          fileName,
          fileHash,
          options.trustHash ?? false,
        );
        rowSources.set(fileName, resolved.source);
        if (resolved.source === 'missing') {
          logger.warn(`⚠ File not found on disk: ${fileName} — checksum unverifiable`);
        }
        return resolved;
      },
    });

    const rows = [];
    for (const record of records) {
      rows.push({
        file: record.name,
        batch: record.batch,
        appliedAt: record.appliedAt,
        checksum: record.checksum,
        checksumSource: rowSources.get(record.name) ?? 'missing',
      });
    }

    if (dryRun) {
      logger.info(
        `◎ Dry-run  Would import ${rows.length} record(s) from "${source}" → "${target}"`,
      );
      return { source, target, imported: 0, skipped, dryRun, rows };
    }

    // Independent upserts keyed by unique `name` — safe to run concurrently.
    // Promise.all (not allSettled) preserves the previous loop's fail-fast behavior.
    const writes = [];
    for (const record of records) writes.push(targetChangelog.markApplied(db, record));
    await Promise.all(writes);

    logger.info(`✔ Imported ${records.length} record(s) from "${source}" → "${target}"`);
    return { source, target, imported: records.length, skipped, dryRun, rows };
  }

  /**
   * Decide the checksum to store for an imported migration. Order: when
   * `trustHash`, reuse the source `fileHash` if present; otherwise reuse it only
   * when it matches a freshly computed hash (algorithms align), else recompute
   * from disk; when the file is missing, fall back to the source hash or empty.
   */
  async #resolveImportChecksum(fileName, fileHash, trustHash) {
    const filepath = this.#filepath(fileName);

    if (trustHash && fileHash) {
      return { checksum: fileHash, source: 'reused' };
    }
    const exists = await fs
      .access(filepath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const recomputed = await computeChecksum(filepath);
      if (fileHash && fileHash === recomputed) {
        return { checksum: fileHash, source: 'reused' };
      }
      return { checksum: recomputed, source: 'recomputed' };
    }
    if (fileHash) {
      return { checksum: fileHash, source: 'reused' };
    }
    return { checksum: '', source: 'missing' };
  }
}

module.exports = { MigratorKit };
