const OPTION_PATTERN = /^(?:-([A-Za-z]), )?--([a-z][a-z0-9-]*)(?: <([^>]+)>)?$/;

/** Convert a kebab-case option name to its camelCase opts key */
const camelize = (name) => name.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());

/** Pad `label` so descriptions in a help block line up */
const padLabel = (label, width) => label + ' '.repeat(width - label.length);

/** Render one aligned `label  description` section of a help screen */
function renderSection(title, rows) {
  if (rows.length === 0) return [];
  let width = 0;
  for (const row of rows) {
    if (row[0].length > width) width = row[0].length;
  }
  const lines = [];
  for (const row of rows) {
    lines.push(`  ${padLabel(row[0], width)}  ${row[1]}`);
  }
  return ['', `${title}:`, ...lines];
}

/**
 * Minimal commander-compatible CLI framework covering exactly the surface the
 * migronaut commands use: one level of subcommands, boolean/value/negatable
 * (`--no-x`) options with camelCase keys and optional short aliases, required
 * `<x>` / optional `[x]` positional arguments, `optsWithGlobals()`, and
 * generated `--help` / `--version`. Global (root) options are recognized both
 * before and after the subcommand name. Parse errors are written to stderr
 * and set `process.exitCode = 1` — `process.exit()` is never called.
 *
 * Deliberately unsupported (unused by migronaut): combined short flags
 * (`-fy`), variadic arguments, option defaults other than negatable `true`.
 */
class Command {
  #name = '';
  #description = '';
  #version = null;
  #options = [];
  #arguments = [];
  #commands = [];
  #actionFn = null;
  #parent = null;
  #values = {};
  /** Lazily-built `--long`/`-s` → option lookup; reset whenever options change */
  #optionIndex = null;

  name(value) {
    this.#name = value;
    return this;
  }

  description(value) {
    this.#description = value;
    return this;
  }

  version(value) {
    this.#version = value;
    return this;
  }

