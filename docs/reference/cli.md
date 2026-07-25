# CLI Cheatsheet

Every command and flag on one page. For details, follow the link on each command.

## Global flags

Available on every command, highest precedence:

| Flag | Description |
|---|---|
| `--uri <uri>` | MongoDB connection URI |
| `--db <name>` | Database name |
| `--dir <path>` | Migrations directory |
| `--config <path>` | Path to a config file (overrides auto-discovery) |
| `--json` | Machine-readable JSON output (on data commands) |

## Running migrations

| Command | Description |
|---|---|
| [`migronaut up`](/commands/up) | Run all pending migrations |
| `migronaut up <file>` | Run a single migration |
| `migronaut up --step` | Apply each file as its own batch |
| `migronaut up <file> --force --yes` | Re-run an already-applied file |
| `migronaut up --strict` | Abort on a checksum mismatch |
| `migronaut up --no-lock` | Skip the lock (dev only) |
| [`migronaut down`](/commands/down) | Roll back the last batch |
| `migronaut down <file>` | Roll back a single migration |
| `migronaut down --batch <n>` | Roll back a specific batch |
| `migronaut down --steps <n>` | Roll back the last N migrations |
| [`migronaut redo`](/commands/redo) | Down + up the last applied migration |
| `migronaut redo <file>` | Down + up a specific migration |

## Inspecting

| Command | Description |
|---|---|
| [`migronaut status`](/commands/status) | Full status table |
| `migronaut status --check` | Exit 1 if any migration is pending (CI gate) |
| `migronaut list --pending` | Only pending migrations |
| `migronaut list --applied` | Only applied migrations |
| [`migronaut dry-run up`](/commands/dry-run) | Preview what would apply |
| `migronaut dry-run down` | Preview what would revert |
| `migronaut dry-run down --steps <n>` | Preview reverting the last N |

## Authoring

| Command | Description |
|---|---|
| [`migronaut create <name>`](/commands/create) | Create a migration (default `.js`) |
| `migronaut create <name> --ts` | Create a `.ts` migration |
| `migronaut create <name> --js` | Create a `.js` migration |
| `migronaut create <name> --template <path>` | Use a custom template |
| [`migronaut init`](/commands/create#migronaut-init) | Generate `migronaut.config.js` |
| `migronaut init --ts` / `--json` | Generate `.ts` / `.json` config |
| `migronaut init --secret-provider` | Generate a secret-manager config |
| `migronaut init --force` | Overwrite an existing config |

## Operations

| Command | Description |
|---|---|
| [`migronaut import`](/commands/import) | Adopt a migrate-mongo changelog |
| `migronaut import --from <c>` / `--to <c>` | Source / target collection |
| `migronaut import --dry-run` | Preview the mapping |
| `migronaut import --trust-hash` | Reuse migrate-mongo's `fileHash` |
| `migronaut import --force` | Import into a non-empty changelog |
| [`migronaut unlock`](/commands/unlock) | Force-release a stuck lock |
| `migronaut unlock --yes` | Release without confirmation |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (or nothing to do) |
| `1` | An error occurred, or `--check` found pending migrations |
