const crypto = require('node:crypto');
const {
  BackgroundConflictError,
  ConfigInvalidError,
  MigrationInvalidExportError,
} = require('../errors/index.js');
const { canonical, isPlainObject, toWire, unsendable } = require('../utils/canonical.js');
const { isCollectionName } = require('../utils/collection-name.js');
const { fieldNameIssue } = require('../versioning/config.js');
const { resolveFieldNames } = require('../versioning/document.js');
const { filterTouches } = require('../versioning/internal.js');

/**
 * Background migrations, declared: what a migration file's
 * `export const background = {…}` may say, validated strictly and resolved
 * with every default — plus the pure tables the engine runs on (the state
 * transitions, the BSON brackets of `_id`, the scope filters). No database,
 * no clock: every rule here is unit-tested as data.
 */

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  batchSize: 500,
  transactionBatchSize: 100,
  pauseMs: 100,
  sliceMs: 30_000,
  writeConcern: Object.freeze({ w: 'majority' }),
  maxDocumentErrors: 0,
  maxPasses: 10,
  maxConflictRetries: 3,
  maxSliceFailures: 3,
  maxReplicationLagMs: 10_000,
  maxParallel: 1,
  shardConcurrency: 1,
  overPartition: 4,
  maxPartitions: 256,
  transactionTimeoutMs: 10_000,
  transactionMaxRetries: 5,
  targetLatencyMs: 500,
  minBatchSize: 10,
  maxPauseMs: 30_000,
});

/**
 * The most documents a background migration may fail and still complete —
 * as many as its state keeps the ids of (they are left out of later passes
 * and of the final count, so a budget past them could never be told).
 */
const MAX_BAD_IDS = 1000;

/** Integer settings: `[key, min, max]` */
const INTEGER_SETTINGS = [
  ['batchSize', 1, 10_000],
  ['pauseMs', 0, 3_600_000],
  ['sliceMs', 1_000, 3_600_000],
  ['maxDocumentErrors', 0, MAX_BAD_IDS],
  ['maxPasses', 1, 1_000],
  ['maxConflictRetries', 0, 100],
  ['maxSliceFailures', 1, 100],
  ['maxParallel', 1, 64],
  ['shardConcurrency', 1, 64],
];

/** The collection `create --background` leaves for the author to fill in */
const SCAFFOLD_PLACEHOLDER = 'TODO';

/** Operators that run JavaScript on the server */
const SERVER_JS = new Set(['$where', '$function', '$accumulator']);

