const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');

/** Register the `init` command */
function registerInit(program) {
  defineCommand(program, {
    name: 'init',
    description:
      'Create a migronaut config file in the current directory (migronaut.config.js by default)',
    options: [
      ['--ts', 'Generate migronaut.config.ts instead of migronaut.config.js'],
      ['--json', 'Generate migronaut.config.json instead of migronaut.config.js'],
      ['--js', 'Generate migronaut.config.js (the default)'],
      [
        '--secret-provider',
        'Generate a config that loads the connection from a secret manager (js/ts only)',
      ],
      ['--force', 'Overwrite an existing config file'],
    ],
    // On `init`, `--json` selects the config FILE FORMAT, not the output mode.
    jsonOutput: false,
    // Writing a file needs no database — no spinner, no pre-connect.
    spinner: false,
    preflight: (opts) => {
      if (opts.secretProvider && opts.json) {
        throw new ConfigInvalidError(
          '--secret-provider is only available for js/ts configs (not --json)',
        );
      }
    },
    run: async (migrator, opts) => {
      const format = opts.json ? 'json' : opts.ts ? 'ts' : 'js';
      await migrator.init({
        format,
        force: opts.force ?? false,
        ...(opts.secretProvider ? { secretProvider: true } : {}),
      });
    },
  });
}

module.exports = { registerInit };
