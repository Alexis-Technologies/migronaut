# src/core/converge — declared collections

ARCHITECTURE.md §6.7 is the long form. `host.js` builds the `deps` of the flow (`converge.js`)
and keeps its history (`log.js`, `_migronaut_converge`); `live.js` reads the live state, `plan.js`
turns definitions into steps, `steps.js` runs them, `report.js` and `failure.js` say what
happened; the search-index planner and its wait are `search.js` and `search-run.js`.

## Indexes, validators and the run

- Without `prune` an undeclared index is never dropped: an identical one under another name is
  accepted as is, a different one is a `conflict` that refuses the whole run before any write.
- Definition _files_ load at converge time, not config time — a broken file must not block `down`.
- `up --json` stays the migration rows: the converge result travels as `converge:end`,
  `summary.converge` and `converge --json`. `dryRun('up')` never previews a converge.
- `ConvergeFailedError` keeps its progress in `context.converge`, never `context.results` (the kit
  and the CLI read `results` as migration rows).
- The CLI confirms _after_ planning, inside `run`, like `unlock`. A converge job carries no `prune`
  and is ordered by default. A converge run adds no telemetry wrap site of its own;
  `migronaut.converge.search.wait.duration` is a metric point, not one.
- A validator synthesized for versioning alone is `moderate`; there is no `maximum` on the version
  (`versioning-spec.js`).
- The comparison is a hot path: `utils/canonical.js` and the index and search-index diffs run on
  plan, replan, verify and every settle read.

## Search indexes

- A search index is never `recreate`d — a `$search` on a missing index returns nothing — so a type
  or an immutable `autoEmbed` change is a `conflict`. A FAILED build with the declared definition
  stays `unchanged`, and builds never count against `inSync`.
- `type` is sent to `createSearchIndexes` only for a vector index, and `updateSearchIndex` is
  retried with it only on a self-managed `mongot`'s "mappings is required". An Atlas CLI local
  deployment cannot update a vector index at all (the step fails with the new-name hint — not a
  migronaut bug).
- The availability probe trusts an empty list only from 7.2.1 (older servers go through
  `getParameter`). Nothing reads search indexes for a definition without `searchIndexes`. A list
  that cannot be read reports the phase that read it (`plan` only before the first write).
- Defaults are filled per field mapping too (`FIELD_DEFAULTS` — mongot writes them into what it
  reports), and a field's list of types compares as a set. An option only the server reports,
  with no default in those tables, is **ignored** in the comparison (`ignored` on the row, one
  warning), or a new mongot default would rebuild the index on every run; the opt-in Atlas suite
  still fails on one, since that means a table lacks a default.
- The wait for builds (`waitForSearchIndexes`) runs **without the migration lock** — released
  through `runWithLock`'s `control.release()` once every step is applied — so `lock:released`
  (`early: true`) can precede `run:end`, and a newer converge may change the index under it. It
  fails only on a FAILED build of an index the run created or changed (an untouched FAILED or
  STALE one is warned about, and `--check` still fails on FAILED); STALE never ends a wait early;
  up to three network or failover blips in a row are ridden out. Both spellings of the pool's
  retry label (`PoolRequestedRetry`, `PoolRequstedRetry`) count as transient.
- After changing `search-index-spec.js`, `search.js` or the planner, run the Atlas suite by hand
  (`pnpm run test:optin atlas`): the unit fake carries the coverage, but only a real `mongot`
  proves the fixed point.