/** Whether a filter runs JavaScript on the server, anywhere in it ($expr included) */
function usesServerJs(value) {
  if (Array.isArray(value)) {
    for (const item of value) if (usesServerJs(item)) return true;
    return false;
  }
  if (!isPlainObject(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (SERVER_JS.has(key) || usesServerJs(item)) return true;
  }
  return false;
}

/** The longest slice — for a caller that overrides the spec's (a runner, the CLI, a test) too */
const [, , MAX_SLICE_MS] = INTEGER_SETTINGS.find(([key]) => key === 'sliceMs');

/**
 * A caller's `sliceMs`: a positive integer up to the spec's maximum. A slice
 * always works one batch before it looks at its deadline, so a short one
 * still makes progress; 0, a negative number or NaN would not.
 *
 * @throws {ConfigInvalidError} when it is not an integer in range
 */
function assertSliceMs(sliceMs) {
  if (!Number.isSafeInteger(sliceMs) || sliceMs < 1 || sliceMs > MAX_SLICE_MS) {
    throw new ConfigInvalidError(`sliceMs must be an integer from 1 to ${MAX_SLICE_MS}`, {
      sliceMs,
    });
  }
}

const PARTITION_SETTINGS = [
  ['overPartition', 1, 64],
  ['maxPartitions', 1, 4_096],
  ['minPartitionDocs', 1, Number.MAX_SAFE_INTEGER],
  ['sampleSize', 1, 100_000],
];

const TRANSACTION_SETTINGS = [
  ['timeoutMs', 1, 50_000],
  ['maxRetries', 0, 20],
];

const ADAPTIVE_SETTINGS = [
  ['targetLatencyMs', 1, 600_000],
  ['minBatchSize', 1, 10_000],
  ['maxBatchSize', 1, 10_000],
  ['maxPauseMs', 0, 3_600_000],
];

const SETTING_KEYS = [
  'description',
  ...INTEGER_SETTINGS.map(([key]) => key),
  'writeConcern',
  'maxReplicationLagMs',
  'throttle',
  'partitions',
  'transaction',
  'adaptive',
];

const DECLARATIVE_KEYS = new Set([
  ...SETTING_KEYS,
  'collection',
  'from',
  'to',
  'filter',
  'migrate',
  'migrateBatch',
  'revert',
  'revertBatch',
  'versionField',
  'revisionField',
  'occ',
]);

const STEP_KEYS = new Set([...SETTING_KEYS, 'collection', 'step', 'revertStep']);

/** Keys a later release may give meaning to — refused now, not silently ignored */
const RESERVED_KEYS = new Map([
  ['partitioner', 'is not supported yet — partitions follow _id (or the shard key) automatically'],
]);

const FUNCTION_KEYS = [
  'migrate',
  'migrateBatch',
  'revert',
  'revertBatch',
  'step',
  'revertStep',
  'throttle',
];

const OCC_MODES = new Set(['revision', 'version-only']);

/** A checkpoint a step returns is stored on the partition — kept small */
const MAX_CHECKPOINT_BYTES = 64 * 1024;

const inRange = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function rangeIssues(value, table, base, report) {
  for (const [key, min, max] of table) {
    if (value[key] !== undefined && !inRange(value[key], min, max)) {
      report(`${base}${key}`, `must be an integer from ${min} to ${max}`);
    }
  }
}

function objectSettingIssues(value, key, table, report) {
  if (value === undefined || typeof value === 'boolean') return;
  if (!isPlainObject(value)) {
    report(key, 'must be a boolean or an object');
    return;
  }
  const known = new Set(table.map(([name]) => name));
  for (const name of Object.keys(value)) {
    if (!known.has(name)) report(`${key}.${name}`, `is not one of the ${key} settings`);
  }
  rangeIssues(value, table, `${key}.`, report);
}

function settingIssues(spec, report) {
  rangeIssues(spec, INTEGER_SETTINGS, '', report);
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    report('description', 'must be a string');
  }
  if (spec.writeConcern !== undefined && !isPlainObject(spec.writeConcern)) {
    report('writeConcern', 'must be a write concern object ({ w, j, wtimeoutMS })');
  } else if (spec.writeConcern?.w === 0) {
    report('writeConcern', 'must be acknowledged — with w: 0 no conflict can be seen');
  }
  const lag = spec.maxReplicationLagMs;
  if (lag !== undefined && lag !== false && !inRange(lag, 0, 3_600_000)) {
    report('maxReplicationLagMs', 'must be false or an integer from 0 to 3600000');
  }
  if (spec.partitions !== undefined) {
    if (!isPlainObject(spec.partitions)) {
      report('partitions', 'must be an object');
    } else {
      const known = new Set(PARTITION_SETTINGS.map(([name]) => name));
      for (const name of Object.keys(spec.partitions)) {
        if (!known.has(name)) report(`partitions.${name}`, 'is not one of the partitions settings');
      }
      rangeIssues(spec.partitions, PARTITION_SETTINGS, 'partitions.', report);
    }
  }
  objectSettingIssues(spec.transaction, 'transaction', TRANSACTION_SETTINGS, report);
  objectSettingIssues(spec.adaptive, 'adaptive', ADAPTIVE_SETTINGS, report);
  if (
    isPlainObject(spec.adaptive) &&
    Number.isSafeInteger(spec.adaptive.minBatchSize) &&
    Number.isSafeInteger(spec.adaptive.maxBatchSize) &&
    spec.adaptive.minBatchSize > spec.adaptive.maxBatchSize
  ) {
    report('adaptive.minBatchSize', 'must not exceed adaptive.maxBatchSize');
  }
}

