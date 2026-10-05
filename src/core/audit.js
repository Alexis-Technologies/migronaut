const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { SEARCH_UNAVAILABLE_HINT, listSearchIndexes, probeSearch } = require('./converge-search.js');
const { toLockInfo } = require('./lock.js');
const { normalizeLiveSearchIndex, searchBuildState } = require('./search-index-spec.js');
const { READ_OPTIONS, readServer } = require('./server-info.js');

/** Changelog indexes ensureIndexes() creates — audit warns when any is absent */
const EXPECTED_INDEXES = [
  'name_unique',
  'status_batch',
  'batch',
  'status_name',
  'status_appliedAt_name',
];

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
async function runAudit(deps) {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Configuration. Everything downstream depends on it, so a failure here
  //    is fatal to the audit itself.
  let config;
  try {
    config = await deps.ensureConfig();
    record('config', 'pass', `Loaded (database "${config.dbName}")`);
  } catch (error) {
    record('config', 'fail', errorText(error));
    return auditReport(checks);
  }

  // 2. Connectivity.
  try {
    await deps.connect();
    record('connection', 'pass', config.client ? 'Using the injected client' : 'Connected');
  } catch (error) {
    record('connection', 'fail', errorText(error));
    return auditReport(checks);
  }

  const db = deps.getDb();

  // 3. Transactions need a replica set or a sharded cluster; on a standalone
  //    server `useTransaction: true` fails at run time with a driver error
  //    that says nothing about the configuration.
  try {
    const info = await db.admin().command({ hello: 1 });
    const supportsTransactions = Boolean(info.setName) || info.msg === 'isdbgrid';
    if (supportsTransactions) {
      record('transactions', 'pass', info.setName ? `Replica set "${info.setName}"` : 'Sharded');
    } else if (config.useTransaction) {
      record('transactions', 'fail', 'useTransaction is on, but this is a standalone server');
    } else {
      record('transactions', 'warn', 'Standalone server — useTransaction is unavailable');
    }
  } catch (error) {
    record('transactions', 'warn', `Could not determine topology: ${errorText(error)}`);
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
    record('indexes', 'warn', `Could not read indexes: ${errorText(error)}`);
  }

  // 5. Lock. A held lock is not itself a problem — a stale one is.
  try {
    const holder = toLockInfo(await deps.inspectLock());
    if (!holder) {
      record('lock', 'pass', 'No lock held');
    } else {
      const ageSeconds = Math.round((Date.now() - holder.lockedAt.getTime()) / 1000);
      const stale = ageSeconds > config.lockTTLSeconds;
      record(
        'lock',
        stale ? 'warn' : 'pass',
        `Held by pid ${holder.pid} on ${holder.host} for ${ageSeconds}s` +
          (stale ? ' — past its TTL, likely from a crashed run (migronaut unlock)' : ''),
      );
    }
  } catch (error) {
    record('lock', 'warn', `Could not read the lock: ${errorText(error)}`);
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
    record('checksums', 'warn', `Could not read status: ${errorText(error)}`);
  }

  // 7. Search — only where declared collections hold search indexes.
  await auditSearch(deps, db, config, record);

  // 8. Runtime. TypeScript migrations need a runtime that can strip types.
  // Feature detection instead of version parsing: it also catches a run
  // under `--no-experimental-strip-types` on an otherwise capable Node.
  const nodeVersion = process.versions.node;
  const wantsTs = (config.fileExtensions ?? []).includes('.ts');
  const stripsTypes = Boolean(process.features.typescript);
  if (wantsTs && !stripsTypes) {
    record(
      'runtime',
      'warn',
      `Node ${nodeVersion} cannot import .ts here — type stripping is unavailable or disabled; re-enable it or use a loader such as tsx`,
    );
  } else {
    record('runtime', 'pass', `Node ${nodeVersion}`);
  }

  return auditReport(checks);
}

/** Search index lists the audit reads at once */
const AUDIT_READ_CONCURRENCY = 8;

/**
 * Whether the server has the Atlas Search that declared search indexes need,
 * and whether any of them failed to build. Records nothing when none is
 * declared — or when the definitions do not load: converge reports that
 * itself, with every issue.
 */
async function auditSearch(deps, db, config, record) {
  if (typeof deps.definitions !== 'function') return;
  let definitions;
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
      const skip = config.onSearchUnavailable === 'skip';
      record(
        'search',
        skip ? 'warn' : 'fail',
        `Not available on this server (${probe.reason}) — ${counted}; ` +
          (skip
            ? "converge skips them (onSearchUnavailable: 'skip')"
            : `converge refuses them: ${SEARCH_UNAVAILABLE_HINT}`),
      );
      return;
    }
    const failed = [];
    const stale = [];
    // One list per collection, a few at a time; reported in declaration order.
    const lists = await mapLimit(declaring, AUDIT_READ_CONCURRENCY, ({ definition }) =>
      listSearchIndexes(db, definition.name, READ_OPTIONS),
    );
    for (const [position, { definition, names }] of declaring.entries()) {
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
    record('search', 'warn', `Could not check Atlas Search: ${errorText(error)}`);
  }
}

/** Roll individual checks up into the report shape (one pass, both counters) */
function auditReport(checks) {
  let failed = 0;
  let warnings = 0;
  for (const check of checks) {
    if (check.status === 'fail') failed += 1;
    else if (check.status === 'warn') warnings += 1;
  }
  return { ok: failed === 0, failed, warnings, checks };
}

module.exports = { runAudit };
