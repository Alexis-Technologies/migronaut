const { mapLimit } = require('../utils/concurrency.js');
const { formatError } = require('../utils/error.js');
const { SEARCH_UNAVAILABLE_HINT, listSearchIndexes, probeSearch } = require('./converge/search.js');
const { toLockInfo } = require('./lock.js');
const { normalizeLiveSearchIndex, searchBuildState } = require('./converge/search-index-spec.js');
const { READ_OPTIONS, readServer } = require('./server-info.js');

/** Changelog indexes ensureIndexes() creates — audit warns when any is absent */
const EXPECTED_INDEXES = [
  'name_unique',
  'status_batch',
  'batch',
  'status_name',
  'status_appliedAt_name',
];

/** Search index lists the audit reads at once */
const AUDIT_READ_CONCURRENCY = 8;

/**
 * Read-only health check of the setup: configuration, connectivity,
 * transaction support, indexes, lock state, checksum drift — and Atlas Search,
 * when declared collections hold search indexes.
 *
 * Fixes nothing — it reports, so an operator can see in one command why a
 * migration would fail before running one. Every check is independent: a
 * failure in one is recorded and the rest still run.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`), so it
 * needs none of the kit's private state. `deps.definitions()` (optional) gives
 * the declared collections, for the search check.
 */
const runAudit = async (deps) => {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Configuration. Everything downstream depends on it, so a failure here
  //    is fatal to the audit itself.
  let config = null;
  try {
    config = await deps.ensureConfig();
    record('config', 'pass', `Loaded (database "${config.dbName}")`);
  } catch (error) {
    record('config', 'fail', formatError(error));
    return summarizeAudit(checks);
  }

  // 2. Connectivity.
  try {
    await deps.connect();
    record('connection', 'pass', config.client ? 'Using the injected client' : 'Connected');
  } catch (error) {
    record('connection', 'fail', formatError(error));
    return summarizeAudit(checks);
  }

  const db = deps.getDb();

  // 3. Transactions need a replica set or a sharded cluster; on a standalone
  //    server `useTransaction: true` fails at run time with a driver error
  //    that says nothing about the configuration.
  try {
    const info = await db.admin().command({ hello: 1 });
    const canUseTransactions = Boolean(info.setName) || info.msg === 'isdbgrid';
    if (canUseTransactions) {
      record('transactions', 'pass', info.setName ? `Replica set "${info.setName}"` : 'Sharded');
    } else if (config.useTransaction) {
      record('transactions', 'fail', 'useTransaction is on, but this is a standalone server');
    } else {
      record('transactions', 'warn', 'Standalone server — useTransaction is unavailable');
    }
  } catch (error) {
    record('transactions', 'warn', `Could not determine topology: ${formatError(error)}`);
  }

  // 4. Indexes. Missing ones do not break correctness, only performance.
  try {
    const present = new Set();
    for (const index of await db.collection(config.migrationsCollection).indexes()) {
      present.add(index.name);
    }
    const missing = [];
    for (const name of EXPECTED_INDEXES) {
      if (!present.has(name)) missing.push(name);
    }
    if (missing.length === 0) record('indexes', 'pass', 'All changelog indexes present');
    else record('indexes', 'warn', `Missing: ${missing.join(', ')}`);
  } catch (error) {
    record('indexes', 'warn', `Could not read indexes: ${formatError(error)}`);
  }

  // 5. Lock. A held lock is not itself a problem — a stale one is. Stale by
  //    the holder's own TTL and the server's clock: a run with a five-minute
  //    TTL renews every 150 s, and an auditor judging it by its own 60 s (or
  //    by a clock a minute off) would call a live run crashed — and advise
  //    the `unlock` that lets a second run in beside it.
  try {
    const doc = await deps.inspectLock();
    const holder = toLockInfo(doc);
    if (!holder) {
      record('lock', 'pass', 'No lock held');
    } else {
      const ageMs = Number.isFinite(Number(doc.ageMs))
        ? Number(doc.ageMs)
        : Date.now() - holder.lockedAt.getTime();
      const ageSeconds = Math.round(ageMs / 1000);
      const ttlMs = holder.ttlMs ?? config.lockTTLSeconds * 1000;
      const isStale = ageMs > ttlMs;
      // A holder from a release that wrote no TTL: only this configuration's
      // is known, and it may not be the holder's.
      const advice =
        holder.ttlMs === undefined
          ? ` — past this configuration's TTL (${ttlMs / 1000}s); if its run uses a longer ` +
            'one it may be alive — make sure it is not before migronaut unlock'
          : ` — past its TTL (${ttlMs / 1000}s), likely from a crashed run (migronaut unlock)`;
      record(
        'lock',
        isStale ? 'warn' : 'pass',
        `Held by pid ${holder.pid} on ${holder.host} for ${ageSeconds}s${isStale ? advice : ''}`,
      );
    }
  } catch (error) {
    record('lock', 'warn', `Could not read the lock: ${formatError(error)}`);
  }

  // 6. Checksum drift, missing files, pending count and ordering, from the
  //    same rows `status` renders.
  try {
    const rows = await deps.status();
    // One pass over the rows collects every signal.
    const drifted = [];
    const outOfOrder = [];
    let pending = 0;
    for (const row of rows) {
      if (row.checksumOk === false) drifted.push(row.file);
      // A recorded failed attempt still counts as pending work — the file
      // will be retried by the next `up`.
      if (row.status === 'pending' || row.status === 'failed') pending += 1;
      if (row.outOfOrder) outOfOrder.push(row.file);
    }
    if (drifted.length > 0) {
      record('checksums', 'fail', `Edited after being applied: ${drifted.join(', ')}`);
    } else {
      record('checksums', 'pass', 'No drift among applied migrations');
    }
    record('pending', pending === 0 ? 'pass' : 'warn', `${pending} pending migration(s)`);
    if (outOfOrder.length > 0) {
      record(
        'ordering',
        'warn',
        `Pending but older than the newest applied migration: ${outOfOrder.join(', ')}`,
      );
    } else {
      record('ordering', 'pass', 'No out-of-order pending migrations');
    }
  } catch (error) {
    record('checksums', 'warn', `Could not read status: ${formatError(error)}`);
  }

  // 7. Search — only where declared collections hold search indexes.
  await auditSearch(deps, db, config, record);

  // 8. Background migrations — only where any is registered.
  if (typeof deps.background === 'function') {
    try {
      const finding = await deps.background();
      if (finding !== null) record('background', finding.status, finding.detail);
    } catch (error) {
      record('background', 'warn', `Could not check background migrations: ${formatError(error)}`);
    }
  }

  // 9. Runtime. TypeScript migrations need a runtime that can strip types.
  // Feature detection instead of version parsing: it also catches a run
  // under `--no-experimental-strip-types` on an otherwise capable Node.
  const nodeVersion = process.versions.node;
  const hasTsExtension = (config.fileExtensions ?? []).includes('.ts');
  const canStripTypes = Boolean(process.features.typescript);
  if (hasTsExtension && !canStripTypes) {
    record(
      'runtime',
      'warn',
      `Node ${nodeVersion} cannot import .ts here — type stripping is unavailable or disabled; re-enable it or use a loader such as tsx`,
    );
  } else {
    record('runtime', 'pass', `Node ${nodeVersion}`);
  }

  return summarizeAudit(checks);
};

