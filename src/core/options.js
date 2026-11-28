const { ConfigInvalidError, MigrationInvalidNameError } = require('../errors/index.js');
const { ACTOR_FIELDS, checkActor } = require('../utils/actor.js');
const { isPlainObject } = require('../utils/canonical.js');
const { isCollectionName } = require('../utils/collection-name.js');
const { checkJobRef } = require('../utils/job-ref.js');

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

const UP_FLAGS = Object.freeze(['noLock', 'force', 'step']);

const LOCK_FLAGS = Object.freeze(['noLock']);

const IMPORT_FLAGS = Object.freeze(['noLock', 'dryRun', 'force', 'trustHash']);

const CONVERGE_FLAGS = Object.freeze([
  'dryRun',
  'prune',
  'noLock',
  'ordered',
  'rebuildUnique',
  'waitForSearchIndexes',
]);

/**
 * Reject non-string filenames before they reach a changelog query or a path
 * join. A programmatic caller passing e.g. `{ $ne: null }` would otherwise
 * become a query-operator injection in `findOne({ name })`.
 */
const assertFilename = (filename) => {
  if (filename !== undefined && typeof filename !== 'string') {
    throw new MigrationInvalidNameError('Migration name must be a string', {
      context: { name: filename },
    });
  }
};

/**
 * Validate the `--steps` option for `down`/`dry-run down`: a positive integer,
 * mutually exclusive with a filename and `--batch`. No-op when steps is unset.
 */
const assertStepsValid = (steps, filename, batch) => {
  if (steps === undefined) {
    return;
  }
  if (filename) {
    throw new ConfigInvalidError('Cannot combine a filename with --steps', {
      context: { filename },
    });
  }
  if (batch !== undefined) {
    throw new ConfigInvalidError('Cannot combine --batch with --steps', {
      context: { batch, steps },
    });
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new ConfigInvalidError('--steps must be a positive integer', { context: { steps } });
  }
};

/**
 * `--to` names a point in the sequence, so it cannot be combined with the
 * other ways of choosing targets.
 */
const assertToValid = (to, filename, options = {}) => {
  if (to === undefined) return;
  assertFilename(to);
  if (filename) {
    throw new ConfigInvalidError('Cannot combine a filename with --to', {
      context: { filename, to },
    });
  }
  if (options.steps !== undefined) {
    throw new ConfigInvalidError('Cannot combine --steps with --to', {
      context: { steps: options.steps, to },
    });
  }
  if (options.batch !== undefined) {
    throw new ConfigInvalidError('Cannot combine --batch with --to', {
      context: { batch: options.batch, to },
    });
  }
};

/**
 * Validate `--batch`. Without this a typo (`--batch abc` → NaN) matches no
 * records, so the run prints "Nothing to rollback" and exits 0 — the worst
 * possible answer to a mistyped rollback.
 */
const assertBatchValid = (batch) => {
  if (batch === undefined) return;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new ConfigInvalidError('--batch must be a positive integer', { context: { batch } });
  }
};

/**
 * Validate `requestedBy` / `reason`: who asked for a run, and why — stamped
 * on what it writes to the changelog (and on a converge's history entry).
 * The OS user that ran it is `executedBy` already; on a queue worker that is
 * the container's, which is why the requester has a field of its own.
 */
const assertActorValid = (options) => {
  for (const key of ACTOR_FIELDS) {
    const issue = checkActor(key, options?.[key]);
    if (issue) {
      throw new ConfigInvalidError(issue, {
        context: {
          [key]:
            typeof options[key] === 'string'
              ? `${options[key].length} characters`
              : typeof options[key],
        },
      });
    }
  }
};

/**
 * Validate `job`: the queue job a run works for, `{ id, groupId? }` — bound
 * into the run's correlation, so it must be small and exactly that shape.
 */
const assertJobValid = (job, options) => {
  const issue = checkJobRef(job, options);
  if (issue) {
    // For the error's context: the keys of what was given, not its values.
    throw new ConfigInvalidError(issue, {
      context: { job: isPlainObject(job) ? Object.keys(job).join(', ') : typeof job },
    });
  }
};

/**
 * Validate `checksum`: the SHA-256 the caller expects the named file to have
 * — how a queue job says which version of the file it was planned with.
 */
const assertChecksumValid = (checksum, filename) => {
  if (checksum === undefined) return;
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new ConfigInvalidError('checksum must be a SHA-256 hex digest', {
      context: { checksum: typeof checksum },
    });
  }
  if (!filename) {
    throw new ConfigInvalidError('checksum requires a filename');
  }
};

/**
 * Validate `ordered`: a boolean, and only meaningful for a named file — a
 * bulk run is in order by construction, so asking for it there is a caller
 * mistake worth naming rather than silently ignoring.
 */
const assertOrderedValid = (ordered, filename) => {
  if (ordered === undefined) return;
  if (typeof ordered !== 'boolean') {
    throw new ConfigInvalidError('ordered must be a boolean', { context: { ordered } });
  }
  if (ordered && !filename) {
    throw new ConfigInvalidError('ordered requires a filename', { context: { ordered } });
  }
};

/**
 * Options that are flags: a boolean, or left out. They are read by
 * truthiness, so `noLock: 'false'` — a value that came from an environment
 * variable or a JSON body — would run without the lock, and `force: 'no'`
 * re-run an applied migration.
 */
const assertFlags = (options, keys) => {
  for (const key of keys) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new ConfigInvalidError(`${key} must be a boolean`, {
        context: { [key]: options[key] },
      });
    }
  }
};

/** `signal`: an AbortSignal, or nothing — what stops the run as `stop()` does */
const assertSignalValid = (signal) => {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ConfigInvalidError('signal must be an AbortSignal', {
      context: { signal: typeof signal },
    });
  }
};

