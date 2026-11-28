# src/cli — the command line (`migronaut`)

`bin/migronaut.js` → `index.js`, one file per command under `commands/`, the parser `args.js`, the
spinner, the table and `shared.js` (the run around a command).

## Presentation only

- The CLI never touches the database and holds no migration logic: it builds a partial config
  from its flags (`toPartialConfig`), drives a kit through `withMigrator`, and injects a
  `ProgressReporter`. A command reads its flags as `flags`, and the run hands it
  `{ logger, json, flags, spinner, stopRequested }`.
- It writes to `process.stdout` / `stderr`, never `console.*` (`no-console` and a unit test).
  `args.js` throws a `TypeError` for a malformed flag definition — a bug in migronaut's own
  command table, the one sanctioned non-migronaut throw besides the scaffold text.

## An app around the library

- The library never installs `process.on(...)` or calls `process.exit()`; the CLI may.
  `attachSignalHandlers` (`shared.js`) turns the first SIGINT/SIGTERM into `kit.stop()` and a
  second one exits 130/143. An error that escapes every handler (`bin/migronaut.js`) stops the
  runs in flight (`stopActiveMigrators`) and exits 1, after a bounded drain for an uncaught one.
- Otherwise the CLI sets `process.exitCode` from `EXIT_CODES[error.code] ?? 1` and lets the
  process drain: `process.exit()` would truncate piped output. A closed pipe (`EPIPE`) after what
  fit was printed is success.
- `EXIT_CODES` is frozen, with no prototype. An exit number is never renumbered; a new code takes
  the next free one. A command line that does not parse exits 6 (`onUsageError`), and
  `--flag=value` on a flag that takes none is refused; `args.js` on its own still exits 1.
- **Kept on purpose (graceful-shutdown):** no hard deadline after the first signal — it would cut
  a migration body short, which is what leaves a database half-migrated; the second signal is the
  operator's way out. A run stopped by a signal exits with `ALX_ERR_RUN_ABORTED`'s 11, not the 0 of
  a clean shutdown: a script must tell a stopped run from a finished one. The exit codes 7 and 13
  coincide with Node's own, and exit codes are never renumbered.

## Behaviour that looks like a bug but is not

- `init` has no JSON output: `init --format json` writes `migronaut.config.json`, and a stray
  `init --json` is refused with a pointer to `--format`.
- `converge` and `unlock` confirm _after_ planning, inside the run.

## Kept on purpose here

- `delete process.env[…]` in `index.js`: assigning `undefined` stores the string `'undefined'`.
- `args.js` hands a command its positionals (at most the two it declares) as a rest spread, the
  commander way; its `opts()` is commander's name.
- `table.js` counts wide characters (CJK, emoji) as two columns; there are no combined short flags
  (`-fy`).
