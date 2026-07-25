# migronaut create &amp; migronaut init

Author new migration files and generate a config.

## migronaut create

Create a new, timestamped migration file with `up`/`down` stubs.

```bash
migronaut create <name> [options]
```

```bash
migronaut create add-users-index            # → 20260605143021-add-users-index.js
migronaut create add-users-index --ts       # force a .ts file
migronaut create add-users-index --js       # force a .js file
migronaut create add-users-index --template ./my-template.ts
```

### File type resolution

The generated extension is resolved as: `--js` / `--ts` flag → `createExtension` config / env →
built-in default (`js`).

| Option | Description |
|---|---|
| `<name>` | Migration name; slugified into the filename after the timestamp prefix. |
| `--ts` | Generate a `.ts` migration (overrides config). |
| `--js` | Generate a `.js` migration (overrides config). |
| `--template <path>` | Use a custom template file instead of the built-in stub. |
| `--json` | Emit the created file path as JSON. |

::: tip
`migronaut create` never connects to the database, so it needs no `uri`/`db`.
:::

## migronaut init

Generate a fully-commented config file in the current directory.

```bash
migronaut init [options]
```

```bash
migronaut init                     # → migronaut.config.js (default)
migronaut init --ts                # → migronaut.config.ts
migronaut init --json              # → migronaut.config.json
migronaut init --secret-provider   # → a runtime secret-loading config (js/ts only)
migronaut init --force             # overwrite an existing config file
```

### Options

| Option | Description |
|---|---|
| `--ts` | Create `migronaut.config.ts`. |
| `--js` | Create `migronaut.config.js` (the explicit default). |
| `--json` | Create `migronaut.config.json` (omits code-only options like `hooks`). |
| `--secret-provider` | Generate a factory-function config wired to a secret manager (AWS example, provider-agnostic). `--json --secret-provider` is rejected. |
| `--force` | Overwrite an existing config file (otherwise exits 1 with `CONFIG_FILE_EXISTS`). |

The generated JS/TS templates document every option inline, including a commented `hooks` block. The
`--uri` / `--db` / `--dir` global flags pre-fill the generated file.

See [Configuration](/guide/configuration) for what each option does.