/**
 * Why a `background` export is not a valid background migration —
 * `{ path, message }` issues, empty when it is. `versioning` is the declared
 * collection's resolved versioning, when it has one.
 */
function backgroundIssues(spec, { versioning } = {}) {
  if (!isPlainObject(spec)) {
    return [{ path: 'background', message: 'must be an object' }];
  }
  const issues = [];
  const report = (key, message) => issues.push({ path: `background.${key}`, message });
  const step = spec.step !== undefined;
  const allowed = step ? STEP_KEYS : DECLARATIVE_KEYS;
  for (const key of Object.keys(spec)) {
    if (RESERVED_KEYS.has(key)) report(key, RESERVED_KEYS.get(key));
    else if (!allowed.has(key)) {
      report(
        key,
        step && DECLARATIVE_KEYS.has(key)
          ? 'is not a step background migration key (step owns its own writes)'
          : 'is not a background migration key',
      );
    }
  }
  for (const key of FUNCTION_KEYS) {
    if (spec[key] !== undefined && typeof spec[key] !== 'function') {
      report(key, 'must be a function');
    }
  }
  settingIssues(spec, report);

  if (step) {
    if (spec.collection !== undefined && !isCollectionName(spec.collection)) {
      report('collection', 'must be a valid collection name');
    }
    if (spec.maxParallel !== undefined && spec.maxParallel !== 1) {
      report('maxParallel', 'must be 1 — a step background migration runs as one partition');
    }
    return issues;
  }

  if (spec.collection === undefined) {
    report('collection', 'is required');
  } else if (spec.collection === SCAFFOLD_PLACEHOLDER) {
    // Registered as is, it would "complete" at once over an empty collection
    // — and satisfy whatever requires it.
    report('collection', `is still the scaffold's placeholder ('${SCAFFOLD_PLACEHOLDER}')`);
  } else if (!isCollectionName(spec.collection)) {
    report('collection', 'must be a valid collection name');
  }
  const fromValid = inRange(spec.from, 0, Number.MAX_SAFE_INTEGER);
  const toValid = inRange(spec.to, 0, Number.MAX_SAFE_INTEGER);
  if (spec.from === undefined) report('from', 'is required');
  else if (!fromValid) report('from', 'must be an integer ≥ 0 (0: documents without a version)');
  if (spec.to === undefined) report('to', 'is required');
  else if (!toValid) report('to', 'must be an integer ≥ 0');
  if (fromValid && toValid && spec.to <= spec.from) {
    report('to', 'must be greater than from — the way back is revert');
  }
  if (spec.migrate === undefined && spec.migrateBatch === undefined) {
    report('migrate', 'is required (or migrateBatch, or step)');
  } else if (spec.migrate !== undefined && spec.migrateBatch !== undefined) {
    report('migrateBatch', 'cannot be combined with migrate');
  }
  if (spec.revert !== undefined && spec.revertBatch !== undefined) {
    report('revertBatch', 'cannot be combined with revert');
  }
  if (spec.occ !== undefined && !OCC_MODES.has(spec.occ)) {
    report('occ', "must be 'revision' or 'version-only'");
  }
  for (const key of ['versionField', 'revisionField']) {
    if (spec[key] === undefined) continue;
    const issue = fieldNameIssue(spec[key]);
    if (issue) report(key, issue);
  }
  const versionName = spec.versionField ?? versioning?.field ?? '__v';
  if (spec.filter !== undefined) {
    if (!isPlainObject(spec.filter)) {
      report('filter', 'must be a query document');
    } else {
      const reason = unsendable(spec.filter);
      if (reason) report('filter', reason);
      else if (usesServerJs(spec.filter)) {
        report(
          'filter',
          'must not run JavaScript on the server ($where, $function, $accumulator) — it ' +
            'cannot use an index, and many deployments turn it off',
        );
      } else if (filterTouches(spec.filter, versionName)) {
        report('filter', `must not constrain "${versionName}" — from and to do`);
      }
    }
  }
  if (versioning) {
    if (spec.versionField !== undefined && spec.versionField !== versioning.field) {
      report(
        'versionField',
        `differs from the collection's versioning.field ("${versioning.field}")`,
      );
    }
    if (toValid && spec.to > versioning.current) {
      report(
        'to',
        `is past the collection's versioning.current (${versioning.current}) — raise current first`,
      );
    }
    if (versioning.revisionField === null && spec.occ !== 'version-only') {
      report(
        'occ',
        "must be 'version-only' — the collection keeps no revision, so a concurrent write that " +
          'leaves the version alone would be lost',
      );
    }
  }
  if (spec.occ === 'version-only' && spec.revisionField !== undefined) {
    report('revisionField', "has no effect with occ: 'version-only'");
  }
  return issues;
}

