# CI/CD &amp; Deployment

`migronaut` is built for automation: `--json` gives machine-readable output on every data command, and
`migronaut status --check` exits non-zero when migrations are pending. Here are the recipes that tie it
together.

## Run migrations on deploy

The simplest and most common pattern — apply pending migrations as a step in your deploy, before the
app starts:

```bash
migronaut up
```

If it exits non-zero, fail the deploy. The [lock](/guide/concepts#safety-mechanisms) guarantees that
even if two deploy jobs race, only one runs migrations.

## Gate a deploy on a fully-migrated database

Use `--check` to refuse to proceed when migrations are pending:

```bash
migronaut status --check || {
  echo "Database has pending migrations — blocking deploy"
  exit 1
}
```

### …and on collections that match their declarations

With [declared collections](/guide/collections), `converge --check` is the same kind of gate for
indexes and validators — it exits `28` when anything would change, and never writes:

```bash
migronaut converge --check || {
  echo "Indexes or validators differ from their declarations"
  exit 1
}
```

## GitHub Actions

```yaml
# .github/workflows/migrate.yml
name: Migrate
on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx migronaut up
        env:
          MIGRONAUT_URI: ${{ secrets.MONGO_URI }}
          MIGRONAUT_DB: ${{ secrets.MONGO_DB }}
```

Everything is driven by env vars, so no config file or secrets need to live in the repo.

## Docker

In a containerized deploy, run migrations as an init step. Note the host is usually the service name
(`mongo`), not `localhost`:

```dockerfile
# entrypoint.sh
#!/bin/sh
set -e
npx migronaut up          # apply pending migrations, abort on failure
exec node server.js  # then start the app
```

```bash
docker run --rm \
  -e MIGRONAUT_URI="mongodb://mongo:27017" \
  -e MIGRONAUT_DB="my_app" \
  my-app npx migronaut up
```

## Consuming JSON output

Every data command accepts `--json` and prints a single JSON document to **stdout** (human logs and
the spinner go to stderr, so stdout stays clean to pipe):

```bash
migronaut up --json | jq '.[] | select(.status == "error")'
```

```bash
# Count pending migrations from a script
pending=$(migronaut list --pending --json | jq 'length')
echo "$pending migrations pending"
```

On failure, the command prints `{ "error": { "code": "...", "message": "..." } }` and exits
with the code's dedicated [exit code](/reference/cli#exit-codes) (`1` only for unclassified errors).

## Loading the connection from a secret manager

Don't want connection strings in env vars? A function config can fetch them at runtime — no cloud
SDKs are bundled, you bring your own:

```bash
migronaut init --secret-provider   # generates an AWS Secrets Manager template (swap for any provider)
```

See [Configuration → async/factory config](/guide/configuration#async-factory-config-secret-managers).

## Tips

- Pin a Node version in CI (≥ 22.18 — the package's `engines` floor). `.ts` migrations then run with
  no loader; on that same floor `tsx` is only needed for syntax type stripping can't erase.
- Run `migronaut dry-run up` in a pre-deploy check to log exactly what *would* run — and
  `migronaut converge --dry-run` for the declared indexes and validators.
- Converging after migrations? `migronaut up --converge` (or `convergeAfterUp: true`) does both
  under one lock; `migronaut converge --json --yes` applies even drops and rebuilds without a
  prompt, while `--json` alone refuses a plan that would drop or rebuild an index.
- If a job is killed mid-run and leaves a lock, `migronaut unlock --yes` clears it in the next job.
- Running migrations from a long-lived service instead of the pipeline? A deploy hook can enqueue
  them and wait for the result — see [Migrations as a Queue](/guide/bullmq#enqueue-and-wait-deploy-hooks-and-ci).
