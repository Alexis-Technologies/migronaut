const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');

const FORMATS = new Set(['js', 'ts', 'json']);

/** Register the `init` command */
function registerInit(program) {
  defineCommand(program, {
    name: 'init',
    description:
      'Create a migronaut config file in the current directory (migronaut.config.js by default)',
    options: [
      ['--format <type>', "Config file format: 'js' (default), 'ts' or 'json'"],
      ['--ts', 'Shorthand for --format ts'],
      ['--js', 'Shorthand for --format js'],
      [
        '--secret-provider',
        'Generate a config that loads the connection from a secret manager (js/ts only)',
      ],
      ['--force', 'Overwrite an existing config file'],
    ],
    // init has no machine-readable output; the deliverable is the file itself.
    jsonOutput: false,
    // Writing a file needs no database — no spinner, no pre-connect.
    spinner: false,
    preflight: (opts) => {
      // `--json` used to mean "generate migronaut.config.json" here — the one
      // command where it did not mean JSON output. Refuse loudly rather than
      // silently reinterpreting a global output flag as a file format.
      if (opts.json) {
        throw new ConfigInvalidError(
          'init has no JSON output — to generate migronaut.config.json, pass --format json',
        );
      }
      if (opts.format !== undefined && !FORMATS.has(opts.format)) {
        throw new ConfigInvalidError("--format must be 'js', 'ts' or 'json'", {
          format: opts.format,
        });
      }
      const format = resolveFormat(opts);
      if (opts.secretProvider && format === 'json') {
        throw new ConfigInvalidError(
          '--secret-provider is only available for js/ts configs (not --format json)',
        );
      }
    },
    run: async (migrator, opts) => {
      await migrator.init({
        format: resolveFormat(opts),
        force: opts.force ?? false,
        ...(opts.secretProvider ? { secretProvider: true } : {}),
      });
    },
  });
}

/** Explicit --format wins; --ts/--js are shorthands; the default is js */
function resolveFormat(opts) {
  if (opts.format !== undefined) return opts.format;
  if (opts.ts) return 'ts';
  return 'js';
}

module.exports = { registerInit };
