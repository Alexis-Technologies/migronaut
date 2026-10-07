const { ConfigInvalidError, LockAlreadyHeldError, RunAbortedError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { belowVersionFilter, versionOf } = require('../versioning/document.js');
const { applyBatch, transactionOptions } = require('./background-engine.js');
const { jitter, sleep } = require('./background-throttle.js');
const {
  classifyStreamError,
  isEnding,
  lagOf,
  tokenDue,
  watchPipeline,
  watchView,
} = require('./background-watch-plan.js');
const { STATE_SUMMARY, control, jobFor } = require('./background.js');
const { verify } = require('./background-drift.js');
const { runWithLock } = require('./lock.js');
const { READ_OPTIONS } = require('./server-info.js');

/** Why a follower or the watcher stopped — a typed abort reason, never a bare Error */
const stopReason = (reason) => new RunAbortedError(reason, { reason });

/**
 * The live drift watcher: after a background migration completed, an
 * old-shape write (an old pod, a forgotten worker) is upgraded within moments
 * instead of at the next poll — through a change stream per collection, by
 * the same write path a lane uses (the transform, stampedDiff, the optimistic
 * filter, targeted writes and the shard-key guard).
 *
 * One leader per collection, across every process: the watcher holding the
 * `watch:<collection>` lock (a MigrationLock of its own, so it never meets a
 * `background:<name>` coordinator); the others retry now and then, so
 * leadership spreads over the pods. The leader keeps its resume token in
 * `<backgroundCollection>_watch` — at most every `checkpointMs`, and the
 * stream's post-batch token while idle, so a quiet filtered stream does not
 * fall off the oplog. Its first start (and a start after the history was
 * lost) begins at "now", after one drift probe of the collection.
 *
 * It never upgrades with a background migration that is not completed, and
 * stands aside on a collection while a revert is at work there. A stream that
 * lags more than `maxLagMs` behind gives up on the backlog — the background
 * migrations it would serve are reopened, the stream starts again from now —
 * rather than become a slow background migration of its own.
 */

const DEFAULTS = Object.freeze({
  upgrade: true,
  refreshMs: 30_000,
  checkpointMs: 5_000,
  leaderRetryMs: 10_000,
  maxCollections: 16,
  maxLagMs: 60_000,
});

/**
 * The integer options: `[key, min, max]`. The floor of `refreshMs` keeps a
 * watcher from re-listing every state and reopening its streams in a loop.
 */
const BOUNDS = [
  ['refreshMs', 100, 3_600_000],
  ['checkpointMs', 10, 3_600_000],
  ['leaderRetryMs', 10, 3_600_000],
  ['maxCollections', 1, 1_000],
  ['maxLagMs', 1, 86_400_000],
];

/** Every option watchBackground takes — anything else is refused, not ignored */
const OPTION_KEYS = new Set([
  ...BOUNDS.map(([key]) => key),
  'upgrade',
  'collections',
  'signal',
  'onError',
]);

/** Hops one event may take up a chain (v1 → v2 → v3 …) */
const MAX_HOPS = 16;
/** The longest a failing stream backs off before it reopens */
const MAX_BACKOFF_MS = 30_000;

/** Validate the watcher's options and fill in the defaults */
function watchOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigInvalidError('watchBackground options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new ConfigInvalidError(`"${key}" is not a watchBackground option`, { key });
    }
  }
  const resolved = { ...DEFAULTS };
  for (const [key, min, max] of BOUNDS) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigInvalidError(`${key} must be an integer from ${min} to ${max}`, {
        [key]: value,
      });
    }
    resolved[key] = value;
  }
  if (options.upgrade !== undefined) {
    if (typeof options.upgrade !== 'boolean') {
      throw new ConfigInvalidError('upgrade must be a boolean', { upgrade: options.upgrade });
    }
    resolved.upgrade = options.upgrade;
  }
  if (options.collections !== undefined) {
    if (!Array.isArray(options.collections)) {
      throw new ConfigInvalidError('collections must be an array of collection names');
    }
    for (const name of options.collections) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new ConfigInvalidError('collections must be an array of collection names');
      }
    }
    resolved.collections = new Set(options.collections);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ConfigInvalidError('signal must be an AbortSignal');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new ConfigInvalidError('onError must be a function');
  }
  return resolved;
}

