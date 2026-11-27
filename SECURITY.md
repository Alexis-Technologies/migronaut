# Security Policy

## Supported versions

Only the latest published version receives fixes.

| Version | Supported |
|---|---|
| 2.5.x | ✅ |
| < 2.5 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/Alexis-Technologies/migronaut/security/advisories/new),
or by email to <dolid.sasha@gmail.com>.

Include, as far as you can:

- what an attacker can do, and what they need in order to do it;
- the affected version and Node.js version;
- a minimal reproduction.

You can expect an acknowledgement within a few days and an assessment of
severity and a fix timeline once the report is confirmed.

## Threat model

Some things are working as intended, and are not vulnerabilities:

- **Config and migration files execute.** `migronaut.config.{ts,js}` and every
  migration file are `import()`ed and run. Running migronaut inside an untrusted
  checkout executes that checkout's code, exactly as `eslint`, `vite` or `jest`
  would. Do not run it against a repository you have not reviewed. The same
  applies to `--config <path>` and to a `.env` file in the working directory:
  both are trusted input, same as any `node -r` — migration *names* get a
  path-traversal guard, but the config file you point at is yours to vet.
- **Checksums detect drift, not tampering.** The SHA-256 recorded for each
  applied migration catches a file edited after the fact. It is not a signature:
  anyone who can write to the changelog collection can also rewrite the
  checksum. Protect the database, not just the files.
- **`--no-lock` is unsafe by design.** It exists for local development and says
  so loudly at run time.
- **Whoever can enqueue can migrate.** With the queue adapter
  (`@alexify/migronaut/bullmq`), write access to the Redis queue — or to the API
  you put in front of it — is the ability to apply and roll back migrations
  *that exist in the worker's migrations directory*. Protect both as you would
  the deploy pipeline. What a job can never do is name a file outside that
  directory (or a file next to the migrations that is not one) or carry code:
  payloads are validated as untrusted data, and a job that fails the check is
  rejected (`ALX_ERR_QUEUE_JOB_INVALID`) before anything runs. A job also cannot
  re-run an applied migration (`force`) or skip the order guard unless the
  worker's `allow` option says so — both are off by default.

- **A duplicate-key error quotes the duplicate value, and not every channel masks it.**
  MongoDB's E11000 message ends with the offending key's values — `dup key: { email:
  "a@example.com" }`. Migronaut masks them wherever text leaves the process for a third party or
  is kept about the application's data: a background migration's state and document errors, queue
  jobs (`failedReason`, log rows, return values), span status messages, and `migration:log`. It
  leaves them **as they are** in an ordinary migration's own failure: the error it throws, the
  `✖ Error` log line, the `migration:error` and `run:end` events, `--json` rows, and the `failed`
  trace in the changelog — that is what the author debugs a failing migration with. Connection
  credentials are masked in all of them. If those values are sensitive for you, mask them where
  you forward the events (`redactOutbound`-style: everything from `dup key: {` to the end of the
  line), and treat the changelog collection as holding them.

Things that *are* in scope: leaking connection credentials into output, files,
error context or queue jobs; executing code from a source that should be data (a migration
*name*, a database value, a CLI flag); escaping the migrations directory; and
anything that lets one run corrupt another's changelog.

## Handling credentials

- Prefer `MIGRONAUT_URI` or a gitignored `.env` over a committed config file.
  `migronaut init` masks any password it is given and says so.
- For a secret manager, use `migronaut init --secret-provider`: the config
  exports a function, so the connection is fetched at run time and never written
  to disk.
- migronaut never prints the connection URI. If you ever see one in its output,
  that is a bug worth reporting.
