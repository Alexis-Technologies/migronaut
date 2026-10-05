const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');

/** Register the `create` command */
function registerCreate(program) {
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
    run: async (migrator, opts, [name]) => {
      // Tri-state: explicit flag wins; otherwise leave undefined so config decides.
      const js = opts.ts ? false : opts.js ? true : undefined;
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
}

module.exports = { registerCreate };