  option(flags, description = '') {
    const match = OPTION_PATTERN.exec(flags);
    if (!match) throw new TypeError(`Unsupported option flags: '${flags}'`);
    const short = match[1] ?? null;
    const rawName = match[2];
    const negated = rawName.startsWith('no-');
    this.#options.push({
      flags,
      description,
      short,
      long: `--${rawName}`,
      key: camelize(negated ? rawName.slice(3) : rawName),
      negated,
      takesValue: Boolean(match[3]),
    });
    this.#optionIndex = null;
    return this;
  }

  argument(spec, description = '') {
    this.#arguments.push({
      name: spec.slice(1, -1),
      required: spec.startsWith('<'),
      description,
    });
    return this;
  }

  command(name) {
    const sub = new Command();
    sub.#name = name;
    sub.#parent = this;
    this.#commands.push(sub);
    return sub;
  }

  action(fn) {
    this.#actionFn = fn;
    return this;
  }

  opts() {
    return this.#values;
  }

  optsWithGlobals() {
    const globals = this.#parent ? this.#parent.#values : {};
    return { ...globals, ...this.#values };
  }

  /** Parse argv (including the node + script tokens) and run the matching action */
  async parseAsync(argv) {
    const tokens = argv.slice(2);
    this.#values = {};
    this.#seedNegatableDefaults();

    let command = null;
    const positionals = [];
    // After a bare `--`, everything is a positional — the standard
    // end-of-options terminator.
    let optionsEnded = false;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (optionsEnded) {
        positionals.push(token);
        continue;
      }
      if (token === '--') {
        optionsEnded = true;
        continue;
      }
      if (token === '-h' || token === '--help') {
        // Short-circuit, commander-style: the user asking for help must get
        // it even when a later token would fail the parse — mistyping a flag
        // and appending --help to find out what went wrong is the exact case.
        process.stdout.write(`${this.#helpText(command ?? this)}\n`);
        return;
      }
      if ((token === '-V' || token === '--version') && this.#version !== null) {
        process.stdout.write(`${this.#version}\n`);
        return;
      }
      if (token.startsWith('-') && token !== '-') {
        let name = token;
        let inlineValue;
        const separator = token.indexOf('=');
        if (token.startsWith('--') && separator !== -1) {
          name = token.slice(0, separator);
          inlineValue = token.slice(separator + 1);
        }
        const found = this.#findOption(command, name);
        if (!found) return this.#fail(`unknown option '${name}'`);
        const { owner, option } = found;
        if (option.takesValue) {
          let value = inlineValue;
          if (value === undefined) {
            const next = tokens[i + 1];
            // A leading digit after `-` is a negative number, not a flag —
            // `--steps -1` should reach the core validator (which rejects it
            // with an actionable message), not die as "argument missing".
            const negativeNumber = next !== undefined && /^-\d/.test(next);
            if (next === undefined || (next.startsWith('-') && next !== '-' && !negativeNumber)) {
              return this.#fail(
                `option '${option.flags}' argument missing ` +
                  `(use ${option.long}=<value> for values starting with '-')`,
              );
            }
            value = next;
            i++;
          }
          owner.#values[option.key] = value;
        } else {
          owner.#values[option.key] = !option.negated;
        }
        continue;
      }
      if (command === null) {
        let sub = null;
        for (const candidate of this.#commands) {
          if (candidate.#name === token) {
            sub = candidate;
            break;
          }
        }
        if (!sub) return this.#fail(`unknown command '${token}'`);
        command = sub;
        command.#values = {};
        command.#seedNegatableDefaults();
        continue;
      }
      positionals.push(token);
    }

    if (command === null) {
      process.stderr.write(`${this.#helpText(this)}\n`);
      process.exitCode = 1;
      return;
    }

    const args = [];
    for (let i = 0; i < command.#arguments.length; i++) {
      const spec = command.#arguments[i];
      const value = positionals[i];
      if (value === undefined && spec.required) {
        return this.#fail(`missing required argument '${spec.name}'`);
      }
      args.push(value);
    }
    // Extra positionals are almost always a mistake (`up a.js b.js` would
    // silently run only a.js); commander errors here, and so do we.
    if (positionals.length > command.#arguments.length) {
      const extra = positionals.slice(command.#arguments.length);
      return this.#fail(`too many arguments — unexpected: ${extra.join(', ')}`);
    }

    if (command.#actionFn) {
      await command.#actionFn(...args, command.#values, command);
    }
  }

  /** Seed negatable options: declaring `--no-x` makes `x` default to true */
  #seedNegatableDefaults() {
    for (const option of this.#options) {
      if (option.negated) this.#values[option.key] = true;
    }
  }

  /** The `--long`/`-s` → option map for this command, built once per option set */
  #lookupIndex() {
    if (this.#optionIndex === null) {
      const index = new Map();
      for (const option of this.#options) {
        index.set(option.long, option);
        if (option.short !== null) index.set(`-${option.short}`, option);
      }
      this.#optionIndex = index;
    }
    return this.#optionIndex;
  }

  /** Resolve an option token against the active command first, then the root */
  #findOption(command, token) {
    const lookup = (owner) => {
      if (owner === null) return null;
      const option = owner.#lookupIndex().get(token);
      return option ? { owner, option } : null;
    };
    return lookup(command) ?? lookup(this);
  }

  #fail(message) {
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }

  /** Usage suffix for a command's positional arguments, e.g. ` <direction> [file]` */
  #argsUsage(command) {
    let usage = '';
    for (const spec of command.#arguments) {
      usage += spec.required ? ` <${spec.name}>` : ` [${spec.name}]`;
    }
    return usage;
  }

  #helpText(target) {
    const isRoot = target === this;
    const usage = isRoot
      ? `Usage: ${this.#name} [options] [command]`
      : `Usage: ${this.#name} ${target.#name} [options]${this.#argsUsage(target)}`;
    const lines = [usage];
    if (target.#description) lines.push('', target.#description);

    const argumentRows = [];
    for (const spec of target.#arguments) {
      argumentRows.push([spec.name, spec.description]);
    }
    lines.push(...renderSection('Arguments', argumentRows));

    const optionRows = [];
    for (const option of target.#options) {
      optionRows.push([option.flags, option.description]);
    }
    if (isRoot && this.#version !== null) {
      optionRows.push(['-V, --version', 'output the version number']);
    }
    optionRows.push(['-h, --help', 'display help for command']);
    lines.push(...renderSection('Options', optionRows));

    // Subcommand help also lists the root's flags: they are accepted after the
    // command name, so hiding them here would misdocument the real surface.
    if (!isRoot) {
      const globalRows = [];
      for (const option of this.#options) {
        globalRows.push([option.flags, option.description]);
      }
      lines.push(...renderSection('Global Options', globalRows));
    }

    if (isRoot) {
      const commandRows = [];
      for (const sub of this.#commands) {
        const options = sub.#options.length > 0 ? ' [options]' : '';
        commandRows.push([`${sub.#name}${options}${this.#argsUsage(sub)}`, sub.#description]);
      }
      lines.push(...renderSection('Commands', commandRows));
    }
    return lines.join('\n');
  }
}

module.exports = { Command };
