const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');

/** Tri-state: an explicit flag wins; otherwise undefined, so the config decides */
const readJsFlag = (flags) => {
  if (flags.ts) return false;
  if (flags.js) return true;
  return undefined;
};

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
    run: async (migrator, flags, positionals) => {
      const name = positionals[0];
      const js = readJsFlag(flags);
      if (flags.background && flags.template) {
        throw new ConfigInvalidError('--background and --template cannot be combined');
      }
      const path = await migrator.create(name, {
        ...(js !== undefined ? { js } : {}),
        ...(flags.template ? { template: flags.template } : {}),
        ...(flags.background ? { background: true } : {}),
      });
      return { path };
    },
    // No render: core already logs "✔ Created …" itself.
  });
};

module.exports = { registerCreate };