/** `up`'s `converge` option: a boolean, and only for a bulk run that reaches the head */
const assertConvergeAfterUpValid = (converge, filename, to) => {
  if (converge === undefined) return;
  if (typeof converge !== 'boolean') {
    throw new ConfigInvalidError('converge must be a boolean', { context: { converge } });
  }
  if (converge && filename !== undefined) {
    throw new ConfigInvalidError('converge cannot follow a single-file up', {
      context: { converge, filename },
    });
  }
  if (converge && to !== undefined) {
    throw new ConfigInvalidError(
      'converge cannot follow up --to: the declared state describes the newest migration',
      { context: { converge, to } },
    );
  }
};

/**
 * `onBackgroundPending`: what a run does at a migration that `requires` a
 * background migration not completed yet — `'error'` (throw
 * BackgroundPendingError) or `'stop'` (end the run there, cleanly).
 */
const assertBackgroundPendingValid = (onBackgroundPending) => {
  if (onBackgroundPending === undefined) return;
  if (onBackgroundPending !== 'error' && onBackgroundPending !== 'stop') {
    throw new ConfigInvalidError("onBackgroundPending must be 'error' or 'stop'", {
      context: { onBackgroundPending },
    });
  }
};

const assertUpOptions = (filename, options) => {
  assertFilename(filename);
  assertFlags(options, UP_FLAGS);
  // `to` is checked against a filename only: unlike `down`, an explicit
  // `batch` here is a label for whatever gets applied, not a selector.
  assertToValid(options.to, filename);
  assertBatchValid(options.batch);
  if (options.batch !== undefined && options.step) {
    throw new ConfigInvalidError('Cannot combine --batch with --step', {
      context: { batch: options.batch },
    });
  }
  assertOrderedValid(options.ordered, filename);
  assertConvergeAfterUpValid(options.converge, filename, options.to);
  assertChecksumValid(options.checksum, filename);
  assertBackgroundPendingValid(options.onBackgroundPending);
  assertActorValid(options);
  assertJobValid(options.job);
  assertSignalValid(options.signal);
};

const assertDownOptions = (filename, options) => {
  assertFilename(filename);
  assertFlags(options, LOCK_FLAGS);
  assertStepsValid(options.steps, filename, options.batch);
  assertBatchValid(options.batch);
  assertToValid(options.to, filename, options);
  assertOrderedValid(options.ordered, filename);
  assertActorValid(options);
  assertJobValid(options.job);
  assertSignalValid(options.signal);
};

const assertRedoOptions = (filename, options) => {
  assertFilename(filename);
  assertFlags(options, LOCK_FLAGS);
  assertActorValid(options);
  assertJobValid(options.job);
  assertSignalValid(options.signal);
};

const assertDryRunOptions = (filename, options) => {
  assertFilename(filename);
  // `batch`/`to` must be passed too, or a conflict that `down` rejects would
  // be silently allowed in its own preview.
  assertStepsValid(options.steps, filename, options.batch);
  assertBatchValid(options.batch);
  assertToValid(options.to, filename, options);
};

const assertConvergeOptions = (options) => {
  assertFlags(options, CONVERGE_FLAGS);
  // A dry run builds nothing, so there is nothing to wait for — asking for
  // both is a mistake worth saying, not a wait that silently never happens.
  if (options.dryRun && options.waitForSearchIndexes) {
    throw new ConfigInvalidError('waitForSearchIndexes cannot be combined with dryRun', {
      context: { dryRun: true, waitForSearchIndexes: true },
    });
  }
  assertActorValid(options);
  assertSignalValid(options.signal);
};

const assertHistoryLimit = (limit) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConfigInvalidError('limit must be an integer from 1 to 1000', { context: { limit } });
  }
};

const assertListOptions = (filter, options) => {
  if (options.checksums !== undefined && typeof options.checksums !== 'boolean') {
    throw new ConfigInvalidError('checksums must be a boolean', {
      context: { checksums: options.checksums },
    });
  }
  // An unknown filter silently returning [] reads as "nothing to report" —
  // the worst possible answer to a typo.
  if (filter !== 'all' && filter !== 'pending' && filter !== 'applied') {
    throw new ConfigInvalidError("list filter must be 'all', 'pending' or 'applied'", {
      context: { filter },
    });
  }
};

const assertBaselineOptions = (options) => {
  assertFilename(options.to);
  assertFlags(options, LOCK_FLAGS);
  assertSignalValid(options.signal);
};

/** `runMigrations(config, options)`: its own `noLock`, before a kit is built */
const assertRunFlags = (options) => {
  assertFlags(options, LOCK_FLAGS);
};

/**
 * `import(options)`: a bad --from/--to must not cost a round trip or take the
 * lock. Defaults come from the already-validated config.
 */
const assertImportOptions = (options) => {
  assertFlags(options, IMPORT_FLAGS);
  assertSignalValid(options.signal);
  if (options.from !== undefined && !isCollectionName(options.from)) {
    throw new ConfigInvalidError('Invalid source collection name', {
      context: { from: options.from },
    });
  }
  if (options.to !== undefined && !isCollectionName(options.to)) {
    throw new ConfigInvalidError('Invalid target collection name', { context: { to: options.to } });
  }
};

module.exports = {
  assertFilename,
  assertActorValid,
  assertJobValid,
  assertUpOptions,
  assertDownOptions,
  assertRedoOptions,
  assertDryRunOptions,
  assertConvergeOptions,
  assertHistoryLimit,
  assertListOptions,
  assertBaselineOptions,
  assertRunFlags,
  assertImportOptions,
};
