const { ConvergeFailedError, MigronautError } = require('../../errors/index.js');
const { formatError } = require('../../utils/error.js');
const { TARGET_LABELS } = require('./plan.js');
const { searchHint } = require('./search.js');

/**
 * How converge says what it does and what failed: the words for an action,
 * the hint that usually fixes a server error, and the `ConvergeFailedError`
 * that carries the run so far.
 */

const NAMESPACE_EXISTS = 48;

/** What usually fixes the server error behind a failed step */
const HINTS = {
  __proto__: null,
  11000:
    'existing documents hold duplicate values for this unique index — deduplicate them in a ' +
    'migration first',
  13: 'not authorized — collMod and creating a collection with a validator need the dbAdmin role',
  85:
    'an equivalent index already exists under another name — declare it under that name, or ' +
    'converge with prune to replace it',
  86: 'an index with this name already exists with a different key or options',
  359:
    'existing documents hold duplicate values for this key — deduplicate them in a migration ' +
    'first',
};

const VERBS = { create: 'create', modify: 'modify', recreate: 'rebuild', drop: 'drop' };

const LABELS = {
  create: '✔ Created ',
  modify: '✔ Modified',
  recreate: '✔ Rebuilt ',
  drop: '✔ Dropped ',
};

/**
 * Errors that leave it unknown what the server did: the connection broke, or
 * a client-side deadline ran out, while the server may well still be building.
 * After one of these, nothing is "put back" — a restore would race a build the
 * server is still running; the next converge reads what actually happened.
 */
const CONNECTION_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoOperationTimeoutError',
  'MongoTopologyClosedError',
]);

const CONNECTION_ERROR_CODES = new Set([50, 89, 91, 189, 10107, 11600, 11602, 13435]);

/**
 * A failed conversion to unique: what became of the index (`prepareUnique` taken back off, or not)
 */
const describeUniqueLeftover = (mongoCode, extra) => {
  if (extra.prepareUniqueLeft) {
    return (
      ' — and prepareUnique could not be taken back off: the index refuses new duplicates ' +
      'from now on, until the next converge takes it off'
    );
  }
  return mongoCode === 359 ? ' (the index was left as it was)' : '';
};

/** A row's target as a log line names it, and what it is on */
const describeTarget = (action, collection) => {
  const target = TARGET_LABELS[action.target] ?? action.target;
  const isNamed = action.target === 'index' || action.target === 'searchIndex';
  return `${target} ${isNamed ? `${action.name} on ${collection}` : collection}`;
};

/** Copy-on-write, like the kit's #attachResults: the error may live on a shared abort signal */
const attachConverge = (error, result) => {
  if (error instanceof MigronautError) {
    error.context = { ...error.context, converge: result };
  }
  return error;
};

/** `"a", "b"` */
const quoteAll = (names) => {
  let text = '';
  for (let i = 0; i < names.length; i++) {
    if (i > 0) text += ', ';
    text += `"${names[i]}"`;
  }
  return text;
};

const describe = (action) => {
  if (action.target === 'index') return `index "${action.name}"`;
  if (action.target === 'searchIndex') return `search index "${action.name}"`;
  return action.target === 'validator' ? 'the validator' : 'the collection';
};

/** What a failed step was doing — one row, or the indexes one command built together */
const describeAll = (actions) => {
  if (actions.length === 1) return describe(actions[0]);
  let names = '';
  for (let i = 0; i < actions.length; i++) {
    if (i > 0) names += ', ';
    names += `"${actions[i].name}"`;
  }
  return actions[0].target === 'searchIndex' ? `search indexes ${names}` : `indexes ${names}`;
};

const isConnectionTrouble = (error) => {
  return CONNECTION_ERROR_NAMES.has(error?.name) || CONNECTION_ERROR_CODES.has(error?.code);
};

/** What a failed rebuild left behind, when it could not put the dropped index back */
const describeLostIndexes = (extra) => {
  if (extra.restored !== false) return '';
  if (extra.uncertain) {
    return (
      ` — the connection failed mid-build, so ${quoteAll(extra.dropped)} ` +
      'was not put back: the server may still be building; converge --dry-run shows what it finished'
    );
  }
  return (
    ` — the dropped index(es) ${quoteAll(extra.dropped)} could ` +
    `not be put back (${extra.restoreError}); the collection is without them until fixed`
  );
};

/** What usually fixes a failed step: a search command's own hint, or one by server code */
const suggestFix = (target, error, mongoCode) => {
  if (target === 'searchIndex') return searchHint(error);
  return mongoCode !== undefined ? HINTS[mongoCode] : undefined;
};

const wrapFailure = (error, collection, actions, result, extra = {}) => {
  const action = actions[0];
  if (error instanceof MigronautError) return attachConverge(error, result);
  const mongoCode = typeof error?.code === 'number' ? error.code : undefined;
  const hint = suggestFix(action.target, error, mongoCode);
  const cause = formatError(error);
  return new ConvergeFailedError(
    `Could not ${VERBS[action.action] ?? action.action} ${describeAll(actions)} on ${collection}: ` +
      `${cause}${hint ? ` — ${hint}` : ''}${describeUniqueLeftover(mongoCode, extra)}${describeLostIndexes(extra)}`,
    {
      cause: error,
      context: {
        phase: 'apply',
        collection,
        target: action.target,
        name: action.name,
        action: action.action,
        cause,
        ...(mongoCode !== undefined ? { mongoCode } : {}),
        ...(hint ? { hint } : {}),
        ...extra,
        converge: result,
      },
    },
  );
};

module.exports = {
  NAMESPACE_EXISTS,
  LABELS,
  describeTarget,
  attachConverge,
  describe,
  describeAll,
  isConnectionTrouble,
  wrapFailure,
};
