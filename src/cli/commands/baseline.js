const { ConfigInvalidError } = require('../../errors/index.js');
const { confirm, defineCommand } = require('../shared.js');

const registerBaseline = (program) => {
  defineCommand(program, {
    name: 'baseline',
    description: 'Mark existing migration files as applied without running them',
    options: [
      ['--to <file>', 'Baseline pending files up to and including this one'],
      ['-y, --yes', 'Skip the confirmation prompt (required with --json)'],
    ],
    lockable: true,
    mutating: true,
    // Confirmation before any connection: baselining rewrites what the
    // changelog claims is applied, which is exactly as consequential as a
    // forced re-run — and --json is non-interactive, so it needs an explicit
    // --yes rather than a prompt that can never be answered.
    preflight: async (flags, _positionals, { logger }) => {
      if (!flags.yes) {
        if (flags.json) {
          throw new ConfigInvalidError(
            'baseline needs confirmation — pass --yes to confirm in --json mode',
          );
        }
        const proceed = await confirm(
          'Mark pending migration files as applied WITHOUT running them? [y/N] ',
        );
        if (!proceed) {
          logger.info('Aborted');
          return false;
        }
      }
      return undefined;
    },
    run: (migrator, flags) => {
      return migrator.baseline({
        noLock: flags.noLock,
        ...(flags.to ? { to: flags.to } : {}),
      });
    },
    // No render: core logs the ✔ Baselined summary itself.
  });
};

module.exports = { registerBaseline };
