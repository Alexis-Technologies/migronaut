const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');

/** Tri-state: an explicit flag wins; otherwise undefined, so the config decides */
const jsFlag = (opts) => {
  if (opts.ts) return false;
  if (opts.js) return true;
  return undefined;
};

/** Register the `create` command */
const registerCreate = (program) => {
  defineCommand(program, {
    name: 'create',
    description: 'Create a new migration file',
    args: [['<name>', 'Migration name (will be slugified)']],
    options: [
      ['--js', 'Force a .js file (overrides config createExtension)'],
      ['--ts', 'Force a .ts file (overrides config createExtension)'],
      ['--template <path>', 'Use a custom template file'],
      ['--background', 'Create a background migration (export const background)'],
    ],
    // Writing a file needs no database — no spinner, no pre-connect.
    spinner: false,
    run: async (migrator, opts, positionals) => {
      const name = positionals[0];
      const js = jsFlag(opts);
      if (opts.background && opts.template) {
        throw new ConfigInvalidError('--background and --template cannot be combined');
      }
      const path = await migrator.create(name, {
        ...(js !== undefined ? { js } : {}),
        ...(opts.template ? { template: opts.template } : {}),
        ...(opts.background ? { background: true } : {}),
      });
      return { path };
    },
    // No render: core already logs "✔ Created …" itself.
  });
};

module.exports = { registerCreate };