/** The background migration that takes a collection to its target — the edge reaching highest */
function lastEdge(edges) {
  let last;
  for (const edge of edges.values()) if (last === undefined || edge.to > last.to) last = edge;
  return last?.name;
}

/**
 * How far this host's clock runs ahead of the server's, in milliseconds —
 * from `hello`'s `localTime`, halfway through the round trip. 0 when the
 * server will not say.
 */
async function clockSkew(db) {
  try {
    const before = Date.now();
    const hello = await db.admin().command({ hello: 1 });
    const after = Date.now();
    const server = hello?.localTime instanceof Date ? hello.localTime.getTime() : undefined;
    return server === undefined ? 0 : Math.round((before + after) / 2) - server;
  } catch {
    return 0;
  }
}

/**
 * Start watching. `deps`: the kit's background deps plus `{ watchStore,
 * watchLockFor(collection), owner, onDrift }`. Returns `{ running, status(),
 * stop() }`; `stop()` resolves once every stream is closed, its last token
 * saved and its lock released.
 */
function startWatch(deps, options = {}) {
  const settings = watchOptions(options);
  const controller = new AbortController();
  const signal = controller.signal;
  const onOuterAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  const owner = deps.owner;
  /** collection → { controller, done, state, leading, counters, lastEventAt } */
  const followers = new Map();
  let unsupported;

  const report = (error, collection) => {
    try {
      options.onError?.(error, collection);
    } catch {
      // A throwing onError is its own problem.
    }
    deps.logger.warn(
      `⚠ Drift watcher${collection ? ` (${collection})` : ''}: ${errorText(error)}`,
      deps.fields({ ...(collection ? { collection } : {}), error: errorText(error) }),
    );
  };

  /** Move a follower to `state` — said once per change, and saved when it leads */
  async function setState(collection, state, { leading = false } = {}) {
    const follower = followers.get(collection);
    if (follower === undefined || follower.state === state) return;
    follower.state = state;
    follower.leading = leading;
    deps.emit('background:watch', { collection, state });
    if (leading) {
      await deps.watchStore.save(collection, owner, { fields: { state } }).catch((error) => {
        // The state is shown again with the next save; a lost one is only said.
        deps.logger.debug(
          `Drift watcher (${collection}): could not save its state: ${errorText(error)}`,
          deps.fields({ collection }),
        );
      });
    }
  }

  /** The collections to follow now, at most `maxCollections` */
  function wantedCollections(states) {
    const names = new Set();
    for (const state of states) {
      const spec = state.spec;
      if (state.status !== 'completed' || state.direction === 'revert') continue;
      if (spec?.mode !== 'declarative') continue;
      if (settings.collections !== undefined && !settings.collections.has(spec.collection)) {
        continue;
      }
      names.add(spec.collection);
    }
    const sorted = [...names].sort();
    if (sorted.length > settings.maxCollections) {
      const left = sorted.length - settings.maxCollections;
      if (!deps.warned?.has('watch:max-collections')) {
        deps.warned?.add('watch:max-collections');
        deps.logger.warn(
          `⚠ Drift watcher: ${left} collection(s) past maxCollections (${settings.maxCollections}) ` +
            'are left to the polling watch',
          deps.fields({ maxCollections: settings.maxCollections }),
        );
      }
    }
    return new Set(sorted.slice(0, settings.maxCollections));
  }

  async function supervise() {
    while (!signal.aborted) {
      // A follower found no change streams here at all: nothing to supervise.
      if (unsupported !== undefined) break;
      try {
        const wanted = wantedCollections(await deps.store.list({}, { projection: STATE_SUMMARY }));
        for (const collection of wanted) {
          if (!followers.has(collection)) startFollower(collection);
        }
        for (const [collection, follower] of followers) {
          if (!wanted.has(collection)) follower.controller.abort(stopReason('no longer watched'));
        }
      } catch (error) {
        if (signal.aborted) break;
        report(error);
      }
      await sleep(settings.refreshMs, signal).catch(() => undefined);
    }
  }

  function startFollower(collection) {
    const child = new AbortController();
    const follower = {
      controller: child,
      state: undefined,
      leading: false,
      counters: { events: 0, upgraded: 0, failed: 0, skipped: 0 },
      lastEventAt: undefined,
    };
    followers.set(collection, follower);
    const both = AbortSignal.any([signal, child.signal]);
    follower.done = follow(collection, both)
      .catch((error) => report(error, collection))
      .finally(async () => {
        await setState(collection, 'stopped');
        followers.delete(collection);
      });
  }

  /** Lead the collection when its lock is free; follow (and retry) when it is not */
  async function follow(collection, followSignal) {
    while (!followSignal.aborted) {
      let outcome;
      try {
        outcome = await runWithLock(
          deps.watchLockFor(collection),
          { logger: deps.logger, owner },
          (lockSignal) => lead(collection, AbortSignal.any([followSignal, lockSignal])),
        );
      } catch (error) {
        if (followSignal.aborted) return;
        if (error instanceof LockAlreadyHeldError) {
          await setState(collection, 'following');
        } else {
          report(error, collection);
        }
      }
      if (outcome === 'fallback' || outcome === 'gone') return;
      if (outcome === 'unsupported') {
        unsupported = outcome;
        controller.abort(stopReason('change streams are not supported here'));
        return;
      }
      await sleep(jitter(settings.leaderRetryMs), followSignal).catch(() => undefined);
    }
  }

  /** The leader's loop: open the stream, serve it, reopen it — until stopped */
  async function lead(collection, leadSignal) {
    await deps.watchStore.lead(collection, owner);
    const stored = await deps.watchStore.get(collection);
    let token = stored?.resumeToken;
    let failures = 0;
    while (!leadSignal.aborted) {
      const states = await deps.store.list({}, { projection: STATE_SUMMARY });
      const { suspended, edges, target, byName } = watchView(states, collection);
      if (suspended !== undefined) {
        await setState(collection, 'suspended', { leading: true });
        await sleep(settings.refreshMs, leadSignal).catch(() => undefined);
        continue;
      }
      if (target === undefined) return 'gone';
      const field = byName.get(edges.values().next().value.name).spec.field;
      const outcome = await serve(collection, leadSignal, { edges, byName, target, field, token });
      token = outcome.token;
      if (outcome.end !== undefined) return outcome.end;
      if (outcome.error === undefined) {
        failures = 0;
        continue;
      }
      const kind = classifyStreamError(outcome.error);
      if (kind === 'unsupported') return 'unsupported';
      if (kind === 'unauthorized') {
        await setState(collection, 'fallback', { leading: true });
        report(outcome.error, collection);
        return 'fallback';
      }
      if (kind === 'history-lost') {
        token = undefined;
        await deps.watchStore.save(collection, owner, { unset: ['resumeToken'] });
        await setState(collection, 'history-lost', { leading: true });
        continue;
      }
      failures += 1;
      report(outcome.error, collection);
      await sleep(Math.min(MAX_BACKOFF_MS, 250 * 2 ** failures), leadSignal).catch(() => undefined);
    }
    return 'stopped';
  }

  /**
   * One open stream: events served until the edges need a fresh look
   * (`refreshMs`), the stream ends or fails, or the watcher stops. Resolves
   * to `{ token, end?, error? }`.
   */
  async function serve(collection, serveSignal, context) {
    const { edges, target, field } = context;
    const follower = followers.get(collection);
    const stream = deps.db.collection(collection).watch(watchPipeline(field, target), {
      fullDocument: 'default',
      maxAwaitTimeMS: 1000,
      ...(context.token !== undefined ? { resumeAfter: context.token } : {}),
    });
    let token = context.token;
    let savedAt;
    const jobs = new Map();
    const refreshAt = Date.now() + settings.refreshMs;
    const saveToken = async (force = false) => {
      if (token === undefined || !tokenDue(savedAt, Date.now(), settings.checkpointMs, { force })) {
        return;
      }
      const counters = follower?.pending ?? {};
      if (follower) follower.pending = {};
      const names = [];
      for (const edge of edges.values()) names.push(edge.name);
      await deps.watchStore.save(collection, owner, {
        fields: {
          resumeToken: token,
          target,
          edges: names,
          ...(follower?.lastEventAt ? { lastEventAt: follower.lastEventAt } : {}),
        },
        counters,
      });
      savedAt = Date.now();
    };
    // Lag is judged against the server's clock: a host running ahead would
    // otherwise read every event as late and shed the collection each time.
    const skew = await clockSkew(deps.db);
    try {
      // The first read opens the cursor: from here on the stream has every
      // write. Only then is a fresh start's past probed — from "now" (no
      // token), the probe covers what came before and the stream the rest,
      // with no gap between them.
      let held = await stream.tryNext();
      if (context.token === undefined) {
        await setState(collection, 'catching-up', { leading: true });
        await verify(deps, { onDrift: deps.onDrift, collections: [collection] }).catch((error) =>
          report(error, collection),
        );
      }
      await setState(collection, 'streaming', { leading: true });
      while (!serveSignal.aborted) {
        const event = held !== undefined ? held : await stream.tryNext();
        held = undefined;
        if (event === null) {
          // Idle: the post-batch token keeps a filtered stream on the oplog.
          if (stream.resumeToken) token = stream.resumeToken;
          await saveToken();
          if (Date.now() >= refreshAt) break;
          continue;
        }
        if (isEnding(event)) {
          await deps.watchStore.save(collection, owner, { unset: ['resumeToken'] });
          token = undefined;
          await setState(collection, 'restarting', { leading: true });
          return {
            token: undefined,
            end: event.operationType === 'invalidate' ? undefined : 'gone',
          };
        }
        const lag = lagOf(event, Date.now() - skew);
        if (lag !== undefined && lag > settings.maxLagMs) {
          await shed(collection, edges);
          token = undefined;
          await deps.watchStore.save(collection, owner, { unset: ['resumeToken'] });
          return { token: undefined };
        }
        await upgrade(collection, event, context, jobs, lag);
        // Past this event only once it is served: a failure reopens before it.
        token = event._id;
        await saveToken();
      }
      return { token };
    } catch (error) {
      if (serveSignal.aborted) return { token };
      return { token, error };
    } finally {
      await stream.close().catch(() => undefined);
      // On the way out, the position is kept whatever the cadence said.
      await saveToken(true).catch(() => undefined);
    }
  }

  /** Behind by more than maxLagMs: reopen the background migrations instead, start from now */
  async function shed(collection, edges) {
    await setState(collection, 'overloaded', { leading: true });
    for (const edge of edges.values()) {
      await control(deps, edge.name, 'retry', {
        reason: 'the drift watcher fell behind',
      }).catch((error) => report(error, collection));
    }
    deps.logger.warn(
      `⚠ Drift watcher (${collection}) fell more than ${settings.maxLagMs}ms behind — reopened ` +
        'its background migrations and started again from now',
      deps.fields({ collection }),
    );
  }

  /** Upgrade the one document an event names, edge by edge, up to the target shape */
  async function upgrade(collection, event, context, jobs, lag) {
    const { edges, byName, target, field } = context;
    const follower = followers.get(collection);
    const count = (key) => {
      if (!follower) return;
      follower.counters[key] += 1;
      follower.pending ??= {};
      follower.pending[key] = (follower.pending[key] ?? 0) + 1;
    };
    count('events');
    if (follower) follower.lastEventAt = new Date();
    const key = event.documentKey;
    const coll = deps.db.collection(collection);
    const below = belowVersionFilter({ field }, target);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const doc = await coll.findOne(below ? { $and: [key, below] } : key, READ_OPTIONS);
      if (doc === null) {
        if (hop === 0) count('skipped');
        return;
      }
      const edge = edges.get(versionOf(doc, field));
      if (edge === undefined || !settings.upgrade) {
        drift(collection, edge?.name ?? lastEdge(edges), 'reported');
        return;
      }
      let job = jobs.get(edge.name);
      if (job === undefined) {
        try {
          job = await jobFor(deps, edge.name, byName.get(edge.name));
        } catch (error) {
          // Mid-deploy: another version of the file — the lanes take the document.
          report(error, collection);
          await handBack(collection, edge.name, 'the drift watcher could not load the migration');
          return;
        }
        jobs.set(edge.name, job);
      }
      const fresh = await coll.findOne({ $and: [key, job.match] }, READ_OPTIONS);
      if (fresh === null) return;
      const result = await rewrite(job, fresh);
      if (result === null) {
        // Still in the way after every retry: in 'stream' mode no poll would
        // look at this collection, so the lanes take what is left.
        await handBack(collection, edge.name, 'the drift watcher kept losing to other writes');
        return;
      }
      if (result.errors.length > 0) {
        count('failed');
        drift(collection, edge.name, 'failed');
        if (deps.onDrift === 'reopen') {
          await control(deps, edge.name, 'retry', {
            reason: 'the drift watcher could not upgrade a document',
          }).catch((error) => report(error, collection));
        }
        return;
      }
      if (result.migrated !== 1) return;
      count('upgraded');
      drift(collection, edge.name, 'upgraded');
      if (lag !== undefined) {
        deps.telemetry?.backgroundWatchDelay({ name: edge.name, delayMs: lag });
      }
    }
  }

  /**
   * One document through the lanes' write path — in a transaction for a
   * transactional background migration, so its side writes commit with it
   * (and the driver retries a transient failure). A concurrent write that
   * moves it first is read again and retried, up to `maxConflictRetries`
   * times, as a lane would; `null` when it is still in the way after that.
   */
  async function rewrite(job, doc) {
    if (!job.spec.transaction) return applyBatch(job, [doc], { db: deps.db });
    let current = doc;
    // Each transaction — the driver's retries included — runs the
    // transformation again; what it logs says which one it was.
    let transactions = 0;
    for (let attempt = 0; ; attempt++) {
      const session = deps.client.startSession();
      try {
        let result;
        await session.withTransaction(async () => {
          transactions += 1;
          result = await applyBatch(job, [current], {
            db: deps.db,
            session,
            ctxExtra: { session, db: deps.db, client: deps.client },
            abortOnConflict: true,
            strict: true,
            attempt: transactions,
          });
        }, transactionOptions(job.spec));
        return result;
      } catch (error) {
        if (error?.context?.reason === 'document') {
          return { migrated: 0, errors: [error.context.document] };
        }
        if (error?.context?.reason !== 'write-conflict') throw error;
        if (attempt >= job.spec.maxConflictRetries) return null;
        current = await deps.db
          .collection(job.spec.collection)
          .findOne({ $and: [{ _id: doc._id }, job.match] }, READ_OPTIONS);
        // Upgraded, or no longer one to upgrade, by the write that won.
        if (current === null) return { migrated: 0, errors: [] };
      } finally {
        await session.endSession().catch(() => undefined);
      }
    }
  }

  /**
   * What the watcher could not upgrade goes back to the lanes: with
   * `onDrift: 'reopen'` the background migration is reopened (a pass over
   * what is left), otherwise the drift is reported.
   */
  async function handBack(collection, migration, reason) {
    if (deps.onDrift !== 'reopen') {
      drift(collection, migration, 'reported');
      return;
    }
    drift(collection, migration, 'reopened');
    await control(deps, migration, 'retry', { reason }).catch((error) => report(error, collection));
  }

  function drift(collection, migration, action) {
    deps.telemetry?.backgroundDrift({ name: migration });
    deps.emit('background:drift', { migration, collection, source: 'stream', action });
  }

  const work = supervise();
  let stopping;
  return {
    get running() {
      return !signal.aborted;
    },
    /** What each followed collection's watcher is doing in this process */
    status() {
      const rows = [];
      for (const [collection, follower] of followers) {
        rows.push({
          collection,
          state: follower.state ?? 'starting',
          leading: follower.leading,
          counters: { ...follower.counters },
          ...(follower.lastEventAt ? { lastEventAt: follower.lastEventAt } : {}),
        });
      }
      return rows;
    },
    stop() {
      stopping ??= (async () => {
        if (!signal.aborted) controller.abort(stopReason('Drift watcher stopped'));
        await work;
        const done = [];
        for (const follower of followers.values()) done.push(follower.done);
        await Promise.allSettled(done);
        options.signal?.removeEventListener('abort', onOuterAbort);
      })();
      return stopping;
    },
  };
}

module.exports = { WATCH_DEFAULTS: DEFAULTS, startWatch, watchOptions };