const settingOr = (value, fallback) => (value === undefined ? fallback : value);

/**
 * A valid `background` export resolved with every default — split into what
 * is stored (`spec`: plain data, the state document's summary) and what only
 * this process holds (`fns`: the functions).
 *
 * @throws {MigrationInvalidExportError} with every issue in `context.issues`
 */
function resolveBackgroundSpec(raw, { name, versioning } = {}) {
  const issues = backgroundIssues(raw, { versioning });
  if (issues.length > 0) {
    throw new MigrationInvalidExportError(
      `Invalid background migration${name ? ` ${name}` : ''}: ${issues[0].path} ${issues[0].message}`,
      { ...(name ? { name } : {}), issues },
    );
  }
  const step = raw.step !== undefined;
  const transaction =
    raw.transaction === true || isPlainObject(raw.transaction)
      ? {
          timeoutMs: raw.transaction?.timeoutMs ?? DEFAULTS.transactionTimeoutMs,
          maxRetries: raw.transaction?.maxRetries ?? DEFAULTS.transactionMaxRetries,
        }
      : false;
  const batchSize =
    raw.batchSize ?? (transaction ? DEFAULTS.transactionBatchSize : DEFAULTS.batchSize);
  const maxParallel = step ? 1 : (raw.maxParallel ?? DEFAULTS.maxParallel);
  const adaptive =
    raw.adaptive === false
      ? false
      : {
          targetLatencyMs: raw.adaptive?.targetLatencyMs ?? DEFAULTS.targetLatencyMs,
          minBatchSize: Math.min(raw.adaptive?.minBatchSize ?? DEFAULTS.minBatchSize, batchSize),
          // Never above what the author chose.
          maxBatchSize: Math.min(raw.adaptive?.maxBatchSize ?? batchSize, batchSize),
          maxPauseMs: raw.adaptive?.maxPauseMs ?? DEFAULTS.maxPauseMs,
        };
  const overPartition = raw.partitions?.overPartition ?? DEFAULTS.overPartition;
  const maxPartitions = raw.partitions?.maxPartitions ?? DEFAULTS.maxPartitions;
  const settings = {
    batchSize,
    pauseMs: raw.pauseMs ?? DEFAULTS.pauseMs,
    sliceMs: raw.sliceMs ?? DEFAULTS.sliceMs,
    writeConcern: toWire(raw.writeConcern ?? DEFAULTS.writeConcern),
    maxDocumentErrors: raw.maxDocumentErrors ?? DEFAULTS.maxDocumentErrors,
    maxPasses: raw.maxPasses ?? DEFAULTS.maxPasses,
    maxConflictRetries: raw.maxConflictRetries ?? DEFAULTS.maxConflictRetries,
    maxSliceFailures: raw.maxSliceFailures ?? DEFAULTS.maxSliceFailures,
    maxReplicationLagMs: settingOr(raw.maxReplicationLagMs, DEFAULTS.maxReplicationLagMs),
    maxParallel,
    shardConcurrency: raw.shardConcurrency ?? DEFAULTS.shardConcurrency,
    partitions: {
      overPartition,
      maxPartitions,
      minPartitionDocs: raw.partitions?.minPartitionDocs ?? 4 * batchSize,
      sampleSize:
        raw.partitions?.sampleSize ??
        Math.min(10_000, 100 * Math.min(maxPartitions, overPartition * maxParallel)),
    },
    transaction,
    adaptive,
  };
  const fns = {};
  for (const key of FUNCTION_KEYS) if (typeof raw[key] === 'function') fns[key] = raw[key];

  if (step) {
    return {
      spec: {
        mode: 'step',
        ...(raw.collection !== undefined ? { collection: raw.collection } : {}),
        reversible: typeof raw.revertStep === 'function',
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        ...settings,
      },
      fns,
    };
  }
  const occ = raw.occ ?? 'revision';
  const names = resolveFieldNames({
    field: raw.versionField ?? versioning?.field,
    revisionField: raw.revisionField ?? versioning?.revisionField ?? undefined,
    revision: occ === 'revision',
  });
  return {
    spec: {
      mode: 'declarative',
      collection: raw.collection,
      from: raw.from,
      to: raw.to,
      filter: raw.filter === undefined ? {} : toWire(raw.filter),
      field: names.field,
      revisionField: names.revisionField,
      occ,
      batched: typeof raw.migrateBatch === 'function',
      reversible: typeof raw.revert === 'function' || typeof raw.revertBatch === 'function',
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...settings,
    },
    fns,
  };
}

