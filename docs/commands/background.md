# migronaut background

See, run and control [background migrations](/guide/background-migrations): long data rewrites that
run beside the migration line instead of inside it.

```bash
migronaut background <action> [name] [options]
```

## Why it exists

`migronaut up` only **registers** a background migration. Something has to run its lanes, someone
has to watch its progress, and sometimes it has to be paused, retried or looked at before it runs.
This command does all of that from a terminal, a CI job or an operator's shell. It shares the state
in MongoDB with the [in-process runner](/guide/background-migrations#inside-your-application-startbackgroundrunner)
and the [queue](/guide/bullmq#background-migrations-on-the-queue), so all of them can work on the
same background migration at the same time.

`[name]` is the background migration's file name, as `migronaut status` lists it. For `watch` it is
a collection.

::: warning Experimental
New in 2.3. Actions, flags and the `--json` shapes may still change in a minor release.
:::

## Actions

| Action | What it does |
|---|---|
| [`status [name]`](#status) | Every background migration (or one) and its progress |
| [`run <name>` / `run --all`](#run) | Drive it from this process until it is done |
| [`pause <name>`](#pause-resume-cancel) | Its lanes stop at their next batch |
| [`resume <name>`](#pause-resume-cancel) | Back to work |
| [`cancel <name>`](#pause-resume-cancel) | Stop it for good (asks first) |
| [`retry <name>`](#retry-and-repin) | Go on after a failure or a cancel, or reopen a completed one |
| [`repin <name>`](#retry-and-repin) | Pin the file on disk as its version (asks first) |
| [`dry-run <name>`](#dry-run) | What it would do, on real documents, with nothing written |
| [`unlock <name>`](#unlock) | Clear a stuck coordinator lock and every lease (asks first) |
| [`verify`](#verify) | The drift watch, once |
| [`watch [collection]`](#watch) | The live drift watcher, in the foreground |

Each action takes only its own flags: anything else is refused with `CONFIG_INVALID` (exit 6)
before the command connects.

## status

```bash
migronaut background status
migronaut background status 20261004120000-orders-shipping.js
migronaut background status 20261004120000-orders-shipping.js --partitions
migronaut background status --check
```

```
┌───────────────────────────────────┬─────────┬────────────┬──────────┬──────┬────────────┬───────┬──────────┬─────────────────────────────────────────────┐
│ Background migration              │ Status  │ Collection │ Versions │ Pass │ Partitions │ Lanes │ Migrated │ Note                                        │
├───────────────────────────────────┼─────────┼────────────┼──────────┼──────┼────────────┼───────┼──────────┼─────────────────────────────────────────────┤
│ 20261004120000-orders-shipping.js │ running │ orders     │ 1 → 2    │ 1    │ 9/16       │ 4/4   │ 812400   │                                             │
│ 20261020120000-orders-totals.js   │ blocked │ orders     │ 2 → 3    │ 0    │ —          │ 0/2   │ 0        │ waits for 20261004120000-orders-shipping.js │
└───────────────────────────────────┴─────────┴────────────┴──────────┴──────┴────────────┴───────┴──────────┴─────────────────────────────────────────────┘
```

`Partitions` counts the done ones out of the current plan's. `Lanes` shows the lanes working right
now out of `maxParallel`. `Note` shows what a blocked one waits for, or the last error.

| Option | Description |
|---|---|
| `--partitions` | List the partitions of the latest generation instead: status, scope (the `_id` type of its range, or `@shard` on a sharded collection), migrated, the lease holder (`slot · host:pid`), claims, last error. `--json` gives each one's full scope and counters. Needs a name |
| `--check` | Exit `32` if a background migration failed, else `31` if one is not completed — a CI or readiness gate |

An unknown name is `CONFIG_INVALID` (exit 6). With `--partitions` it is `NOT_APPLIED` (exit 9).

## run

```bash
migronaut background run 20261004120000-orders-shipping.js
migronaut background run 20261004120000-orders-shipping.js --concurrency 4
migronaut background run --all
migronaut background run 20261004120000-orders-shipping.js --once
```

Runs the coordinator and up to `--concurrency` lanes in this process until the background migration
is completed, failed, paused or cancelled, then prints its status. Lanes elsewhere (other shells,
runners, queue workers) keep working alongside: `maxParallel` caps all of them together.

| Option | Description |
|---|---|
| `--concurrency <n>` | Lanes in this process (1–64, default 1). More than the migration's `maxParallel` is cut down to it, with a warning |
| `--all` | Every runnable background migration (`blocked`, `pending`, `running`), one after another, oldest registration first. A blocked one is unblocked when what it requires completed before it |
| `--once` | One round: one coordinator step and one slice per lane, not to the end. Exits `3` if another process is coordinating right now |

Ctrl-C (or SIGTERM) stops the lanes at their next batch. They checkpoint and release their leases,
and a later run goes on from there (exit `11`). Press it again to exit at once (`130` / `143`).

A background migration that is not registered is `CONFIG_INVALID` (exit 6). One that fails is
`BACKGROUND_FAILED` (exit 32).

## pause, resume, cancel

```bash
migronaut background pause 20261004120000-orders-shipping.js --wait --reason "peak traffic"
migronaut background resume 20261004120000-orders-shipping.js
migronaut background cancel 20261004120000-orders-shipping.js --yes
```

- **`pause`**: every lane, wherever it runs, stops at its next batch boundary, checkpoints and
  releases its partition. Every cursor is kept.
- **`resume`**: back to where it was. That is `running` if it was planned, otherwise `pending`, or
  `blocked` while what it requires is not completed.
- **`cancel`**: its open partitions are cancelled. `retry` brings it back. It shows the state and
  asks first.

| Option | Description |
|---|---|
| `--wait` | `pause`, `cancel`: return once no lane holds a lease any more (at most 2 minutes; `--json` then says `stopped: false`) |
| `--reason <text>` | Why. Recorded in the background migration's history |
| `-y, --yes` | `cancel`: do not ask (required with `--json`) |

A control that does not fit the status (pausing a completed one, resuming one that is not paused)
is `BACKGROUND_CONFLICT` (exit 33). One whose result is already in place prints `Nothing to do` and
exits `0`. A name that is not registered is `NOT_APPLIED` (exit 9).

## retry and repin

```bash
migronaut background retry 20261004120000-orders-shipping.js
migronaut background retry 20261004120000-orders-shipping.js --from-start --yes
migronaut background retry 20261004120000-orders-shipping.js --repin
migronaut background repin 20261004120000-orders-shipping.js
```

- **`retry`** on a `failed` or `cancelled` background migration goes on from where it was: its
  failed and cancelled partitions are pending again, in the same pass. On a `completed` one it
  reopens it over whatever old-shape documents are left.
- **`repin`** pins the file now on disk as the background migration's version: its checksum, in the
  changelog too, and its spec. Use it after deliberately changing a registered background
  migration. Until then, coordinators and lanes treat a changed file as a deploy in progress and
  wait. A change to what it matches (`from`, `to`, `filter`, field names), to `maxParallel` or to
  `partitions` plans the pass again. It shows the state and asks first.

| Option | Description |
|---|---|
| `--from-start` | `retry`: plan everything again from pass 0, with a clean list of failed documents (asks first) |
| `--repin` | `retry`: repin the file first |
| `--reason <text>` | Why. Recorded in the history |
| `-y, --yes` | `repin`, `retry --from-start`: do not ask (required with `--json`) |

## dry-run

```bash
migronaut background dry-run 20261004120000-orders-shipping.js                 # 5 random documents
migronaut background dry-run 20261004120000-orders-shipping.js --sample 50
migronaut background dry-run 20261004120000-orders-shipping.js --first 20
migronaut background dry-run 20261004120000-orders-shipping.js --validate
migronaut background dry-run 20261004120000-orders-shipping.js --revert
migronaut background dry-run 20261010120000-archive-events.js --steps 3        # a step migration
```

What a background migration would do, on real documents, with **nothing written**. It works for a
file that is not registered yet, so run it before `up`.

```
✔ {"$oid":"665f1c…"}: {"$set":{"shipping":{"address":"…"},"__v":2},"$unset":{"address":""},"$inc":{"__rev":1}}
✖ {"$oid":"665f1d…"}: address is missing
◎ 4 of 5 would be migrated, 1 would fail
```

- **On a sample**, only the transformation runs: each document before, after, and the update that
  would write it. This works on any server.
- **`--validate`** runs the real write path (the diff, the guarded write, the side writes) inside a
  transaction that is always aborted. It shows what the server would have stored, and what the
  validator or a unique index would have refused. It needs a replica set or a mongos.
- **A step migration** runs `--steps` steps in that same always-aborted transaction. The output
  lists each step's checkpoint in and out, then every operation, all rolled back.

The sandbox lets through only what can run inside that transaction. A call outside its allow-list
is refused and reported, even when the code caught the error. See
[Dry runs](/guide/background-migrations#dry-runs) for the allow-list.

| Option | Description |
|---|---|
| `--sample <n>` | A random sample of n matching documents (1–1000, default 5) |
| `--first <n>` | The first n matching documents by `_id`, instead of a sample (1–1000) |
| `--validate` | Through the real write path, in the always-aborted sandbox |
| `--revert` | The way back (its `revert` or `revertStep`) |
| `--steps <k>` | A step migration: run k steps (1–50, default 1). Refused for a declarative one |
| `--from-start` | A step migration: start from no checkpoint, not the one it is at |
| `--max-docs <n>` | A step migration: document images to keep (1–1000, default 20) |
| `--deadline-ms <ms>` | A step migration: stop the sandbox after this long (at most and by default 50000) |

| Exit | When |
|---|---|
| `0` | It ran, and at least one document would be migrated (or every step ran) |
| `1` | No document would be migrated (none matched, or every one failed), or a step threw or aborted the transaction |
| `15` | `--validate` or a step migration on a standalone server, where there are no transactions |
| `34` | The sandbox refused something (`SANDBOX_REFUSED`) |

## unlock

```bash
migronaut background unlock 20261004120000-orders-shipping.js --yes
```

Clears the background migration's coordinator lock and every partition lease. Use it for a stuck
one, after a crash that left leases behind that you do not want to wait out. A lane that is still
alive is fenced off at its next write. It shows the state and asks first. It never touches the
migration lock: that is [`migronaut unlock`](/commands/unlock).

| Option | Description |
|---|---|
| `-y, --yes` | Do not ask (required with `--json`) |

## verify

```bash
migronaut background verify            # find old-shape documents after completion, reopen
migronaut background verify --report   # only report
```

The [drift watch](/guide/background-migrations#the-poll-verifybackground), once. It runs one
indexed probe per completed background migration, looking for documents of its old shape that
appeared since it completed. What a finding does follows `backgroundOnDrift`: by default the
background migration is reopened.

| Option | Description |
|---|---|
| `--report` | Only report drift, never reopen |

Exits `31` (`BACKGROUND_PENDING`) when it found drift, `0` when it did not. It takes no name.

## watch

```bash
migronaut background watch             # every collection with a completed background migration
migronaut background watch orders      # one collection
migronaut background watch --report    # never upgrade, only say what it sees
```

The [live drift watcher](/guide/background-migrations#the-live-watcher), in the foreground. A
change stream per collection upgrades every old-shape write moments after it lands. Across
processes, one watcher leads each collection, so running this next to a runner or a queue worker
that hosts a watcher is safe: they share the leadership. It prints what happens as it happens:

```
Watching for old-shape writes — Ctrl-C to stop
… orders: catching-up
… orders: streaming
✔ orders: upgraded (20261004120000-orders-shipping.js)
```

Ctrl-C or SIGTERM stops it cleanly. The streams close, their positions are saved, their locks are
released, and it exits `0` with the number of documents upgraded. On a standalone server, which has
no change streams, it is refused with `CONFIG_INVALID` (exit 6).

| Option | Description |
|---|---|
| `--report` | Never upgrade: report old-shape writes only |

## create --background

```bash
migronaut create orders-shipping --background        # → 20261004120000-orders-shipping.js
migronaut create orders-shipping --background --ts
```

Generates a background migration (`export const background = { … }`) instead of `up`/`down` stubs:
`collection`, `from`, `to`, a `migrate` and a `revert` to fill in, and a commented `maxParallel`.
It cannot be combined with `--template`.

## Output

`--json` prints what the action returned:

| Action | JSON |
|---|---|
| `status`, `run` | `{ "background": [ BackgroundStatus, … ] }`, see [Status](/guide/background-migrations#status) |
| `status --partitions` | `{ "partitions": [ … ] }` |
| `pause`, `resume`, `cancel`, `retry` | `{ "applied": "changed" \| "unchanged", "status": "…", "stopped"?: true \| false }` |
| `repin` | `{ "applied", "status", "replan", "checksum" }` |
| `unlock` | `{ "lock": true \| false, "leases": 3 }` |
| `dry-run` | `{ "dryRun": { … } }`: the documents (or steps), and with the sandbox its operations and refusals |
| `verify` | `{ "verify": { "checked", "skipped", "drift": [{ "migration", "collection", "action" }] } }` |
| `watch` | `{ "watch": [{ "collection", "state", "leading", "counters" }] }`, printed once it stops |

Documents in a dry run are relaxed EJSON. No other output carries a document or its `_id`.

## Exit codes

| Code | When |
|---|---|
| `0` | Done, nothing to do, or a confirmation declined |
| `1` | `dry-run`: no document would be migrated, or a step failed |
| `3` | `LOCK_ALREADY_HELD`: `run --once` while another process coordinates it |
| `6` | `CONFIG_INVALID`: an unknown action, a flag the action does not take, a missing name, an unregistered name (`status`, `run`), `--json` without `--yes` where it asks, `watch` on a standalone server |
| `9` | `NOT_APPLIED`: a control (or `status --partitions`) on a background migration that is not registered |
| `11` | `RUN_ABORTED`: `run` stopped by Ctrl-C / SIGTERM (it goes on from there next time) |
| `15` | `TRANSACTIONS_UNSUPPORTED`: `dry-run --validate` or a step dry run on a standalone server |
| `31` | `BACKGROUND_PENDING`: `status --check` found one not completed, or `verify` found drift |
| `32` | `BACKGROUND_FAILED`: `run` ended with it failed, or `status --check` found a failed one |
| `33` | `BACKGROUND_CONFLICT`: a control that does not fit its status |
| `34` | `SANDBOX_REFUSED`: a dry run reached for something the sandbox refuses |
| `130` / `143` | `run`: a second Ctrl-C / SIGTERM |

## Programmatic API

```js
await kit.backgroundStatus(); // every one
await kit.runBackground('20261004120000-orders-shipping.js', { concurrency: 4 });
await kit.pauseBackground('20261004120000-orders-shipping.js', { wait: true, reason: 'peak' });
await kit.dryRunBackground('20261004120000-orders-shipping.js', { sample: 20, validate: true });
await kit.verifyBackground({ onDrift: 'report' });
```

See [Background Migrations](/guide/background-migrations) for the file format, the runtimes and the
rules.
