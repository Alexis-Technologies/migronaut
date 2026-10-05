const { ConfigInvalidError, MigrationInvalidNameError } = require('../errors/index.js');
const { actorIssue } = require('../utils/actor.js');
const { isCollectionName } = require('../utils/collection-name.js');

/**
 * Validation of the options the kit's run methods take. Pure — no config, no
 * database, no file system — so every one runs before a run method resolves
 * its config or connects: a caller mistake costs neither a round trip nor the
 * lock, and is reported as itself rather than as whatever it would have
 * broken later.
 *
 * Each `assert*Options` is the whole preamble of one method, its checks in
 * the order that decides which error a caller sees when several apply.
 */

/**
 * Reject non-string filenames before they reach a changelog query or a path
 * join. A programmatic caller passing e.g. `{ $ne: null }` would otherwise
 * become a query-operator injection in `findOne({ name })`.
 */
function assertFilename(filename) {
  if (filename !== undefined && typeof filename !== 'string') {
    throw new MigrationInvalidNameError('Migration name must be a string', {
      name: filename,
    });
  }
}

/**
 * Validate the `--steps` option for `down`/`dry-run down`: a positive integer,
 * mutually exclusive with a filename and `--batch`. No-op when steps is unset.
 */
function assertStepsValid(steps, filename, batch) {
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
 * `--to` names a point in the sequence, so it cannot be combined with the
 * other ways of choosing targets.
 */
function assertToValid(to, filename, options = {}) {
  if (to === undefined) return;
  assertFilename(to);
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
function assertBatchValid(batch) {
  if (batch === undefined) return;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new ConfigInvalidError('--batch must be a positive integer', { batch });
  }
}

/**
 * Validate `requestedBy` / `reason`: who asked for a run, and why — stamped
 * on what it writes to the changelog (and on a converge's history entry).
 * The OS user that ran it is `executedBy` already; on a queue worker that is
 * the container's, which is why the requester has a field of its own.
 */
function assertActorValid(options) {
  for (const key of ['requestedBy', 'reason']) {
    const issue = actorIssue(key, options?.[key]);
    if (issue) {
      throw new ConfigInvalidError(issue, {
        [key]:
          typeof options[key] === 'string'
            ? `${options[key].length} characters`
            : typeof options[key],
      });
    }
  }
}

/**
 * Validate `checksum`: the SHA-256 the caller expects the named file to have
 * — how a queue job says which version of the file it was planned with.
 */
function assertChecksumValid(checksum, filename) {
  if (checksum === undefined) return;
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new ConfigInvalidError('checksum must be a SHA-256 hex digest', {
      checksum: typeof checksum,
    });
  }
  if (!filename) {
    throw new ConfigInvalidError('checksum requires a filename', {});
  }
}

/**
 * Validate `ordered`: a boolean, and only meaningful for a named file — a
 * bulk run is in order by construction, so asking for it there is a caller
 * mistake worth naming rather than silently ignoring.
 */
function assertOrderedValid(ordered, filename) {
  if (ordered === undefined) return;
  if (typeof ordered !== 'boolean') {
    throw new ConfigInvalidError('ordered must be a boolean', { ordered });
  }
  if (ordered && !filename) {
    throw new ConfigInvalidError('ordered requires a filename', { ordered });
  }
}

/** `up`'s `converge` option: a boolean, and only for a bulk run that reaches the head */
function assertConvergeAfterUpValid(converge, filename, to) {
  if (converge === undefined) return;
  if (typeof converge !== 'boolean') {
    throw new ConfigInvalidError('converge must be a boolean', { converge });
  }
  if (converge && filename !== undefined) {
    throw new ConfigInvalidError('converge cannot follow a single-file up', {
      converge,
      filename,
    });
  }
  if (converge && to !== undefined) {
    throw new ConfigInvalidError(
      'converge cannot follow up --to: the declared state describes the newest migration',
      { converge, to },
    );
  }
}

/**
 * `onBackgroundPending`: what a run does at a migration that `requires` a
 * background migration not completed yet — `'error'` (throw
 * BackgroundPendingError) or `'stop'` (end the run there, cleanly).
 */