/**
 * What a background migration's documents are, as one string: a change here
 * (another version, filter, field or direction) invalidates every partition
 * already planned — a pass over the old match would be over the wrong set.
 */
function matchHash(spec, direction = 'forward') {
  const identity =
    spec.mode === 'step'
      ? { mode: 'step', direction }
      : {
          collection: spec.collection,
          from: spec.from,
          to: spec.to,
          filter: canonical(spec.filter),
          field: spec.field,
          revisionField: spec.revisionField,
          direction,
        };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
}

// ─── State transitions ────────────────────────────────────────────────────────

const STATUSES = Object.freeze([
  'blocked',
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

/** Done: nothing will change it without a deliberate retry or reopen */
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Every control action: the statuses it applies to, what it moves them to,
 * and the statuses in which it is already done (`unchanged`, not an error —
 * a redelivered job or a second click must be harmless). Anything else is a
 * conflict.
 */
const TRANSITIONS = Object.freeze({
  unblock: { from: ['blocked'], to: 'pending', done: ['pending', 'running', 'paused'] },
  plan: { from: ['pending'], to: 'running', done: ['running'] },
  complete: { from: ['running'], to: 'completed', done: ['completed'] },
  fail: { from: ['blocked', 'pending', 'running'], to: 'failed', done: ['failed'] },
  pause: { from: ['blocked', 'pending', 'running'], to: 'paused', done: ['paused'] },
  resume: { from: ['paused'], to: 'pending', done: ['blocked', 'pending', 'running'] },
  cancel: {
    from: ['blocked', 'pending', 'running', 'paused'],
    to: 'cancelled',
    done: ['cancelled'],
  },
  retry: { from: ['failed', 'cancelled'], to: 'pending', done: ['pending'] },
  reopen: { from: ['completed'], to: 'running', done: ['running'] },
});

/**
 * Where `action` takes a background migration in `status`:
 * `{ to, applied: 'changed' | 'unchanged' }`.
 *
 * @throws {BackgroundConflictError} when the action does not fit the status
 */
function transition(status, action, { migration } = {}) {
  const rule = TRANSITIONS[action];
  if (rule === undefined) {
    throw new BackgroundConflictError(`Unknown background action "${action}"`, { action });
  }
  if (rule.from.includes(status)) return { to: rule.to, applied: 'changed' };
  if (rule.done.includes(status)) return { to: status, applied: 'unchanged' };
  throw new BackgroundConflictError(
    `Cannot ${action} ${migration ? `background migration ${migration}` : 'it'}: it is ${status}`,
    { action, status, ...(migration ? { migration } : {}) },
  );
}

// ─── _id brackets and partition scopes ────────────────────────────────────────

/**
 * The BSON comparison brackets an `_id` can fall in, in server sort order.
 * `$gt`/`$lt` compare only within one bracket, so a range never spans two:
 * each partition lives in one, filtered by `$type`. Only the brackets whose
 * values sort the same way in a sample and on the server are split into
 * several partitions — never `object` (JavaScript reorders integer-like keys)
 * and never the mixed `exotic` one.
 */
const ID_BRACKETS = Object.freeze([
  { name: 'minKey', aliases: ['minKey'], splittable: false },
  { name: 'null', aliases: ['null'], splittable: false },
  { name: 'number', aliases: ['int', 'long', 'double', 'decimal'], splittable: true },
  { name: 'string', aliases: ['string', 'symbol'], splittable: true },
  { name: 'object', aliases: ['object'], splittable: false },
  { name: 'binData', aliases: ['binData'], splittable: true },
  { name: 'objectId', aliases: ['objectId'], splittable: true },
  { name: 'bool', aliases: ['bool'], splittable: false },
  { name: 'date', aliases: ['date'], splittable: true },
  { name: 'timestamp', aliases: ['timestamp'], splittable: true },
  {
    name: 'exotic',
    aliases: ['regex', 'dbPointer', 'javascript', 'javascriptWithScope'],
    splittable: false,
  },
  { name: 'maxKey', aliases: ['maxKey'], splittable: false },
]);

const BRACKETS_BY_NAME = new Map(ID_BRACKETS.map((bracket) => [bracket.name, bracket]));

/** `$type` names (as `$type` reports them) → their bracket */
const BRACKET_OF_TYPE = new Map();
for (const bracket of ID_BRACKETS) {
  for (const alias of bracket.aliases) BRACKET_OF_TYPE.set(alias, bracket.name);
}

/** The bracket of a `$type` name — `exotic` for anything this table does not list */
const bracketOfType = (type) => BRACKET_OF_TYPE.get(type) ?? 'exotic';

/** Why a partition scope is not one the engine can run, or `null` */
function scopeIssue(scope) {
  if (!isPlainObject(scope)) return 'must be an object';
  if (scope.kind === 'step') return null;
  if (scope.kind !== 'id-range') return `has an unknown kind "${scope.kind}"`;
  const bracket = BRACKETS_BY_NAME.get(scope.bracket);
  if (bracket === undefined) return `has an unknown bracket "${scope.bracket}"`;
  if ((scope.gte !== undefined || scope.lt !== undefined) && !bracket.splittable) {
    return `bounds a bracket that is never split ("${scope.bracket}")`;
  }
  return null;
}

/** The filter that keeps a scan inside a partition's scope */
function scopeFilter(scope) {
  if (scope.kind !== 'id-range') return {};
  const condition = { $type: BRACKETS_BY_NAME.get(scope.bracket).aliases };
  if (scope.gte !== undefined) condition.$gte = scope.gte;
  if (scope.lt !== undefined) condition.$lt = scope.lt;
  return { _id: condition };
}

/** Resume a keyset scan after `lastId` — within one bracket, `$gt` alone is enough */
const keysetFilter = (lastId) => (lastId === undefined ? {} : { _id: { $gt: lastId } });

module.exports = {
  BACKGROUND_DEFAULTS: DEFAULTS,
  ID_BRACKETS,
  MAX_BAD_IDS,
  MAX_CHECKPOINT_BYTES,
  STATUSES,
  TERMINAL,
  TRANSITIONS,
  assertSliceMs,
  backgroundIssues,
  bracketOfType,
  keysetFilter,
  matchHash,
  resolveBackgroundSpec,
  scopeFilter,
  scopeIssue,
  transition,
};
