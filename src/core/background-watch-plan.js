/**
 * The live drift watcher's decisions, kept pure: which background migrations
 * a collection's watcher upgrades with, what its change stream asks the
 * server for, how a stream error is read, and when a resume token is due.
 * background-watch.js does the I/O.
 */

/** Server errors that mean the stream cannot resume from where it was */
const HISTORY_LOST = new Set([
  286, // ChangeStreamHistoryLost — the oplog moved past the token
  280, // ChangeStreamFatalError
  136, // CappedPositionLost
]);
/** Not authorized to open (or keep) a change stream there */
const UNAUTHORIZED = 13;
/** "The $changeStream stage is only supported on replica sets" — a standalone */
const UNSUPPORTED = 40573;

/** Events that end a stream for good: the collection is gone or renamed */
const ENDING = new Set(['drop', 'rename', 'dropDatabase', 'invalidate']);

/**
 * The background migrations a collection's watcher may upgrade with — its
 * edges: completed, forward, declarative ones (a step migration cannot run
 * on one document). Returns `{ edges, target }`: `edges` by the version they
 * start from (the first registered wins a tie), `target` the highest
 * version any reaches — the shape a document should have at least.
 */
function edgesOf(states, collection) {
  const edges = new Map();
  let target;
  for (const state of states) {
    const spec = state.spec;
    if (spec?.collection !== collection || spec.mode !== 'declarative') continue;
    if (state.status !== 'completed' || state.direction === 'revert') continue;
    if (!edges.has(spec.from)) {
      edges.set(spec.from, { name: state._id, from: spec.from, to: spec.to });
    }
    if (target === undefined || spec.to > target) target = spec.to;
  }
  return { edges, target };
}

/** Statuses after which a background migration does nothing more */
const SETTLED = new Set(['completed', 'failed', 'cancelled']);

/**
 * The revert that makes a collection's watcher stand aside, if any: one not
 * settled yet — the watcher would upgrade straight back what it rewrites.
 */
function suspendedBy(states, collection) {
  for (const state of states) {
    if (state.spec?.collection !== collection || state.direction !== 'revert') continue;
    if (!SETTLED.has(state.status)) return state._id;
  }
  return undefined;
}

/**
 * The change stream's pipeline: only the writes that can leave a document
 * below `target` — an insert or replace of an old shape, an update that sets
 * the version field below it or to null, one that removes it — plus the
 * events that end the stream. No `updateLookup`: the watcher reads the one
 * document an event names, never one per update of the collection. An update
 * that does not touch the version field matches nothing (`$exists` guards
 * the null test, which would otherwise match every such update).
 */
function watchPipeline(field, target) {
  const full = `fullDocument.${field}`;
  const updated = `updateDescription.updatedFields.${field}`;
  return [
    {
      $match: {
        $or: [
          {
            operationType: { $in: ['insert', 'replace'] },
            $or: [{ [full]: { $lt: target } }, { [full]: { $exists: false } }, { [full]: null }],
          },
          {
            operationType: 'update',
            $or: [
              { [updated]: { $lt: target } },
              { [updated]: { $exists: true, $type: 'null' } },
              { 'updateDescription.removedFields': field },
            ],
          },
          { operationType: { $in: [...ENDING] } },
        ],
      },
    },
    { $project: { operationType: 1, documentKey: 1, clusterTime: 1 } },
  ];
}

/**
 * How a stream error is met: `history-lost` (start over from now, after a
 * drift probe of the collection), `unauthorized` (leave the collection to
 * the polling watch), `unsupported` (no change streams here at all), or
 * `retry` (reopen from the last token, after a backoff).
 */
function classifyStreamError(error) {
  const code = error?.code;
  if (HISTORY_LOST.has(code)) return 'history-lost';
  if (code === UNAUTHORIZED) return 'unauthorized';
  if (code === UNSUPPORTED) return 'unsupported';
  if (error?.hasErrorLabel?.('NonResumableChangeStreamError')) return 'history-lost';
  return 'retry';
}

/** Whether an event ends the stream (the collection dropped or renamed) */
const isEnding = (event) => ENDING.has(event?.operationType);

/** Milliseconds since the event happened — the stream's lag — or `undefined` without a time */
function lagOf(event, now) {
  const time = event?.clusterTime;
  if (time === undefined || time === null) return undefined;
  // A BSON Timestamp: seconds in `t` (the high 32 bits), an ordinal in `i`.
  const seconds = time.t;
  return typeof seconds === 'number' ? Math.max(0, now - seconds * 1000) : undefined;
}

/** Whether a resume token is due: at most every `checkpointMs`, and always when told to */
function tokenDue(lastSavedAt, now, checkpointMs, { force = false } = {}) {
  return force || lastSavedAt === undefined || now - lastSavedAt >= checkpointMs;
}

/**
 * A leader's view of its collection, in one pass over the states: the revert
 * it stands aside for (`suspended`), its `edges` and `target` (as
 * {@link edgesOf}), and every state by name.
 */
function watchView(states, collection) {
  const edges = new Map();
  const byName = new Map();
  let target;
  let suspended;
  for (const state of states) {
    byName.set(state._id, state);
    const spec = state.spec;
    if (spec?.collection !== collection) continue;
    if (state.direction === 'revert') {
      if (suspended === undefined && !SETTLED.has(state.status)) suspended = state._id;
      continue;
    }
    if (spec.mode !== 'declarative' || state.status !== 'completed') continue;
    if (!edges.has(spec.from)) {
      edges.set(spec.from, { name: state._id, from: spec.from, to: spec.to });
    }
    if (target === undefined || spec.to > target) target = spec.to;
  }
  return { suspended, edges, target, byName };
}

module.exports = {
  HISTORY_LOST,
  classifyStreamError,
  edgesOf,
  isEnding,
  lagOf,
  suspendedBy,
  tokenDue,
  watchPipeline,
  watchView,
};
