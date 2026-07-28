const { ConfigInvalidError } = require('../../errors/index.js');
const { confirm, defineCommand } = require('../shared.js');

/** Register the `up` command */
function registerUp(program) {
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
    ],
    lockable: true,
    mutating: true,
    // Runs before any connection: validation and the confirmation prompt must
    // not cost a round trip, and their errors use the same typed envelope as
    // everything else (CONFIG_INVALID, exit 6).
    preflight: async (opts, [file], { logger }) => {
      if (opts.force && !file) {
        throw new ConfigInvalidError('--force requires a specific migration file');
      }
      if (opts.force && file && !opts.yes) {
        // --json is non-interactive: refuse rather than silently re-running or
        // hanging on a prompt that can't be answered. --yes is the explicit opt-in.
        if (opts.json) {
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
    run: (migrator, opts, [file]) =>
      migrator.up(file, {
        noLock: opts.noLock,
        ...(opts.force ? { force: true } : {}),
        ...(opts.step ? { step: true } : {}),
        ...(opts.to ? { to: opts.to } : {}),
      }),
    // No render: core logs every ✔ Applied line itself.
  });
}

module.exports = { registerUp };
