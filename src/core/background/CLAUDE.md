# src/core/background — background migrations

ARCHITECTURE.md §6.8 is the long form. MongoDB holds all of a background migration's truth: the
state documents (`_migronaut_background`), their partitions and leases
(`_migronaut_background_partitions`) and the watcher's resume tokens
(`_migronaut_background_watch`).

## Structure

- `host.js` (`BackgroundHost`) is the kit's facade for all of it and the only builder of the
  `deps` the flows get. The flows — `coordinator.js`, `lane.js`, `controls.js`, with `job.js`,
  `drift.js`, `audit.js`, `kit.js` and `watch.js` — never reach the kit or a module-level client.
- `bson-peer.js` is the one module here that may `require('mongodb')`, lazily, for `BSON`.
- The queue adapter never requires anything in this folder: it goes through the kit.

## Behaviour that looks like a bug but is not

- `up` applies a background file without running it (the state document says how far the rewrite
  is); a file may not export both `background` and `up`/`down`; the scaffold's placeholder
  collection `'TODO'` is refused by `up`.
- Completion is decided by counting what still matches, never by summing partitions. A drift
  reopening is a new pass, not a reset, so an old release that keeps writing exhausts `maxPasses`
  and fails visibly.
- The coordinator lock (`background:<name>`) and the watcher lock (`watch:<collection>`) live beside
  `migronaut_lock`; `forceUnlock`, `unlock` and audit never touch them. Coordinator rounds are
  handed out by the kit under the coordinator lock (a queue chain asks without one).
- `buildStampedDiff` writes only the fields that changed, so untouched fields keep their BSON
  types. A revision guard refuses an operator-valued `_id`.
- A lane stopped by its caller (a shutdown) is `stopped`, never a failed slice;
  `maxSliceFailures` counts failed slices in a row (a checkpoint resets it). A lane waiting for a
  lagging secondary yields at its slice's deadline; a throttle hook's pause and a retry backoff are
  capped at an hour; every backoff is jittered, and `FATAL_SLICE_CODES` (`utils/error.js`) are not
  retried.
- `down` of a one-way background migration pauses it and waits for its lanes before it decides (a
  `step` one counts any checkpointed step as rewritten), by the spec stored at registration.
- `maxDocumentErrors` is capped at the 1000 bad ids a state keeps; document errors mask dup-key
  values (`formatDocumentError`).
- A plan is worked by the partitioner that split it or re-split (`planMismatch`). A shard-aware
  read may reach two shards (a mongos takes a `$lt` bound as inclusive when it picks shards); the
  shard-key guard compares numbers by value. The live watcher opens its stream _before_ it probes
  the past.
- **Kept on purpose (js-conventions, empty values):** `readShardKey` (`core/shard-info.js`) returns
  the key, `null` for a collection that is not sharded, or `undefined` when `config.collections`
  may not be read — the tri-state is the epoch a plan persists, and "unknown" falls back to what
  works without the key.

## Kept on purpose here

- `String(value)` where the value may be a symbol: a thrown driver error's message (`store.js`),
  the argument of a sandboxed `db.collection(name)` (`sandbox.js`, refused when not a string).
- `delete` on the dry run's copy of a user document (`dry-run.js`): it previews `$unset`.
- The sandbox forwards a proxied driver call's arguments as a rest spread, and its cursor's
  iterator is an `async function*` — one of the four function expressions of `src/`.
- `let x = undefined`, written out: `hosted` in `runner.js` (`runner.watcher` is
  `BackgroundWatcher | undefined`), `target` and `suspended` in `watch-plan.js`, returned as
  `undefined`.
- The per-document loop is a hot path (see the root's Conventions): one shape per record
  (`loadJob`'s job, a transform result `{ doc, next, error }`), no spread or closure per document.
- The engine's internal exports (`engine.js`) are there for its tests (GRASP's "export little" is
  traded for testing the steps one by one).
