const { ConfigInvalidError } = require('../../errors/index.js');
const { confirm, defineCommand } = require('../shared.js');

const registerUp = (program) => {
  defineCommand(program, {
    name: 'up',
    description: 'Run all pending migrations, or a single named file',
    args: [['[file]', 'Specific migration file to run']],
    options: [
      ['--to <file>', 'Apply pending migrations up to and including this file'],
      ['--strict', 'Abort on checksum mismatch'],
      ['-f, --force', 'Re-run an already-applied migration (requires a file)'],
      ['-y, --yes', 'Confirm --force non-interactively (required with --json)'],
      ['--step', 'Apply each migration as its own batch (revert individually later)'],
      ['--converge', 'Converge the declared collections afterwards (overrides convergeAfterUp)'],
      ['--no-converge', 'Do not converge afterwards, whatever convergeAfterUp says'],
      ['--reason <text>', 'Why — recorded on the changelog with the run (who: the OS user)'],
    ],
    lockable: true,
    mutating: true,
    // Runs before any connection: validation and the confirmation prompt must
    // not cost a round trip, and their errors use the same typed envelope as
    // everything else (ALX_ERR_CONFIG_INVALID, exit 6).
    preflight: async (flags, positionals, { logger }) => {
      const file = positionals[0];
      if (flags.force && !file) {
        throw new ConfigInvalidError('--force requires a specific migration file');
      }
      if (flags.converge === true && (file || flags.to)) {
        throw new ConfigInvalidError(
          '--converge needs a bulk up — it cannot follow a single file or --to',
        );
      }
      if (flags.force && file && !flags.yes) {
        // --json is non-interactive: refuse rather than silently re-running or
        // hanging on a prompt that can't be answered. --yes is the explicit opt-in.
        if (flags.json) {
          throw new ConfigInvalidError(
            '--force needs confirmation — pass --yes to confirm in --json mode',
          );
        }
        const proceed = await confirm(`are you sure you want to re-run "${file}"? [y/N] `);
        if (!proceed) {
          logger.info('Aborted');
          return false;
        }
      }
      return undefined;
    },
    run: (migrator, flags, positionals) => {
      return migrator.up(positionals[0], {
        noLock: flags.noLock,
        ...(flags.force ? { force: true } : {}),
        ...(flags.step ? { step: true } : {}),
        ...(flags.to ? { to: flags.to } : {}),
        ...(typeof flags.converge === 'boolean' ? { converge: flags.converge } : {}),
        ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
      });
    },
    // No render: core logs every ✔ Applied line itself — and, after a bulk run
    // that converges, every converge line too. `--json` stays the migration
    // rows: an array cannot carry the converge result without breaking its
    // consumers (that is what `migronaut converge --json` is for).
  });
};

module.exports = { registerUp };