function assertBackgroundPendingValid(onBackgroundPending) {
  if (onBackgroundPending === undefined) return;
  if (onBackgroundPending !== 'error' && onBackgroundPending !== 'stop') {
    throw new ConfigInvalidError("onBackgroundPending must be 'error' or 'stop'", {
      onBackgroundPending,
    });
  }
}

/** `up(filename, options)` */
function assertUpOptions(filename, options) {
  assertFilename(filename);
  // `to` is checked against a filename only: unlike `down`, an explicit
  // `batch` here is a label for whatever gets applied, not a selector.
  assertToValid(options.to, filename);
  assertBatchValid(options.batch);
  if (options.batch !== undefined && options.step) {
    throw new ConfigInvalidError('Cannot combine --batch with --step', {
      batch: options.batch,
    });
  }
  assertOrderedValid(options.ordered, filename);
  assertConvergeAfterUpValid(options.converge, filename, options.to);
  assertChecksumValid(options.checksum, filename);
  assertBackgroundPendingValid(options.onBackgroundPending);
  assertActorValid(options);
}

/** `down(filename, options)` */
function assertDownOptions(filename, options) {
  assertFilename(filename);
  assertStepsValid(options.steps, filename, options.batch);
  assertBatchValid(options.batch);
  assertToValid(options.to, filename, options);
  assertOrderedValid(options.ordered, filename);
  assertActorValid(options);
}

/** `redo(filename, options)` */
function assertRedoOptions(filename, options) {
  assertFilename(filename);
  assertActorValid(options);
}

/** `dryRun(direction, filename, options)` */
function assertDryRunOptions(filename, options) {
  assertFilename(filename);
  // `batch`/`to` must be passed too, or a conflict that `down` rejects would
  // be silently allowed in its own preview.
  assertStepsValid(options.steps, filename, options.batch);
  assertBatchValid(options.batch);
  assertToValid(options.to, filename, options);
}

/** `converge(options)` */
function assertConvergeOptions(options) {
  for (const key of [
    'dryRun',
    'prune',
    'noLock',
    'ordered',
    'rebuildUnique',
    'waitForSearchIndexes',
  ]) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new ConfigInvalidError(`${key} must be a boolean`, { [key]: options[key] });
    }
  }
  // A dry run builds nothing, so there is nothing to wait for — asking for
  // both is a mistake worth saying, not a wait that silently never happens.
  if (options.dryRun && options.waitForSearchIndexes) {
    throw new ConfigInvalidError('waitForSearchIndexes cannot be combined with dryRun', {
      dryRun: true,
      waitForSearchIndexes: true,
    });
  }
  assertActorValid(options);
}

/** `convergeHistory({ limit })` */
function assertHistoryLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConfigInvalidError('limit must be an integer from 1 to 1000', { limit });
  }
}

/** `list(filter, options)` */
function assertListOptions(filter, options) {
  if (options.checksums !== undefined && typeof options.checksums !== 'boolean') {
    throw new ConfigInvalidError('checksums must be a boolean', { checksums: options.checksums });
  }
  // An unknown filter silently returning [] reads as "nothing to report" —
  // the worst possible answer to a typo.
  if (filter !== 'all' && filter !== 'pending' && filter !== 'applied') {
    throw new ConfigInvalidError("list filter must be 'all', 'pending' or 'applied'", { filter });
  }
}

/**
 * `import(options)`: a bad --from/--to must not cost a round trip or take the
 * lock. Defaults come from the already-validated config.
 */
function assertImportOptions(options) {
  if (options.from !== undefined && !isCollectionName(options.from)) {
    throw new ConfigInvalidError('Invalid source collection name', { from: options.from });
  }
  if (options.to !== undefined && !isCollectionName(options.to)) {
    throw new ConfigInvalidError('Invalid target collection name', { to: options.to });
  }
}

module.exports = {
  assertBackgroundPendingValid,
  assertConvergeOptions,
  assertDownOptions,
  assertDryRunOptions,
  assertFilename,
  assertHistoryLimit,
  assertImportOptions,
  assertListOptions,
  assertRedoOptions,
  assertUpOptions,
};