/**
 * Whether the server has the Atlas Search that declared search indexes need,
 * and whether any of them failed to build. Records nothing when none is
 * declared — or when the definitions do not load: converge reports that
 * itself, with every issue.
 */
const auditSearch = async (deps, db, config, record) => {
  if (typeof deps.definitions !== 'function') return;
  let definitions = null;
  try {
    definitions = await deps.definitions();
  } catch {
    return;
  }
  // One pass: the collections that declare search indexes, the names each
  // declares, and how many there are in all.
  const declaring = [];
  let declared = 0;
  for (const definition of definitions) {
    if (definition.searchIndexes === undefined) continue;
    const names = new Set();
    for (const index of definition.searchIndexes) names.add(index.name);
    declaring.push({ definition, names });
    declared += definition.searchIndexes.length;
  }
  if (declaring.length === 0) return;
  const counted = `${declared} search index(es) declared in ${declaring.length} collection(s)`;
  try {
    const probe = await probeSearch(db, await readServer(db), {
      collection: declaring[0].definition.name,
      readOptions: READ_OPTIONS,
    });
    if (!probe.available) {
      const shouldSkip = config.onSearchUnavailable === 'skip';
      return void record(
        'search',
        shouldSkip ? 'warn' : 'fail',
        `Not available on this server (${probe.reason}) — ${counted}; ` +
          (shouldSkip
            ? "converge skips them (onSearchUnavailable: 'skip')"
            : `converge refuses them: ${SEARCH_UNAVAILABLE_HINT}`),
      );
    }
    const failed = [];
    const stale = [];
    // One list per collection, a few at a time; reported in declaration order.
    const lists = await mapLimit(declaring, AUDIT_READ_CONCURRENCY, ({ definition }) => {
      return listSearchIndexes(db, definition.name, READ_OPTIONS);
    });
    for (let position = 0; position < declaring.length; position++) {
      const { definition, names } = declaring[position];
      for (const raw of lists[position]) {
        const index = normalizeLiveSearchIndex(raw);
        if (!names.has(index.name)) continue;
        const state = searchBuildState(index);
        const label = `${definition.name}.${index.name}${index.message ? ` (${index.message})` : ''}`;
        if (state === 'failed') failed.push(label);
        else if (state === 'stale') stale.push(label);
      }
    }
    if (failed.length > 0 || stale.length > 0) {
      const parts = [];
      if (failed.length > 0) parts.push(`failed to build: ${failed.join(', ')}`);
      if (stale.length > 0) parts.push(`stale (not replicating): ${stale.join(', ')}`);
      record('search', 'warn', `Available — ${parts.join('; ')}`);
    } else {
      record('search', 'pass', `Available — ${counted}`);
    }
  } catch (error) {
    record('search', 'warn', `Could not check Atlas Search: ${formatError(error)}`);
  }
};

/** Roll individual checks up into the report shape (one pass, both counters) */
const summarizeAudit = (checks) => {
  let failed = 0;
  let warnings = 0;
  for (const check of checks) {
    if (check.status === 'fail') failed += 1;
    else if (check.status === 'warn') warnings += 1;
  }
  return { ok: failed === 0, failed, warnings, checks };
};

module.exports = { runAudit };
