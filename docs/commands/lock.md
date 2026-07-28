# migronaut lock

Show who holds the migration lock, if anyone. Read-only — it never acquires or releases anything.

```bash
migronaut lock [options]
```

## Why it exists

When a deploy hangs on `LockAlreadyHeldError`, the first question is always *which process holds it,
and is that process still alive?* [`migronaut unlock`](/commands/unlock) shows the holder too, but it
does so on the way to releasing it — which is not what you want while you're still deciding.

`migronaut lock` is the read-only half: look first, act second.

## Usage

```bash
migronaut lock          # human-readable
migronaut lock --json   # machine-readable { held, holder }
```

```
Lock held by pid 48213 on deploy-runner-7 (ci) since 2026-06-05T12:01:33.412Z
```

When nothing holds it:

```
No migration lock is currently held
```

## Options

| Option | Description |
|---|---|
| `--json` | Emit `{ held, holder }` as JSON. `holder` is `null` when no lock is held. |

Plus the [global flags](/guide/configuration#global-cli-flags): `--uri`, `--db`, `--dir`, `--config`.

## Reading the output

```json
{
  "held": true,
  "holder": {
    "lockedAt": "2026-06-05T12:01:33.412Z",
    "pid": 48213,
    "host": "deploy-runner-7",
    "executedBy": "ci"
  }
}
```

`lockedAt` is the last time the lock was acquired **or renewed** — a healthy long migration refreshes
it on a heartbeat every `lockTTLSeconds / 2`. So an old `lockedAt` is the signal to look for: it means
nothing has renewed the lock, and the holder is probably gone.

The holder view is deliberately limited to these four fields. The internal owner token is never
exposed, so this output is safe to paste into an incident channel.

::: tip Deciding what to do
- `lockedAt` **within** `lockTTLSeconds` → a run is genuinely in progress. Wait.
- `lockedAt` **older** than `lockTTLSeconds` → the lock is stale and will expire on its own; run
  [`migronaut unlock`](/commands/unlock) to clear it now.
:::

## Programmatic API

```ts
const info = await migrator.lockInfo();   // → LockInfo | null
if (info) {
  console.log(`Held by pid ${info.pid} since ${info.lockedAt.toISOString()}`);
}
```

## See also

- [`migronaut unlock`](/commands/unlock) — force-release a stale lock
- [`migronaut audit`](/commands/audit) — includes the lock among its checks, and flags a stale one
