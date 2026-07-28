# migronaut audit

Check the setup before you need it to work. Read-only diagnostics — `audit` reports, it never fixes.

```bash
migronaut audit [options]
```

## Why it exists

Most migration failures aren't the migration's fault: `useTransaction` is on against a standalone
server, a crashed run left a stale lock, the URI points at the wrong database, or Node is too old to
import the `.ts` files in `migrations/`. Each of those surfaces as a driver error mid-deploy, when
you can least afford to debug it.

`migronaut audit` answers them all in one command, in a few hundred milliseconds, without applying
anything.

## Usage

```bash
migronaut audit          # human-readable checklist
migronaut audit --json   # machine-readable report for CI
```

```
✔ config       Loaded (database "my_app")
✔ connection   Connected
✔ transactions Replica set "rs0"
✔ indexes      All changelog indexes present
✔ lock         No lock held
✔ checksums    No drift among applied migrations
! pending      2 pending migration(s)
✔ runtime      Node 22.18.0

No problems found (1 warning(s))
```

## What it checks

| Check | Passes when | Notable failures |
|---|---|---|
| `config` | The config file and flags resolve and validate | Fatal — the rest is skipped |
| `connection` | MongoDB is reachable with these credentials | Fatal — the rest is skipped |
| `transactions` | The server is a replica set or sharded cluster | **Fails** if `useTransaction` is on against a standalone; warns otherwise |
| `indexes` | All three changelog indexes exist | Warns — a missing index costs speed, not correctness |
| `lock` | No lock, or a lock that's still within its TTL | Warns when a lock is past its TTL — likely a crashed run |
| `checksums` | No applied migration was edited afterwards | **Fails**, and names each drifted file |
| `pending` | Nothing is waiting to be applied | Warns with the count |
| `runtime` | Node can load your migration files | Warns when `.ts` files need Node ≥ 22.18 or a loader |

`config` and `connection` are fatal because everything after them depends on a live database. Every
other check is independent: one failing doesn't stop the others from running.

## Options

| Option | Description |
|---|---|
| `--json` | Emit the full `AuditReport` as JSON on stdout. |

Plus the [global flags](/guide/configuration#global-cli-flags): `--uri`, `--db`, `--dir`, `--config`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No check **failed**. Warnings do not change this. |
| `1` | At least one check failed. |

Warnings are advisory by design — a pending migration or a missing index is normal at some point in
every project's life, and shouldn't break a pipeline. Only a genuine misconfiguration exits non-zero.

## In CI

Run it before `up` so a broken environment fails fast, with a message that says what's wrong:

```yaml
- run: npx migronaut audit
- run: npx migronaut up
```

Or inspect the report yourself:

```bash
migronaut audit --json | jq -r '.checks[] | select(.status != "pass") | "\(.name): \(.detail)"'
```

## Programmatic API

```ts
import { MigratorKit } from '@alexify/migronaut';

const migrator = new MigratorKit({ uri, dbName: 'my_app' });
const report = await migrator.audit();   // → AuditReport

if (!report.ok) {
  for (const check of report.checks.filter((c) => c.status === 'fail')) {
    console.error(`${check.name}: ${check.detail}`);
  }
}
await migrator.disconnect();
```

`audit()` connects on its own and records a connection failure as a check rather than throwing, so it
stays useful precisely when things are broken.

## See also

- [`migronaut lock`](/commands/lock) — inspect just the lock
- [`migronaut status`](/commands/status) — the full applied/pending table
- [Troubleshooting](/guide/troubleshooting) — what to do about each finding
